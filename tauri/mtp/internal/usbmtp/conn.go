//go:build cgo

package usbmtp

import (
	"errors"
	"fmt"
	"io"
	"log"
	"strings"
	"time"

	"github.com/ganeshrvel/go-mtpfs/mtp"
	"github.com/ganeshrvel/usb"

	"copiteur-mtp/internal/core"
)

// Delais USB (ms). 15 s comme Kalam/OpenMTP ; les operations qui peuvent
// etre longues cote telephone (suppression d'un gros dossier, copie, fin
// d'ecriture d'un gros fichier, souvent lente sur Samsung) ont plus.
const (
	timeoutOpen    = 15000 // comme Kalam
	timeoutClose   = 5000
	timeoutNormal  = 15000
	timeoutSamsung = 30000
	timeoutLong    = 120000
)

const vendorSamsung = 0x04e8

// rawObjectInfo : meme disposition que mtp.ObjectInfo, mais les dates sont
// lues comme des chaines. Le decodeur d'origine echoue (et fait echouer
// tout GetObjectInfo) sur une date qu'il ne sait pas lire.
type rawObjectInfo struct {
	StorageID           uint32
	ObjectFormat        uint16
	ProtectionStatus    uint16
	CompressedSize      uint32
	ThumbFormat         uint16
	ThumbCompressedSize uint32
	ThumbPixWidth       uint32
	ThumbPixHeight      uint32
	ImagePixWidth       uint32
	ImagePixHeight      uint32
	ImageBitDepth       uint32
	ParentObject        uint32
	AssociationType     uint16
	AssociationDesc     uint32
	SequenceNumber      uint32
	Filename            string
	CaptureDate         string
	ModificationDate    string
	Keywords            string
}

// parseMTPDate lit une date MTP ("YYYYMMDDThhmmss[.s][Z|+hhmm]").
// Android l'envoie en heure locale sans fuseau : on l'interprete dans le
// fuseau du Mac. Zero si illisible.
func parseMTPDate(s string) time.Time {
	s = strings.TrimSpace(s)
	if len(s) < 15 {
		return time.Time{}
	}
	base := s[:15]
	rest := s[15:]
	if i := strings.IndexByte(rest, '.'); i == 0 {
		// dixiemes de seconde (et points finaux Samsung)
		j := 1
		for j < len(rest) && (rest[j] >= '0' && rest[j] <= '9' || rest[j] == '.') {
			j++
		}
		rest = rest[j:]
	}
	loc := time.Local
	switch {
	case rest == "Z":
		loc = time.UTC
	case len(rest) == 5 && (rest[0] == '+' || rest[0] == '-'):
		if t, err := time.Parse("20060102T150405-0700", base+rest); err == nil {
			return t
		}
	}
	t, err := time.ParseInLocation("20060102T150405", base, loc)
	if err != nil {
		return time.Time{}
	}
	return t
}

// usbConn implemente core.Conn sur un transport USB.
type usbConn struct {
	t       *transport
	ops     map[uint16]bool
	timeout int
}

func newConn(t *transport, info *mtp.DeviceInfo) *usbConn {
	c := &usbConn{t: t, ops: map[uint16]bool{}, timeout: timeoutNormal}
	for _, op := range info.OperationsSupported {
		c.ops[op] = true
	}
	if t.c.devDescr.IdVendor == vendorSamsung {
		c.timeout = timeoutSamsung
	}
	t.Timeout = c.timeout
	return c
}

// mapErr traduit une erreur du transport en erreur core.
func (c *usbConn) mapErr(err error) error {
	if err == nil {
		return nil
	}
	var ue usb.Error
	var se mtp.SyncError
	if errors.As(err, &ue) || errors.As(err, &se) || errors.Is(err, errClosed) || c.t.h == nil {
		return fmt.Errorf("%w: %v", core.ErrGone, err)
	}
	var rc mtp.RCError
	if errors.As(err, &rc) {
		switch rc {
		case mtp.RC_InvalidObjectHandle, mtp.RC_InvalidStorageId, mtp.RC_InvalidParentObject:
			return fmt.Errorf("%w: %v", core.ErrNotFound, err)
		case mtp.RC_StoreFull:
			return fmt.Errorf("%w: %v", core.ErrStoreFull, err)
		case mtp.RC_ObjectWriteProtected, mtp.RC_StoreReadOnly, mtp.RC_AccessDenied:
			return fmt.Errorf("%w: %v", core.ErrReadOnly, err)
		case mtp.RC_OperationNotSupported, mtp.RC_ParameterNotSupported, mtp.RC_SpecificationByFormatUnsupported:
			return fmt.Errorf("%w: %v", core.ErrNotSupported, err)
		case mtp.RC_DeviceBusy, mtp.RC_StoreNotAvailable:
			return fmt.Errorf("%w: %v", core.ErrBusy, err)
		case mtp.RC_SessionNotOpen, mtp.RC_InvalidTransactionID:
			return fmt.Errorf("%w: %v", core.ErrGone, err)
		}
		return fmt.Errorf("MTP: %v", err)
	}
	return err
}

func (c *usbConn) long() func() {
	c.t.Timeout = timeoutLong
	return func() { c.t.Timeout = c.timeout }
}

// Storages implemente core.Conn.
func (c *usbConn) Storages() ([]core.Storage, error) {
	var ids mtp.Uint32Array
	if err := c.t.GetStorageIDs(&ids); err != nil {
		var rc mtp.RCError
		if errors.As(err, &rc) {
			// certains telephones verrouilles repondent une erreur au
			// lieu d'une liste vide
			log.Printf("GetStorageIDs: %v (treated as locked)", err)
			return nil, nil
		}
		return nil, c.mapErr(err)
	}
	var out []core.Storage
	for _, id := range ids.Values {
		if id&0xFFFF == 0 {
			// pas de stockage logique (carte SD absente...) comme libmtp
			continue
		}
		var si mtp.StorageInfo
		if err := c.t.GetStorageInfo(id, &si); err != nil {
			if c.t.h == nil {
				return nil, c.mapErr(err)
			}
			log.Printf("GetStorageInfo %#x: %v (skipped)", id, err)
			continue
		}
		desc := si.StorageDescription
		if strings.TrimSpace(desc) == "" {
			desc = si.VolumeLabel
		}
		out = append(out, core.Storage{ID: id, Description: desc, Total: si.MaxCapability, Free: si.FreeSpaceInBytes})
	}
	return out, nil
}

// Handles implemente core.Conn.
func (c *usbConn) Handles(storageID, parent uint32) ([]uint32, error) {
	var hs mtp.Uint32Array
	if err := c.t.GetObjectHandles(storageID, mtp.GOH_ALL_FORMATS, parent, &hs); err != nil {
		return nil, c.mapErr(err)
	}
	return hs.Values, nil
}

// Info implemente core.Conn.
func (c *usbConn) Info(h uint32) (core.Object, error) {
	var oi rawObjectInfo
	if err := c.t.GetObjectInfo(h, &oi); err != nil {
		var de errDecode
		if !errors.As(err, &de) || oi.Filename == "" {
			return core.Object{}, c.mapErr(err)
		}
		// decodage incomplet apres le nom (dates, mots-cles) : on garde
	}
	o := core.Object{
		Handle:    h,
		StorageID: oi.StorageID,
		Name:      oi.Filename,
		IsDir:     oi.ObjectFormat == mtp.OFC_Association,
		ModTime:   parseMTPDate(oi.ModificationDate),
	}
	if o.ModTime.IsZero() {
		o.ModTime = parseMTPDate(oi.CaptureDate)
	}
	if !o.IsDir {
		o.Size = int64(oi.CompressedSize)
		if oi.CompressedSize == 0xFFFFFFFF {
			// > 4 Gio : la vraie taille est dans la propriete ObjectSize
			var v mtp.Uint64Value
			if err := c.t.GetObjectPropValue(h, mtp.OPC_ObjectSize, &v); err != nil {
				return core.Object{}, c.mapErr(err)
			}
			o.Size = int64(v.Value)
		}
	}
	return o, nil
}

// PartialRead implemente core.Conn.
func (c *usbConn) PartialRead(size int64) bool {
	if c.ops[mtp.OC_ANDROID_GET_PARTIAL_OBJECT64] {
		return true
	}
	return c.ops[mtp.OC_GetPartialObject] && size < 0xFFFFFFFF
}

// ReadPartial implemente core.Conn.
func (c *usbConn) ReadPartial(h uint32, off int64, n uint32, w io.Writer) error {
	if c.ops[mtp.OC_ANDROID_GET_PARTIAL_OBJECT64] {
		return c.mapErr(c.t.AndroidGetPartialObject64(h, w, off, n))
	}
	if c.ops[mtp.OC_GetPartialObject] && off+int64(n) <= 0xFFFFFFFF {
		return c.mapErr(c.t.GetPartialObject(h, w, uint32(off), n))
	}
	return core.ErrNotSupported
}

// ReadAll implemente core.Conn.
func (c *usbConn) ReadAll(h uint32, w io.Writer) error {
	return c.mapErr(c.t.GetObject(h, w))
}

// CreateFolder implemente core.Conn.
func (c *usbConn) CreateFolder(storageID, parent uint32, name string) (uint32, error) {
	info := mtp.ObjectInfo{
		StorageID:        storageID,
		ObjectFormat:     mtp.OFC_Association,
		AssociationType:  0x0001, // GenericFolder
		ParentObject:     parent,
		Filename:         name,
		ModificationDate: time.Now(),
	}
	_, _, h, err := c.t.SendObjectInfo(storageID, parent, &info)
	return h, c.mapErr(err)
}

// Send implemente core.Conn.
func (c *usbConn) Send(storageID, parent uint32, name string, size int64, mtime time.Time, r io.Reader) (uint32, error) {
	compressed := uint32(0xFFFFFFFF)
	if size < 0xFFFFFFFF {
		compressed = uint32(size)
	}
	if mtime.IsZero() {
		mtime = time.Now()
	}
	info := mtp.ObjectInfo{
		StorageID:        storageID,
		ObjectFormat:     mtp.OFC_Undefined,
		ParentObject:     parent,
		Filename:         name,
		CompressedSize:   compressed,
		ModificationDate: mtime.Local(),
	}
	_, _, h, err := c.t.SendObjectInfo(storageID, parent, &info)
	if err != nil {
		return 0, c.mapErr(err)
	}
	defer c.long()()
	err = c.t.SendObject(r, size)
	if err == nil {
		return h, nil
	}
	merr := c.mapErr(err)
	if errors.Is(merr, core.ErrGone) {
		return h, merr
	}
	var rc mtp.RCError
	if errors.As(err, &rc) {
		// l'appareil a repondu : transaction terminee, session saine
		return h, merr
	}
	// erreur de lecture de la source au milieu de la phase de donnees :
	// l'appareil attend encore des octets.
	return h, fmt.Errorf("%w: %v", core.ErrDesync, err)
}

// Delete implemente core.Conn.
func (c *usbConn) Delete(h uint32) error {
	defer c.long()()
	return c.mapErr(c.t.DeleteObject(h))
}

// Rename implemente core.Conn.
func (c *usbConn) Rename(h uint32, name string) error {
	if !c.ops[mtp.OC_MTP_SetObjectPropValue] {
		return core.ErrNotSupported
	}
	err := c.t.SetObjectPropValue(h, mtp.OPC_ObjectFileName, &mtp.StringValue{Value: name})
	if err == nil {
		return nil
	}
	var rc mtp.RCError
	if errors.As(err, &rc) && rc == mtp.RC_GeneralError {
		// Kalam considere GeneralError comme un succes (certains
		// telephones renomment quand meme) : on verifie.
		if o, ierr := c.Info(h); ierr == nil && o.Name == name {
			return nil
		}
	}
	return c.mapErr(err)
}

func rootAsZero(parent uint32) uint32 {
	// MoveObject/CopyObject : la racine est 0 (SendObjectInfo : 0xFFFFFFFF)
	if parent == core.RootParent {
		return 0
	}
	return parent
}

// Move implemente core.Conn.
func (c *usbConn) Move(h, storageID, parent uint32) error {
	if !c.ops[mtp.OC_MoveObject] {
		return core.ErrNotSupported
	}
	defer c.long()()
	return c.mapErr(c.t.MoveObject(h, storageID, rootAsZero(parent)))
}

// Copy implemente core.Conn.
func (c *usbConn) Copy(h, storageID, parent uint32) (uint32, error) {
	if !c.ops[mtp.OC_CopyObject] {
		return 0, core.ErrNotSupported
	}
	defer c.long()()
	nh, err := c.t.CopyObject(h, storageID, rootAsZero(parent))
	return nh, c.mapErr(err)
}

// Resync implemente core.Conn : reset USB (le telephone abandonne
// l'envoi en cours et supprime en general le fichier partiel), puis
// reouverture du handle et de la session.
func (c *usbConn) Resync() error {
	c.t.abort()
	time.Sleep(500 * time.Millisecond)
	t := c.t
	t.Timeout = timeoutOpen
	if err := t.openHandle(); err != nil {
		return fmt.Errorf("%w: reopen after reset: %v", core.ErrGone, err)
	}
	if err := t.claim(); err != nil {
		t.Close()
		return fmt.Errorf("%w: claim after reset: %v", core.ErrGone, err)
	}
	if err := openSession(t); err != nil {
		t.Close()
		return fmt.Errorf("%w: OpenSession after reset: %v", core.ErrGone, err)
	}
	t.Timeout = c.timeout
	return nil
}

// Close implemente core.Conn.
func (c *usbConn) Close() error {
	c.t.Timeout = timeoutClose
	return c.t.Close()
}

// openSession ouvre la session ; si une session est deja ouverte (programme
// precedent mort sans la fermer), la ferme et recommence (comme
// mtp.Device.Configure).
func openSession(t *transport) error {
	err := t.OpenSession()
	if err == mtp.RCError(mtp.RC_SessionAlreadyOpened) {
		_ = t.CloseSession()
		if t.h == nil {
			return errClosed
		}
		err = t.OpenSession()
	}
	return err
}
