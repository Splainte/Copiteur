//go:build cgo

package usbmtp

// Chaines MTP en vrai UTF-16.
//
// L'encodeur/decodeur de go-mtpfs traite chaque unite UTF-16 comme une rune
// (encodeStr fait uint16(r), decodeStr fait rune(unite)) : les caracteres
// hors du plan de base (emoji...) sont corrompus. A l'envoi, le nom cree
// n'est pas celui demande (le PROPFIND de rclone apres le PUT echoue) ; a
// la reception, les deux moities d'une paire de substitution deviennent
// U+FFFD, si bien que "😀.jpg" et "😁.jpg" portent le meme nom et qu'un
// telechargement peut renvoyer le mauvais fichier. Les structures echangees
// qui contiennent des chaines (ObjectInfo, StorageInfo, DeviceInfo,
// ObjectFileName) passent donc par les encodeurs ci-dessous (interfaces
// mtp.Encoder / mtp.Decoder, appelees par mtp.Encode / mtp.Decode).
// Disposition binaire identique a celle de go-mtpfs (verifiee par test).

import (
	"encoding/binary"
	"errors"
	"io"
	"time"
	"unicode/utf16"
)

// Chaine MTP : 1 octet = nombre d'unites UTF-16 (NUL final compris, 255
// max), puis les unites en petit-boutiste. Chaine vide = un seul octet 0.
func encodeStr16(w io.Writer, s string) error {
	if s == "" {
		_, err := w.Write([]byte{0})
		return err
	}
	units := append(utf16.Encode([]rune(s)), 0)
	if len(units) > 255 {
		return errors.New("mtp: string too long")
	}
	buf := make([]byte, 1+2*len(units))
	buf[0] = byte(len(units))
	for i, u := range units {
		binary.LittleEndian.PutUint16(buf[1+2*i:], u)
	}
	_, err := w.Write(buf)
	return err
}

func decodeStr16(r io.Reader) (string, error) {
	var n [1]byte
	if _, err := io.ReadFull(r, n[:]); err != nil {
		return "", err
	}
	if n[0] == 0 {
		return "", nil
	}
	data := make([]byte, 2*int(n[0]))
	if _, err := io.ReadFull(r, data); err != nil {
		return "", err
	}
	units := make([]uint16, n[0])
	for i := range units {
		units[i] = binary.LittleEndian.Uint16(data[2*i:])
	}
	for len(units) > 0 && units[len(units)-1] == 0 {
		units = units[:len(units)-1]
	}
	return string(utf16.Decode(units)), nil
}

func decodeU16Array(r io.Reader) ([]uint16, error) {
	var n uint32
	if err := binary.Read(r, binary.LittleEndian, &n); err != nil {
		return nil, err
	}
	if n > 1<<16 {
		return nil, errors.New("mtp: array too long")
	}
	out := make([]uint16, n)
	err := binary.Read(r, binary.LittleEndian, out)
	return out, err
}

// mtpString : valeur de propriete chaine (ObjectFileName).
type mtpString struct{ Value string }

func (s *mtpString) Encode(w io.Writer) error { return encodeStr16(w, s.Value) }
func (s *mtpString) Decode(r io.Reader) (err error) {
	s.Value, err = decodeStr16(r)
	return err
}

// objectInfoFixed : partie numerique de l'ObjectInfo MTP.
type objectInfoFixed struct {
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
}

// rawObjectInfo : ObjectInfo recu. Les dates restent des chaines (le
// decodeur d'origine echoue sur une date qu'il ne sait pas lire, et fait
// alors echouer tout GetObjectInfo).
type rawObjectInfo struct {
	objectInfoFixed
	Filename         string
	CaptureDate      string
	ModificationDate string
	Keywords         string
}

// Decode implemente mtp.Decoder. Tolerant : une erreur apres le nom (dates,
// mots-cles absents) est renvoyee mais les champs deja lus restent valides.
func (o *rawObjectInfo) Decode(r io.Reader) error {
	if err := binary.Read(r, binary.LittleEndian, &o.objectInfoFixed); err != nil {
		return err
	}
	for _, p := range []*string{&o.Filename, &o.CaptureDate, &o.ModificationDate, &o.Keywords} {
		s, err := decodeStr16(r)
		if err != nil {
			return err
		}
		*p = s
	}
	return nil
}

// sendObjectInfo : ObjectInfo envoye (SendObjectInfo).
type sendObjectInfo struct {
	objectInfoFixed
	Filename         string
	ModificationDate time.Time
}

// Encode implemente mtp.Encoder (meme format de date que go-mtpfs).
func (o *sendObjectInfo) Encode(w io.Writer) error {
	if err := binary.Write(w, binary.LittleEndian, &o.objectInfoFixed); err != nil {
		return err
	}
	date := ""
	if !o.ModificationDate.IsZero() {
		date = o.ModificationDate.Format("20060102T150405")
	}
	for _, s := range []string{o.Filename, "", date, ""} {
		if err := encodeStr16(w, s); err != nil {
			return err
		}
	}
	return nil
}

// rawStorageInfo : StorageInfo recu.
type rawStorageInfo struct {
	Fixed struct {
		StorageType       uint16
		FilesystemType    uint16
		AccessCapability  uint16
		MaxCapability     uint64
		FreeSpaceInBytes  uint64
		FreeSpaceInImages uint32
	}
	StorageDescription string
	VolumeLabel        string
}

func (s *rawStorageInfo) Decode(r io.Reader) (err error) {
	if err = binary.Read(r, binary.LittleEndian, &s.Fixed); err != nil {
		return err
	}
	if s.StorageDescription, err = decodeStr16(r); err != nil {
		return err
	}
	s.VolumeLabel, err = decodeStr16(r)
	return err
}

// rawDeviceInfo : DeviceInfo recu (champs utiles seulement).
type rawDeviceInfo struct {
	MTPExtension        string
	OperationsSupported []uint16
	Manufacturer        string
	Model               string
	DeviceVersion       string
	SerialNumber        string
}

func (d *rawDeviceInfo) Decode(r io.Reader) (err error) {
	var head struct {
		StandardVersion      uint16
		MTPVendorExtensionID uint32
		MTPVersion           uint16
	}
	if err = binary.Read(r, binary.LittleEndian, &head); err != nil {
		return err
	}
	if d.MTPExtension, err = decodeStr16(r); err != nil {
		return err
	}
	var mode uint16
	if err = binary.Read(r, binary.LittleEndian, &mode); err != nil {
		return err
	}
	if d.OperationsSupported, err = decodeU16Array(r); err != nil {
		return err
	}
	// EventsSupported, DevicePropertiesSupported, CaptureFormats,
	// PlaybackFormats : ignores
	for range 4 {
		if _, err = decodeU16Array(r); err != nil {
			return err
		}
	}
	for _, p := range []*string{&d.Manufacturer, &d.Model, &d.DeviceVersion, &d.SerialNumber} {
		if *p, err = decodeStr16(r); err != nil {
			return err
		}
	}
	return nil
}
