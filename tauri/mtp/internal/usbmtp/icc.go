//go:build cgo

package usbmtp

// Transport « Image Capture » (ImageCaptureCore, macOS).
//
// Sur macOS recent, le service systeme ptpcamerad s'empare en exclusivite de
// l'interface MTP de tout telephone branche : libusb ne peut plus la
// reclamer (LIBUSB_ERROR_ACCESS). Plutot que de tuer ce service (relance par
// launchd en quelques millisecondes, et l'interrompre laisse le telephone
// muet), on lui fait transmettre nos commandes : ImageCaptureCore expose
// requestSendPTPCommand, qui fait passer une transaction PTP/MTP complete par
// la session que le service a deja ouverte.
//
// Repris de github.com/jameshilliard/go-mtpfs (branche ptp-transport, commit
// 19ba0d9, licence BSD), semantique conservee :
//   - le service possede la session physique : jamais d'OpenSession,
//     CloseSession ni ResetDevice ; il attribue lui-meme les n° de
//     transaction (on envoie 0) ;
//   - une commande = une transaction, au plus 16 Mio envoyes et 16 Mio recus
//     (tampons memoire du service) : lectures par blocs (GetPartialObject64),
//     envois par blocs (SendObject du premier bloc, puis edition Android :
//     BeginEdit / SendPartialObject / EndEdit) ;
//   - une erreur de la passerelle (dont un delai depasse : resultat INCONNU)
//     rend la session inutilisable : jamais de nouvel essai automatique de
//     la meme commande, l'appareil passe en erreur (503) et sera rouvert.
//
// Ce fichier ne depend pas de macOS (la passerelle Objective-C est derriere
// l'interface ptpWire) : il est teste partout avec une fausse passerelle.

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"log"
	"strings"
	"time"

	"github.com/ganeshrvel/go-mtpfs/mtp"

	"copiteur-mtp/internal/core"
)

// ptpWire : une transaction PTP complete. command = conteneur de commande
// (12 a 32 octets), out = donnees envoyees (phase de donnees sortante, vide
// sinon). Renvoie les donnees recues et le conteneur de reponse brut.
type ptpWire interface {
	command(command, out []byte) (data, response []byte, err error)
	close() error
}

const (
	iccChunk      = 8 << 20  // taille des blocs lus/envoyes
	iccMaxPayload = 16 << 20 // limite de la passerelle (par sens)

	ptpTypeCommand = 1

	// operations Android d'edition (go-mtpfs/mtp/android.go)
	ocAndroidSendPartial = 0x95C2
	ocAndroidTruncate    = 0x95C3
	ocAndroidBeginEdit   = 0x95C4
	ocAndroidEndEdit     = 0x95C5
)

// errICCTooLarge : envoi impossible sans les operations d'edition Android.
var errICCTooLarge = fmt.Errorf("%w: this phone cannot receive files over 8 MiB through macOS Image Capture (no Android partial-write support)", core.ErrTooLarge)

// iccConn implemente core.Conn au-dessus d'une ptpWire.
type iccConn struct {
	w       ptpWire
	ops     map[uint16]bool
	broken  error // erreur de passerelle : session perdue
	closed  bool
	onClose func() // libere l'unique session Image Capture du processus
}

// commandBytes construit le conteneur de commande PTP (n° de transaction
// 0 : attribue par le service).
func commandBytes(code uint16, params []uint32) ([]byte, error) {
	if len(params) > 5 {
		return nil, fmt.Errorf("mtp: PTP command has more than five parameters")
	}
	b := make([]byte, 12+4*len(params))
	binary.LittleEndian.PutUint32(b[0:], uint32(len(b)))
	binary.LittleEndian.PutUint16(b[4:], ptpTypeCommand)
	binary.LittleEndian.PutUint16(b[6:], code)
	binary.LittleEndian.PutUint32(b[8:], 0)
	for i, p := range params {
		binary.LittleEndian.PutUint32(b[12+4*i:], p)
	}
	return b, nil
}

// parseResponse lit un conteneur de reponse PTP : code et parametres.
func parseResponse(resp []byte) (code uint16, params []uint32, err error) {
	if len(resp) < 12 || len(resp) > 32 || (len(resp)-12)%4 != 0 ||
		int(binary.LittleEndian.Uint32(resp[0:])) != len(resp) {
		return 0, nil, fmt.Errorf("malformed PTP response (%d bytes)", len(resp))
	}
	code = binary.LittleEndian.Uint16(resp[6:])
	if !((code >= 0x2000 && code < 0x3000) || (code >= 0xA000 && code < 0xB000)) {
		return 0, nil, fmt.Errorf("malformed PTP response code 0x%04x", code)
	}
	for i := 12; i < len(resp); i += 4 {
		params = append(params, binary.LittleEndian.Uint32(resp[i:]))
	}
	return code, params, nil
}

// gone marque la session comme perdue.
func (c *iccConn) gone(format string, args ...any) error {
	err := fmt.Errorf("%w: Image Capture: "+format, append([]any{core.ErrGone}, args...)...)
	if c.broken == nil {
		c.broken = err
		log.Printf("Image Capture session lost: %v", err)
	}
	return err
}

// run execute une transaction. Erreur MTP (code retour) -> mtp.RCError ;
// erreur de passerelle ou reponse invalide -> ErrGone (session perdue).
func (c *iccConn) run(code uint16, params []uint32, out []byte) ([]byte, []uint32, error) {
	if c.closed {
		return nil, nil, fmt.Errorf("%w: Image Capture session closed", core.ErrGone)
	}
	if c.broken != nil {
		return nil, nil, c.broken
	}
	if code == mtp.OC_OpenSession || code == mtp.OC_CloseSession || code == mtp.OC_ResetDevice {
		return nil, nil, errors.New("mtp: the macOS camera service owns the device session")
	}
	if len(out) > iccMaxPayload {
		return nil, nil, fmt.Errorf("mtp: data-out payload over %d bytes", iccMaxPayload)
	}
	cmd, err := commandBytes(code, params)
	if err != nil {
		return nil, nil, err
	}
	data, resp, err := c.w.command(cmd, out)
	if err != nil {
		// y compris un delai depasse : resultat inconnu, pas de nouvel essai
		return nil, nil, c.gone("command 0x%04x: %v", code, err)
	}
	rc, rparams, err := parseResponse(resp)
	if err != nil {
		return nil, nil, c.gone("command 0x%04x: %v", code, err)
	}
	if len(data) > iccMaxPayload {
		return nil, nil, c.gone("command 0x%04x: %d bytes of data", code, len(data))
	}
	if rc != mtp.RC_OK {
		return data, rparams, mtp.RCError(rc)
	}
	return data, rparams, nil
}

// do : run + traduction des codes retour en erreurs core.
func (c *iccConn) do(code uint16, params []uint32, out []byte) ([]byte, []uint32, error) {
	data, p, err := c.run(code, params, out)
	return data, p, mapRC(err)
}

func decodeU32Array(b []byte) ([]uint32, error) {
	if len(b) < 4 {
		return nil, errors.New("mtp: short array")
	}
	n := binary.LittleEndian.Uint32(b)
	if uint64(len(b)-4) < 4*uint64(n) {
		return nil, errors.New("mtp: truncated array")
	}
	out := make([]uint32, n)
	for i := range out {
		out[i] = binary.LittleEndian.Uint32(b[4+4*i:])
	}
	return out, nil
}

// newICCConn interroge l'appareil (GetDeviceInfo) au travers d'une session
// Image Capture deja ouverte.
func newICCConn(w ptpWire, onClose func()) (*iccConn, *rawDeviceInfo, error) {
	c := &iccConn{w: w, ops: map[uint16]bool{}, onClose: onClose}
	data, _, err := c.do(mtp.OC_GetDeviceInfo, nil, nil)
	if err != nil {
		c.Close()
		return nil, nil, fmt.Errorf("querying the phone: %w", err)
	}
	var info rawDeviceInfo
	if err := info.Decode(bytes.NewReader(data)); err != nil {
		c.Close()
		return nil, nil, fmt.Errorf("decoding DeviceInfo: %v", err)
	}
	for _, op := range info.OperationsSupported {
		c.ops[op] = true
	}
	if !c.ops[mtp.OC_MTP_GetObjectPropsSupported] || (info.MTPVendorExtensionID != 6 && info.MTPExtension == "") {
		c.Close()
		return nil, nil, errors.New("the phone does not advertise MTP: choose \"File transfer\" in its USB notification")
	}
	return c, &info, nil
}

func (c *iccConn) canEdit() bool {
	return c.ops[ocAndroidBeginEdit] && c.ops[ocAndroidSendPartial] &&
		c.ops[ocAndroidTruncate] && c.ops[ocAndroidEndEdit]
}

// Storages implemente core.Conn.
func (c *iccConn) Storages() ([]core.Storage, error) {
	data, _, err := c.run(mtp.OC_GetStorageIDs, nil, nil)
	var rc mtp.RCError
	if errors.As(err, &rc) {
		log.Printf("GetStorageIDs: %v (treated as locked)", err)
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	ids, err := decodeU32Array(data)
	if err != nil {
		return nil, c.gone("GetStorageIDs: %v", err)
	}
	var out []core.Storage
	for _, id := range ids {
		if id&0xFFFF == 0 {
			continue // pas de stockage logique (carte SD absente...)
		}
		data, _, err := c.run(mtp.OC_GetStorageInfo, []uint32{id}, nil)
		if errors.Is(err, core.ErrGone) {
			return nil, err
		}
		var si rawStorageInfo
		if err == nil {
			err = si.Decode(bytes.NewReader(data))
		}
		if err != nil {
			log.Printf("GetStorageInfo %#x: %v (skipped)", id, err)
			continue
		}
		desc := si.StorageDescription
		if strings.TrimSpace(desc) == "" {
			desc = si.VolumeLabel
		}
		out = append(out, core.Storage{ID: id, Description: desc, Total: si.Fixed.MaxCapability, Free: si.Fixed.FreeSpaceInBytes})
	}
	return out, nil
}

// Handles implemente core.Conn.
func (c *iccConn) Handles(storageID, parent uint32) ([]uint32, error) {
	data, _, err := c.do(mtp.OC_GetObjectHandles, []uint32{storageID, mtp.GOH_ALL_FORMATS, parent}, nil)
	if err != nil {
		return nil, err
	}
	hs, err := decodeU32Array(data)
	if err != nil {
		return nil, c.gone("GetObjectHandles: %v", err)
	}
	return hs, nil
}

func (c *iccConn) objectSize(h uint32) (uint64, error) {
	data, _, err := c.do(mtp.OC_MTP_GetObjectPropValue, []uint32{h, mtp.OPC_ObjectSize}, nil)
	if err != nil {
		return 0, err
	}
	if len(data) < 8 {
		return 0, c.gone("ObjectSize: %d bytes", len(data))
	}
	return binary.LittleEndian.Uint64(data), nil
}

// Info implemente core.Conn.
func (c *iccConn) Info(h uint32) (core.Object, error) {
	data, _, err := c.do(mtp.OC_GetObjectInfo, []uint32{h}, nil)
	if err != nil {
		return core.Object{}, err
	}
	var oi rawObjectInfo
	if err := oi.Decode(bytes.NewReader(data)); err != nil && oi.Filename == "" {
		return core.Object{}, fmt.Errorf("mtp: decoding ObjectInfo: %v", err)
	}
	o := objectFromInfo(h, &oi)
	if !o.IsDir && oi.CompressedSize == 0xFFFFFFFF {
		size, err := c.objectSize(h)
		if err != nil {
			return core.Object{}, err
		}
		o.Size = int64(size)
	}
	return o, nil
}

// PartialRead implemente core.Conn.
func (c *iccConn) PartialRead(size int64) bool {
	if c.ops[mtp.OC_ANDROID_GET_PARTIAL_OBJECT64] {
		return true
	}
	return c.ops[mtp.OC_GetPartialObject] && size < 0xFFFFFFFF
}

// ReadPartial implemente core.Conn (au plus 16 Mio par transaction).
func (c *iccConn) ReadPartial(h uint32, off int64, n uint32, w io.Writer) error {
	n = min(n, iccMaxPayload)
	var data []byte
	var p []uint32
	var err error
	switch {
	case c.ops[mtp.OC_ANDROID_GET_PARTIAL_OBJECT64]:
		data, p, err = c.do(mtp.OC_ANDROID_GET_PARTIAL_OBJECT64, []uint32{h, uint32(off), uint32(off >> 32), n}, nil)
	case c.ops[mtp.OC_GetPartialObject] && off+int64(n) <= 0xFFFFFFFF:
		data, p, err = c.do(mtp.OC_GetPartialObject, []uint32{h, uint32(off), n}, nil)
	default:
		return core.ErrNotSupported
	}
	if err != nil {
		return err
	}
	if len(data) > int(n) || (len(p) >= 1 && int(p[0]) != len(data)) {
		return c.gone("partial read: %d bytes for %d requested (count %v)", len(data), n, p)
	}
	_, err = w.Write(data)
	return err
}

// ReadAll implemente core.Conn : GetObject d'un coup, possible seulement
// sous la limite de la passerelle (16 Mio).
func (c *iccConn) ReadAll(h uint32, w io.Writer) error {
	size, err := c.objectSize(h)
	if err != nil {
		return err
	}
	if size > iccMaxPayload {
		return fmt.Errorf("%w: the phone has no partial read and the file is over 16 MiB (macOS Image Capture limit)", core.ErrNotSupported)
	}
	data, _, err := c.do(mtp.OC_GetObject, []uint32{h}, nil)
	if err != nil {
		return err
	}
	if uint64(len(data)) != size {
		return c.gone("GetObject: %d bytes, expected %d", len(data), size)
	}
	_, err = w.Write(data)
	return err
}

func (c *iccConn) sendObjectInfo(storageID, parent uint32, info *sendObjectInfo) (uint32, error) {
	var buf bytes.Buffer
	if err := info.Encode(&buf); err != nil {
		return 0, err
	}
	_, p, err := c.run(mtp.OC_SendObjectInfo, []uint32{storageID, parent}, buf.Bytes())
	if err != nil {
		return 0, nameErr(mapRC(err), err, info.Filename)
	}
	if len(p) < 3 {
		return 0, c.gone("SendObjectInfo: response %v", p)
	}
	return p[2], nil
}

// CreateFolder implemente core.Conn.
func (c *iccConn) CreateFolder(storageID, parent uint32, name string) (uint32, error) {
	return c.sendObjectInfo(storageID, parent, &sendObjectInfo{
		objectInfoFixed: objectInfoFixed{
			StorageID:       storageID,
			ObjectFormat:    mtp.OFC_Association,
			AssociationType: 0x0001,
			ParentObject:    parent,
		},
		Filename:         name,
		ModificationDate: time.Now(),
	})
}

// Send implemente core.Conn. Envoi par blocs : SendObjectInfo annonce le
// premier bloc seulement (min(taille, 8 Mio), 1 octet pour un fichier vide),
// SendObject l'envoie, puis l'edition Android ajoute le reste (ou tronque a
// 0) et la taille finale est verifiee.
//
// Si la source s'arrete en route, la transaction en cours est completee
// (zeros pour le premier bloc, sinon on s'arrete entre deux blocs), l'edition
// est refermee proprement et l'objet partiel supprime : la session reste
// saine, aucune resynchronisation n'est necessaire.
func (c *iccConn) Send(storageID, parent uint32, name string, size int64, mtime time.Time, r io.Reader) (h uint32, err error) {
	if size < 0 {
		return 0, errors.New("mtp: size required")
	}
	if size > iccChunk && !c.canEdit() {
		return 0, errICCTooLarge
	}
	if size == 0 && !c.canEdit() {
		return 0, fmt.Errorf("%w: empty files cannot be created on this phone through macOS Image Capture", core.ErrNotSupported)
	}
	first := min(size, iccChunk)
	announced := first
	if size == 0 {
		announced = 1 // une phase de donnees vide n'est pas transmise
	}
	if mtime.IsZero() {
		mtime = time.Now()
	}
	h, err = c.sendObjectInfo(storageID, parent, &sendObjectInfo{
		objectInfoFixed: objectInfoFixed{
			StorageID:      storageID,
			ObjectFormat:   mtp.OFC_Undefined,
			ParentObject:   parent,
			CompressedSize: uint32(announced),
		},
		Filename:         name,
		ModificationDate: mtime.Local(),
	})
	if err != nil {
		return 0, err
	}
	// abandon : objet partiel supprime, erreur de la source renvoyee
	abort := func(cause error) (uint32, error) {
		if c.broken != nil {
			return h, c.broken
		}
		if _, _, derr := c.do(mtp.OC_DeleteObject, []uint32{h, 0}, nil); derr != nil && !errors.Is(derr, core.ErrNotFound) {
			log.Printf("Image Capture: could not delete partial object %q: %v", name, derr)
			return h, cause
		}
		return 0, cause
	}

	buf := make([]byte, announced)
	var readErr error
	if size > 0 {
		if _, rerr := io.ReadFull(r, buf); rerr != nil {
			// on complete quand meme la transaction (le telephone attend
			// SendObject), avec des zeros, puis on supprime
			readErr = rerr
		}
	}
	if _, _, err := c.do(mtp.OC_SendObject, nil, buf); err != nil {
		if errors.Is(err, core.ErrGone) {
			return h, err
		}
		return abort(err)
	}
	if readErr != nil {
		return abort(readErr)
	}
	if size > 0 && size <= iccChunk {
		return h, nil
	}

	if _, _, err := c.do(ocAndroidBeginEdit, []uint32{h}, nil); err != nil {
		if errors.Is(err, core.ErrGone) {
			return h, err
		}
		return abort(err)
	}
	editErr := func() error {
		if size == 0 {
			_, _, err := c.do(ocAndroidTruncate, []uint32{h, 0, 0}, nil)
			return err
		}
		for off := first; off < size; {
			n := min(int64(iccChunk), size-off)
			if _, err := io.ReadFull(r, buf[:n]); err != nil {
				return &sourceError{err}
			}
			_, p, err := c.do(ocAndroidSendPartial, []uint32{h, uint32(off), uint32(off >> 32), uint32(n)}, buf[:n])
			if err != nil {
				return err
			}
			// Android peut sous-compter (octets du paquet d'en-tete) : la
			// taille finale est verifiee ; un compte superieur est absurde.
			if len(p) != 1 || int64(p[0]) > n {
				return c.gone("SendPartialObject: count %v for %d bytes", p, n)
			}
			off += n
		}
		return nil
	}()
	if c.broken != nil {
		return h, c.broken
	}
	// toujours refermer l'edition (sinon le fichier reste ouvert cote Android)
	if _, _, err := c.do(ocAndroidEndEdit, []uint32{h}, nil); err != nil && editErr == nil {
		editErr = err
	}
	if c.broken != nil {
		return h, c.broken
	}
	if editErr != nil {
		var se *sourceError
		if errors.As(editErr, &se) {
			return abort(se.err)
		}
		return abort(editErr)
	}
	got, err := c.objectSize(h)
	if err != nil {
		if errors.Is(err, core.ErrGone) {
			return h, err
		}
		return abort(err)
	}
	if got != uint64(size) {
		return abort(fmt.Errorf("mtp: committed upload size is %d, expected %d", got, size))
	}
	return h, nil
}

// sourceError : la source (corps HTTP) s'est arretee.
type sourceError struct{ err error }

func (e *sourceError) Error() string { return "upload source: " + e.err.Error() }
func (e *sourceError) Unwrap() error { return e.err }

// Delete implemente core.Conn.
func (c *iccConn) Delete(h uint32) error {
	_, _, err := c.do(mtp.OC_DeleteObject, []uint32{h, 0}, nil)
	return err
}

// Rename implemente core.Conn.
func (c *iccConn) Rename(h uint32, name string) error {
	if !c.ops[mtp.OC_MTP_SetObjectPropValue] {
		return core.ErrNotSupported
	}
	var buf bytes.Buffer
	if err := (&mtpString{Value: name}).Encode(&buf); err != nil {
		return err
	}
	_, _, err := c.run(mtp.OC_MTP_SetObjectPropValue, []uint32{h, mtp.OPC_ObjectFileName}, buf.Bytes())
	if err == nil {
		return nil
	}
	var rc mtp.RCError
	if errors.As(err, &rc) && rc == mtp.RC_GeneralError {
		if o, ierr := c.Info(h); ierr == nil && o.Name == name {
			return nil
		}
	}
	return nameErr(mapRC(err), err, name)
}

// Move implemente core.Conn.
func (c *iccConn) Move(h, storageID, parent uint32) error {
	if !c.ops[mtp.OC_MoveObject] {
		return core.ErrNotSupported
	}
	_, _, err := c.do(mtp.OC_MoveObject, []uint32{h, storageID, rootAsZero(parent)}, nil)
	return err
}

// Copy implemente core.Conn.
func (c *iccConn) Copy(h, storageID, parent uint32) (uint32, error) {
	if !c.ops[mtp.OC_CopyObject] {
		return 0, core.ErrNotSupported
	}
	_, p, err := c.do(mtp.OC_CopyObject, []uint32{h, storageID, rootAsZero(parent)}, nil)
	if err != nil {
		return 0, err
	}
	if len(p) < 1 {
		return 0, c.gone("CopyObject: no handle in response")
	}
	return p[0], nil
}

// Resync implemente core.Conn : rien a resynchroniser (chaque commande est
// une transaction complete, la session appartient au service). Une session
// perdue ne se repare pas ici : ErrGone, l'appareil sera rouvert.
func (c *iccConn) Resync() error {
	if c.broken != nil {
		return c.broken
	}
	if c.closed {
		return core.ErrGone
	}
	return nil
}

// Close implemente core.Conn : ferme NOTRE session cliente (le service garde
// la sienne).
func (c *iccConn) Close() error {
	if c.closed {
		return nil
	}
	c.closed = true
	err := c.w.close()
	if c.onClose != nil {
		c.onClose()
	}
	return err
}

// iccTarget : interface MTP/PTP vue par IOKit (omtp_ic_devices), sans
// rien reclamer. AppleOwned : tenue par ptpcamerad/PTPCamera.
type iccTarget struct {
	Vendor       uint16 `json:"vendor"`
	Product      uint16 `json:"product"`
	Location     uint32 `json:"location"`
	Release      uint16 `json:"release"`
	Manufacturer string `json:"manufacturer"`
	Name         string `json:"name"`
	Serial       string `json:"serial"`
	AppleOwned   bool   `json:"appleOwned"`
}

// matchICCTarget retrouve, parmi les interfaces vues par IOKit, celle du
// telephone de l'entree USB : par n° de serie USB s'il est connu (et
// unique), sinon par vendor/product s'il n'y a qu'un seul candidat
// (libusb ne donne pas ici le locationID d'IOKit).
func matchICCTarget(targets []iccTarget, serial string, vendor, product uint16) (*iccTarget, error) {
	var found []*iccTarget
	if serial != "" {
		for i := range targets {
			if targets[i].Serial == serial {
				found = append(found, &targets[i])
			}
		}
	}
	if len(found) == 0 {
		for i := range targets {
			if targets[i].Vendor == vendor && targets[i].Product == product {
				found = append(found, &targets[i])
			}
		}
	}
	switch len(found) {
	case 0:
		return nil, errors.New("phone not found by macOS Image Capture")
	case 1:
		return found[0], nil
	}
	return nil, errors.New("several identical phones without a serial number: connect them one at a time")
}
