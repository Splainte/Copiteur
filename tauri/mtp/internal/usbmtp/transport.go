//go:build cgo

// Transport MTP sur USB.
//
// Ce fichier est DERIVE de github.com/ganeshrvel/go-mtpfs/mtp (mtp.go,
// ops.go, android.go, select.go), le moteur qu'utilise OpenMTP (Kalam).
// Copyright (c) 2012 Google Inc. All rights reserved. Licence BSD
// (voir NOTICES.md). Les types, l'encodage et les constantes restent ceux
// du paquet d'origine (importe tel quel).
//
// Pourquoi une copie plutot que mtp.Device : le paquet d'origine ne donne
// acces ni au descripteur USB (bus/adresse, n° de serie avant ouverture),
// ni au resultat de ClaimInterface (Open() ignore l'echec, ce qui empeche
// de distinguer "occupe par un autre programme"), et Open() reclame
// l'interface AVANT de verifier qu'il s'agit bien d'un appareil MTP.
// GetPartialObject (0x101B) y envoie aussi le mauvais code d'operation.
// Modifications par rapport a l'original :
//   - openHandle()/claim() separes et erreurs remontees ;
//   - verification de la chaine d'interface "MTP" sans reclamer l'interface ;
//   - GetPartialObject / MoveObject / CopyObject ajoutes ou corriges ;
//   - io.CopyN du premier paquet de bulkWrite : erreur verifiee ;
//   - plus de journaux de debogage.
// Le reste (runTransaction, bulkRead/bulkWrite, paquet nul final, mode
// "SeparateHeader") est identique a l'original pour se comporter comme
// OpenMTP avec les telephones reels.

package usbmtp

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"log"
	"math/rand/v2"
	"strings"
	"time"

	"github.com/ganeshrvel/go-mtpfs/mtp"
	"github.com/ganeshrvel/usb"
)

var byteOrder = binary.LittleEndian

type usbBulkHeader struct {
	Length        uint32
	Type          uint16
	Code          uint16
	TransactionID uint32
}

type usbBulkContainer struct {
	usbBulkHeader
	Param [5]uint32
}

const usbHdrLen = 2*2 + 2*4
const usbBulkLen = 5*4 + usbHdrLen

// La pile USB Linux envoie 16 Kio par appel (selon libusb).
const rwBufSize = 0x4000

// Taille des blocs envoyes par bulkWrite : multiple de toutes les tailles
// de paquet USB (64/512/1024 octets), pour que seul le dernier bloc puisse
// etre un paquet court.
const sendChunkSize = 256 << 10

type sessionData struct {
	tid uint32
	sid uint32
}

// candidate : interface USB qui ressemble a du MTP/PTP (3 points d'acces :
// bulk in, bulk out, interrupt in), sans ouvrir l'appareil.
type candidate struct {
	dev         *usb.Device // reference tenue par l'appelant
	devDescr    usb.DeviceDescriptor
	ifaceDescr  usb.InterfaceDescriptor
	sendEP      byte
	fetchEP     byte
	eventEP     byte
	configValue byte
	bus, addr   uint8
}

// candidateFromDevice reprend candidateFromDeviceDescriptor de go-mtpfs.
func candidateFromDevice(d *usb.Device) *candidate {
	dd, err := d.GetDeviceDescriptor()
	if err != nil {
		return nil
	}
	for i := byte(0); i < dd.NumConfigurations; i++ {
		cdecs, err := d.GetConfigDescriptor(i)
		if err != nil {
			return nil
		}
		for _, iface := range cdecs.Interfaces {
			for _, a := range iface.AltSetting {
				if len(a.EndPoints) != 3 {
					continue
				}
				m := candidate{}
				for _, s := range a.EndPoints {
					switch {
					case s.Direction() == usb.ENDPOINT_IN && s.TransferType() == usb.TRANSFER_TYPE_INTERRUPT:
						m.eventEP = s.EndpointAddress
					case s.Direction() == usb.ENDPOINT_IN && s.TransferType() == usb.TRANSFER_TYPE_BULK:
						m.fetchEP = s.EndpointAddress
					case s.Direction() == usb.ENDPOINT_OUT && s.TransferType() == usb.TRANSFER_TYPE_BULK:
						m.sendEP = s.EndpointAddress
					}
				}
				if m.sendEP > 0 && m.fetchEP > 0 && m.eventEP > 0 {
					m.dev = d
					m.devDescr = *dd
					m.ifaceDescr = a
					m.configValue = cdecs.ConfigurationValue
					m.bus = d.GetBusNumber()
					m.addr = d.GetDeviceAddress()
					return &m
				}
			}
		}
	}
	return nil
}

// transport : equivalent de mtp.Device.
type transport struct {
	c *candidate
	h *usb.DeviceHandle

	claimed bool

	// En millisecondes.
	Timeout int

	// Si vrai, l'en-tete est envoye dans une ecriture separee.
	SeparateHeader bool

	session *sessionData
}

func (d *transport) fetchMaxPacketSize() int { return d.c.dev.GetMaxPacketSize(d.c.fetchEP) }
func (d *transport) sendMaxPacketSize() int  { return d.c.dev.GetMaxPacketSize(d.c.sendEP) }

func emptyProgress(int64) error { return nil }

// openHandle ouvre le handle libusb (sans reclamer l'interface).
func (d *transport) openHandle() error {
	if d.Timeout == 0 {
		d.Timeout = 2000
	}
	if d.h != nil {
		return fmt.Errorf("already open")
	}
	h, err := d.c.dev.Open()
	if err != nil {
		return err
	}
	d.h = h
	return nil
}

// stringDescr lit un descripteur de chaine (index 0 = absent).
func (d *transport) stringDescr(idx byte) string {
	if idx == 0 || d.h == nil {
		return ""
	}
	s, err := d.h.GetStringDescriptorASCII(idx)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(s)
}

// interfaceLooksMTP reprend le test de mtp.Device.Open() sur la chaine
// d'interface, mais AVANT de reclamer l'interface. known=false : pas de
// chaine (il faudra GetDeviceInfo).
func (d *transport) interfaceLooksMTP() (ok, known bool, err error) {
	if d.c.ifaceDescr.InterfaceStringIndex == 0 {
		return false, false, nil
	}
	iface, err := d.h.GetStringDescriptorASCII(d.c.ifaceDescr.InterfaceStringIndex)
	if err != nil {
		return false, false, err
	}
	// "CDC"/"ACM" : anciens Samsung (comme go-mtpfs)
	return strings.Contains(iface, "MTP") || strings.Contains(iface, "CDC") || strings.Contains(iface, "ACM"), true, nil
}

// recoverPTP remet l'interface dans un etat propre quand un autre client
// (ptpcamerad, arrete par releaseImageCapture) a ete interrompu en pleine
// transaction : sans ca, le telephone attend encore la suite de l'ancien
// echange et notre OpenSession reste sans reponse (constate sur un Pixel 9 Pro
// XL : LIBUSB_ERROR_TIMEOUT). Procedure de la classe « Still Image » (PTP sur
// USB, que MTP reprend) : demande de reinitialisation (0x66), deblocage des
// points d'acces, donnees en attente jetees, puis statut lu jusqu'a « OK »
// (0x67). Chaque etape est facultative : une erreur n'arrete pas la suite.
func (d *transport) recoverPTP() {
	if d.h == nil {
		return
	}
	iface := uint16(d.c.ifaceDescr.InterfaceNumber)
	rerr := d.h.ControlTransfer(0x21, 0x66, 0, iface, nil, 1000)
	_ = d.h.ClearHalt(d.c.sendEP)
	_ = d.h.ClearHalt(d.c.fetchEP)
	buf := make([]byte, 16384)
	drained := 0
	for i := 0; i < 256; i++ {
		n, err := d.h.BulkTransfer(d.c.fetchEP, buf, 100)
		drained += n
		if err != nil || n == 0 {
			break
		}
	}
	code := uint16(0)
	st := make([]byte, 32)
	for i := 0; i < 20; i++ {
		for j := range st {
			st[j] = 0
		}
		if err := d.h.ControlTransfer(0xA1, 0x67, 0, iface, st, 1000); err == nil {
			code = binary.LittleEndian.Uint16(st[2:4])
			if code == 0x2001 {
				break
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	log.Printf("USB: PTP recovery: reset=%v drained=%d status=0x%04x", rerr, drained, code)
}

// ensureConfig : comme selectDevice() de go-mtpfs.
func (d *transport) ensureConfig() error {
	cfg, err := d.h.GetConfiguration()
	if err != nil {
		return err
	}
	if cfg != d.c.configValue {
		return d.h.SetConfiguration(d.c.configValue)
	}
	return nil
}

// claim reclame l'interface MTP. Une erreur ici signifie le plus souvent
// qu'un autre programme la tient.
func (d *transport) claim() error {
	if d.h == nil {
		return fmt.Errorf("mtp: claim: device not open")
	}
	err := d.h.ClaimInterface(d.c.ifaceDescr.InterfaceNumber)
	if err == nil {
		d.claimed = true
	}
	return err
}

// Close ferme la session, libere l'interface et ferme le handle
// (identique a mtp.Device.Close).
func (d *transport) Close() error {
	if d.h == nil {
		return nil
	}
	if d.session != nil {
		var req, rep mtp.Container
		req.Code = mtp.OC_CloseSession
		if err := d.runTransaction(&req, &rep, nil, nil, 0, emptyProgress); err != nil {
			_ = d.h.Reset()
		}
		d.session = nil
	}
	if d.claimed {
		_ = d.h.ReleaseInterface(d.c.ifaceDescr.InterfaceNumber)
		d.claimed = false
	}
	err := d.h.Close()
	d.h = nil
	return err
}

// abort ferme tout sans tenter CloseSession (la session est desynchronisee
// : l'appareil attend encore des donnees). Reset USB pour que le telephone
// abandonne la transaction en cours.
func (d *transport) abort() {
	if d.h == nil {
		return
	}
	d.session = nil
	if err := d.h.Reset(); err != nil {
		log.Printf("USB reset: %v", err)
	}
	if d.claimed {
		_ = d.h.ReleaseInterface(d.c.ifaceDescr.InterfaceNumber)
		d.claimed = false
	}
	_ = d.h.Close()
	d.h = nil
}

func (d *transport) sendReq(req *mtp.Container) error {
	c := usbBulkContainer{
		usbBulkHeader: usbBulkHeader{
			Length:        uint32(usbHdrLen + 4*len(req.Param)),
			Type:          mtp.USB_CONTAINER_COMMAND,
			Code:          req.Code,
			TransactionID: req.TransactionID,
		},
	}
	for i := range req.Param {
		c.Param[i] = req.Param[i]
	}

	var wData [usbBulkLen]byte
	buf := bytes.NewBuffer(wData[:0])

	_ = binary.Write(buf, binary.LittleEndian, c.usbBulkHeader)
	if err := binary.Write(buf, binary.LittleEndian, c.Param[:len(req.Param)]); err != nil {
		return err
	}

	_, err := d.h.BulkTransfer(d.c.sendEP, buf.Bytes(), d.Timeout)
	return err
}

// fetchPacket lit un paquet USB et separe l'en-tete.
func (d *transport) fetchPacket(dest []byte, header *usbBulkHeader) (rest []byte, bytesRead int, err error) {
	n, err := d.h.BulkTransfer(d.c.fetchEP, dest[:d.fetchMaxPacketSize()], d.Timeout)
	if err != nil {
		return nil, n, err
	}
	buf := bytes.NewBuffer(dest[:n])
	if err = binary.Read(buf, binary.LittleEndian, header); err != nil {
		return nil, n, err
	}
	return buf.Bytes(), n, nil
}

func (d *transport) decodeRep(h *usbBulkHeader, rest []byte, rep *mtp.Container) error {
	if h.Type != mtp.USB_CONTAINER_RESPONSE {
		return mtp.SyncError(fmt.Sprintf("got type %d (%s) in response, want CONTAINER_RESPONSE.", h.Type, mtp.USB_names[int(h.Type)]))
	}

	rep.Code = h.Code
	rep.TransactionID = h.TransactionID

	restLen := int(h.Length) - usbHdrLen
	if restLen > len(rest) {
		return fmt.Errorf("header specified 0x%x bytes, but have 0x%x", restLen, len(rest))
	}
	nParam := restLen / 4
	for i := 0; i < nParam; i++ {
		rep.Param = append(rep.Param, byteOrder.Uint32(rest[4*i:]))
	}

	if rep.Code != mtp.RC_OK {
		return mtp.RCError(rep.Code)
	}
	return nil
}

// errClosed : le transport a ete ferme apres une erreur fatale.
var errClosed = errors.New("mtp: device is not open")

// RunTransaction execute une transaction MTP. Les erreurs qui cassent la
// synchronisation (erreurs USB, SyncError) ferment la connexion, comme
// dans go-mtpfs.
func (d *transport) RunTransaction(req *mtp.Container, rep *mtp.Container,
	dest io.Writer, src io.Reader, writeSize int64) error {
	if d.h == nil {
		return errClosed
	}
	if err := d.runTransaction(req, rep, dest, src, writeSize, emptyProgress); err != nil {
		_, ok2 := err.(mtp.SyncError)
		_, ok1 := err.(usb.Error)
		if ok1 || ok2 {
			log.Printf("fatal USB error %v; closing connection", err)
			// Modification : delai court pour la fermeture (le delai courant
			// peut etre celui d'une operation longue, 120 s).
			d.Timeout = timeoutClose
			d.Close()
		}
		return err
	}
	return nil
}

// runTransaction : copie de go-mtpfs.
func (d *transport) runTransaction(req *mtp.Container, rep *mtp.Container,
	dest io.Writer, src io.Reader, writeSize int64, progressCb mtp.ProgressFunc) error {
	var finalPacket []byte
	if d.session != nil {
		req.SessionID = d.session.sid
		req.TransactionID = d.session.tid
		d.session.tid++
	}

	if err := d.sendReq(req); err != nil {
		return err
	}

	if src != nil {
		hdr := usbBulkHeader{
			Type:          mtp.USB_CONTAINER_DATA,
			Code:          req.Code,
			Length:        uint32(writeSize),
			TransactionID: req.TransactionID,
		}

		_, err := d.bulkWrite(&hdr, src, writeSize, progressCb)
		if err != nil {
			return err
		}
	}
	fetchPacketSize := d.fetchMaxPacketSize()
	data := make([]byte, fetchPacketSize)
	h := &usbBulkHeader{}
	rest, n, err := d.fetchPacket(data[:], h)
	if err != nil {
		return err
	}
	var unexpectedData bool
	if h.Type == mtp.USB_CONTAINER_DATA {
		if dest == nil {
			dest = &mtp.NullWriter{}
			unexpectedData = true
		}

		_, _ = dest.Write(rest)

		if len(rest)+usbHdrLen == fetchPacketSize || uint32(n) < h.Length {
			// Cas particulier (annexe H de la spec MTP 1.1) : l'appareil
			// peut envoyer un paquet de 12 octets (en-tete seul) puis les
			// donnees. Les deux parties doivent alors suivre la meme regle.
			if n == usbHdrLen && len(rest) == 0 && uint32(n) < h.Length {
				d.SeparateHeader = true
			}

			// Paquet plein, ou l'appareil annonce plus que recu : on lit
			// jusqu'a un paquet court.
			_, finalPacket, err = d.bulkRead(dest, progressCb)
			if err != nil {
				return err
			}
		}

		h = &usbBulkHeader{}
		if len(finalPacket) > 0 {
			rest = finalPacket
			finalBuf := bytes.NewBuffer(finalPacket[:len(finalPacket)])
			err = binary.Read(finalBuf, binary.LittleEndian, h)
		} else {
			// comme l'original : une erreur ici laisse h vide et
			// decodeRep renvoie une SyncError (connexion fermee)
			rest, _, _ = d.fetchPacket(data[:], h)
		}
	}

	err = d.decodeRep(h, rest, rep)
	if unexpectedData {
		return mtp.SyncError(fmt.Sprintf("unexpected data for code %s", mtp.RC_names[int(req.Code)]))
	}

	if err != nil {
		return err
	}
	if d.session != nil && rep.TransactionID != req.TransactionID {
		return mtp.SyncError(fmt.Sprintf("transaction ID mismatch got %x want %x",
			rep.TransactionID, req.TransactionID))
	}
	rep.SessionID = req.SessionID
	return nil
}

// bulkWrite renvoie le nombre d'octets (hors en-tete) ecrits.
func (d *transport) bulkWrite(hdr *usbBulkHeader, r io.Reader, size int64, progressCb mtp.ProgressFunc) (n int64, err error) {
	totalSize := size
	packetSize := d.sendMaxPacketSize()
	if hdr != nil {
		if size+usbHdrLen > 0xFFFFFFFF {
			hdr.Length = 0xFFFFFFFF
		} else {
			hdr.Length = uint32(size + usbHdrLen)
		}

		packetArr := make([]byte, packetSize)
		var packet []byte
		if d.SeparateHeader {
			packet = packetArr[:usbHdrLen]
		} else {
			packet = packetArr[:]
		}

		buf := bytes.NewBuffer(packet[:0])
		_ = binary.Write(buf, byteOrder, hdr)
		cpSize := int64(len(packet) - usbHdrLen)
		if cpSize > size {
			cpSize = size
		}

		if _, err = io.CopyN(buf, r, cpSize); err != nil {
			// modification : l'original ignorait cette erreur
			return 0, err
		}
		_, err = d.h.BulkTransfer(d.c.sendEP, buf.Bytes(), d.Timeout)
		if err != nil {
			return cpSize, err
		}
		size -= cpSize
		n += cpSize

		if err = progressCb(totalSize - size); err != nil {
			return cpSize, err
		}
	}

	// Modification : lecture par blocs PLEINS (io.ReadFull) de
	// sendChunkSize, multiple de la taille de paquet. L'original faisait un
	// seul r.Read par tour : avec un corps HTTP, une lecture partielle
	// (tampon de 4 Kio) donnait un paquet USB COURT au milieu du conteneur.
	// Android (MtpFfsHandle::receiveFile) abandonne alors l'envoi (< 4 Gio)
	// ou, pour un fichier >= 4 Gio (longueur 0xFFFFFFFF), prend le paquet
	// court pour la fin du fichier et le tronque sans erreur.
	buf := make([]byte, min(size, sendChunkSize))
	var lastTransfer int

	for size > 0 {
		toread := buf
		if int64(len(toread)) > size {
			toread = buf[:int(size)]
		}

		m, rerr := io.ReadFull(r, toread)
		if rerr != nil {
			// Modification : erreur de la source (client parti...) ->
			// retour immediat, SANS paquet nul final : pour un fichier
			// >= 4 Gio, le paquet nul ferait valider au telephone un
			// fichier tronque. La session est alors desynchronisee (Resync).
			return n, rerr
		}
		size -= int64(m)

		lastTransfer, err = d.h.BulkTransfer(d.c.sendEP, buf[:m], d.Timeout)
		n += int64(lastTransfer)

		if err != nil || lastTransfer == 0 {
			break
		}

		if err = progressCb(totalSize - size); err != nil {
			return size, err
		}
	}

	if lastTransfer%packetSize == 0 {
		// paquet court final, par securite (comme l'original)
		_, _ = d.h.BulkTransfer(d.c.sendEP, buf[:0], 250)
	}

	return n, err
}

func (d *transport) bulkRead(w io.Writer, progressCb mtp.ProgressFunc) (n int64, lastPacket []byte, err error) {
	var buf [rwBufSize]byte
	var lastRead int

	for {
		toread := buf[:]
		lastRead, err = d.h.BulkTransfer(d.c.fetchEP, toread, d.Timeout)
		if err != nil {
			break
		}

		if lastRead > 0 {
			w, err := w.Write(buf[:lastRead])
			n += int64(w)
			if err != nil {
				break
			}
		}

		if err = progressCb(n); err != nil {
			break
		}

		if lastRead < len(toread) {
			// lecture courte
			break
		}
	}
	packetSize := d.fetchMaxPacketSize()
	if lastRead%packetSize == 0 {
		// Normalement un paquet nul ; sous Linux + XHCI c'est parfois deja
		// la reponse : on la renvoie a l'appelant.
		var nullReadSize int
		nullReadSize, err = d.h.BulkTransfer(d.c.fetchEP, buf[:], d.Timeout)
		if err = progressCb(n); err != nil {
			return n, buf[:nullReadSize], err
		}
		return n, buf[:nullReadSize], err
	}

	return n, buf[:0], err
}

// --- operations (ops.go / android.go de go-mtpfs) ---

func (d *transport) OpenSession() error {
	if d.session != nil {
		return fmt.Errorf("session already open")
	}
	var req, rep mtp.Container
	req.Code = mtp.OC_OpenSession

	// eviter 0xFFFFFFFF et 0x00000000
	sid := uint32(rand.Int32()) | 1
	req.Param = []uint32{sid}

	// Pas de controles apres coup : on veut pouvoir reinitialiser
	// l'appareil si l'ouverture echoue.
	if err := d.runTransaction(&req, &rep, nil, nil, 0, emptyProgress); err != nil {
		return err
	}

	d.session = &sessionData{tid: 1, sid: sid}
	return nil
}

func (d *transport) CloseSession() error {
	var req, rep mtp.Container
	req.Code = mtp.OC_CloseSession
	err := d.RunTransaction(&req, &rep, nil, nil, 0)
	d.session = nil
	return err
}

// errDecode : la transaction a reussi mais la reponse n'a pas pu etre
// decodee (pas une erreur de synchronisation).
type errDecode struct{ err error }

func (e errDecode) Error() string { return "mtp: decode: " + e.err.Error() }
func (e errDecode) Unwrap() error { return e.err }

func (d *transport) GetData(req *mtp.Container, info any) error {
	var buf bytes.Buffer
	var rep mtp.Container
	if err := d.RunTransaction(req, &rep, &buf, nil, 0); err != nil {
		return err
	}
	if err := mtp.Decode(&buf, info); err != nil {
		return errDecode{err}
	}
	return nil
}

func (d *transport) SendData(req *mtp.Container, rep *mtp.Container, value any) error {
	var buf bytes.Buffer
	if err := mtp.Encode(&buf, value); err != nil {
		return err
	}
	return d.RunTransaction(req, rep, nil, &buf, int64(buf.Len()))
}

func (d *transport) GetDeviceInfo(info any) error {
	var req mtp.Container
	req.Code = mtp.OC_GetDeviceInfo
	return d.GetData(&req, info)
}

func (d *transport) GetStorageIDs(info *mtp.Uint32Array) error {
	var req mtp.Container
	req.Code = mtp.OC_GetStorageIDs
	return d.GetData(&req, info)
}

func (d *transport) GetStorageInfo(id uint32, info any) error {
	var req mtp.Container
	req.Code = mtp.OC_GetStorageInfo
	req.Param = []uint32{id}
	return d.GetData(&req, info)
}

func (d *transport) GetObjectHandles(storageID, objFormatCode, parent uint32, info *mtp.Uint32Array) error {
	var req mtp.Container
	req.Code = mtp.OC_GetObjectHandles
	req.Param = []uint32{storageID, objFormatCode, parent}
	return d.GetData(&req, info)
}

func (d *transport) GetObjectInfo(handle uint32, info any) error {
	var req mtp.Container
	req.Code = mtp.OC_GetObjectInfo
	req.Param = []uint32{handle}
	return d.GetData(&req, info)
}

func (d *transport) GetObjectPropValue(objHandle uint32, objPropCode uint16, value any) error {
	var req mtp.Container
	req.Code = mtp.OC_MTP_GetObjectPropValue
	req.Param = []uint32{objHandle, uint32(objPropCode)}
	return d.GetData(&req, value)
}

func (d *transport) SetObjectPropValue(objHandle uint32, objPropCode uint16, value any) error {
	var req, rep mtp.Container
	req.Code = mtp.OC_MTP_SetObjectPropValue
	req.Param = []uint32{objHandle, uint32(objPropCode)}
	return d.SendData(&req, &rep, value)
}

func (d *transport) DeleteObject(handle uint32) error {
	var req, rep mtp.Container
	req.Code = mtp.OC_DeleteObject
	req.Param = []uint32{handle, 0x0}
	return d.RunTransaction(&req, &rep, nil, nil, 0)
}

func (d *transport) SendObjectInfo(wantStorageID, wantParent uint32, info any) (storageID, parent, handle uint32, err error) {
	var req, rep mtp.Container
	req.Code = mtp.OC_SendObjectInfo
	req.Param = []uint32{wantStorageID, wantParent}

	if err = d.SendData(&req, &rep, info); err != nil {
		return
	}
	if len(rep.Param) < 3 {
		err = fmt.Errorf("SendObjectInfo: got %v, need 3 response parameters", rep.Param)
		return
	}
	return rep.Param[0], rep.Param[1], rep.Param[2], nil
}

func (d *transport) SendObject(r io.Reader, size int64) error {
	var req, rep mtp.Container
	req.Code = mtp.OC_SendObject
	return d.RunTransaction(&req, &rep, nil, r, size)
}

func (d *transport) GetObject(handle uint32, w io.Writer) error {
	var req, rep mtp.Container
	req.Code = mtp.OC_GetObject
	req.Param = []uint32{handle}
	return d.RunTransaction(&req, &rep, w, nil, 0)
}

// GetPartialObject : operation PTP 0x101B (offset 32 bits). Corrige :
// l'original envoyait le code Android 0x95C1 avec 3 parametres.
func (d *transport) GetPartialObject(handle uint32, w io.Writer, offset uint32, size uint32) error {
	var req, rep mtp.Container
	req.Code = mtp.OC_GetPartialObject
	req.Param = []uint32{handle, offset, size}
	return d.RunTransaction(&req, &rep, w, nil, 0)
}

// AndroidGetPartialObject64 lit une portion de fichier (offset 64 bits).
func (d *transport) AndroidGetPartialObject64(handle uint32, w io.Writer, offset int64, size uint32) error {
	var req, rep mtp.Container
	req.Code = mtp.OC_ANDROID_GET_PARTIAL_OBJECT64
	req.Param = []uint32{handle, uint32(offset & 0xFFFFFFFF), uint32(offset >> 32), size}
	return d.RunTransaction(&req, &rep, w, nil, 0)
}

// MoveObject (0x1019) : parent 0 = racine du stockage (spec MTP).
func (d *transport) MoveObject(handle, storageID, parent uint32) error {
	var req, rep mtp.Container
	req.Code = mtp.OC_MoveObject
	req.Param = []uint32{handle, storageID, parent}
	return d.RunTransaction(&req, &rep, nil, nil, 0)
}

// CopyObject (0x101A) : renvoie le handle de la copie.
func (d *transport) CopyObject(handle, storageID, parent uint32) (uint32, error) {
	var req, rep mtp.Container
	req.Code = mtp.OC_CopyObject
	req.Param = []uint32{handle, storageID, parent}
	if err := d.RunTransaction(&req, &rep, nil, nil, 0); err != nil {
		return 0, err
	}
	if len(rep.Param) < 1 {
		return 0, fmt.Errorf("CopyObject: no handle in response")
	}
	return rep.Param[0], nil
}
