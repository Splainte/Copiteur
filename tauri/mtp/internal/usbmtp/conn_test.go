//go:build cgo

package usbmtp

import (
	"bytes"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/ganeshrvel/go-mtpfs/mtp"
)

// Nos encodeurs UTF-16 doivent produire/lire exactement le format de
// go-mtpfs pour les chaines du plan de base.
func TestObjectInfoLayout(t *testing.T) {
	mod := time.Date(2024, 5, 6, 7, 8, 9, 0, time.Local)
	in := mtp.ObjectInfo{
		StorageID: 0x10001, ObjectFormat: mtp.OFC_Association, CompressedSize: 0xFFFFFFFF,
		ParentObject: 42, AssociationType: 1, Filename: "Vidéo très longue.mp4",
		ModificationDate: mod,
	}
	var ref bytes.Buffer
	if err := mtp.Encode(&ref, &in); err != nil {
		t.Fatal(err)
	}
	mine := sendObjectInfo{
		objectInfoFixed: objectInfoFixed{StorageID: 0x10001, ObjectFormat: mtp.OFC_Association,
			CompressedSize: 0xFFFFFFFF, ParentObject: 42, AssociationType: 1},
		Filename: in.Filename, ModificationDate: mod,
	}
	var got bytes.Buffer
	if err := mtp.Encode(&got, &mine); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(ref.Bytes(), got.Bytes()) {
		t.Fatalf("encoding differs from go-mtpfs:\n%x\n%x", ref.Bytes(), got.Bytes())
	}
	var out rawObjectInfo
	if err := mtp.Decode(&ref, &out); err != nil {
		t.Fatal(err)
	}
	if out.StorageID != in.StorageID || out.ObjectFormat != in.ObjectFormat || out.CompressedSize != in.CompressedSize ||
		out.ParentObject != 42 || out.Filename != in.Filename || out.CaptureDate != "" {
		t.Fatalf("decoded %+v", out)
	}
	if got := parseMTPDate(out.ModificationDate); !got.Equal(mod) {
		t.Fatalf("date %q -> %v, want %v", out.ModificationDate, got, mod)
	}
}

// Noms hors du plan de base (emoji) : aller-retour exact, et deux emoji
// differents restent differents (go-mtpfs les confondait).
func TestNonBMPNames(t *testing.T) {
	for _, name := range []string{"😀.jpg", "😁.jpg", "a𝄞b", "日本語"} {
		var b bytes.Buffer
		if err := mtp.Encode(&b, &sendObjectInfo{Filename: name}); err != nil {
			t.Fatal(err)
		}
		var o rawObjectInfo
		if err := mtp.Decode(&b, &o); err != nil {
			t.Fatal(err)
		}
		if o.Filename != name {
			t.Errorf("%q -> %q", name, o.Filename)
		}
		var sb bytes.Buffer
		if err := mtp.Encode(&sb, &mtpString{Value: name}); err != nil {
			t.Fatal(err)
		}
		var sv mtpString
		if err := mtp.Decode(&sb, &sv); err != nil || sv.Value != name {
			t.Errorf("mtpString %q -> %q (%v)", name, sv.Value, err)
		}
	}
	// 254 unites + NUL = 255 : accepte ; au-dela : refuse
	long := strings.Repeat("😀", 127) // 254 unites
	if err := encodeStr16(io.Discard, long); err != nil {
		t.Errorf("254 units: %v", err)
	}
	if err := encodeStr16(io.Discard, long+"a"); err == nil {
		t.Error("255 units accepted")
	}
}

func TestStorageAndDeviceInfoLayout(t *testing.T) {
	si := mtp.StorageInfo{StorageType: 3, FilesystemType: 2, AccessCapability: 0, MaxCapability: 1 << 40,
		FreeSpaceInBytes: 1 << 30, FreeSpaceInImages: 7, StorageDescription: "Espace de stockage interne partagé", VolumeLabel: "v"}
	var b bytes.Buffer
	if err := mtp.Encode(&b, &si); err != nil {
		t.Fatal(err)
	}
	var rs rawStorageInfo
	if err := mtp.Decode(&b, &rs); err != nil {
		t.Fatal(err)
	}
	if rs.Fixed.MaxCapability != si.MaxCapability || rs.Fixed.FreeSpaceInBytes != si.FreeSpaceInBytes ||
		rs.StorageDescription != si.StorageDescription || rs.VolumeLabel != "v" {
		t.Fatalf("storage %+v", rs)
	}
	di := mtp.DeviceInfo{StandardVersion: 100, MTPExtension: "microsoft.com: 1.0; android.com: 1.0;",
		OperationsSupported: []uint16{0x1001, 0x95C1}, EventsSupported: []uint16{0x4002},
		DevicePropertiesSupported: []uint16{}, CaptureFormats: []uint16{}, PlaybackFormats: []uint16{0x3000, 0x3001},
		Manufacturer: "Google", Model: "Pixel 9", DeviceVersion: "1.0", SerialNumber: "ABC123"}
	b.Reset()
	if err := mtp.Encode(&b, &di); err != nil {
		t.Fatal(err)
	}
	var rd rawDeviceInfo
	if err := mtp.Decode(&b, &rd); err != nil {
		t.Fatal(err)
	}
	if rd.MTPExtension != di.MTPExtension || len(rd.OperationsSupported) != 2 || rd.OperationsSupported[1] != 0x95C1 ||
		rd.Manufacturer != "Google" || rd.Model != "Pixel 9" || rd.SerialNumber != "ABC123" {
		t.Fatalf("device %+v", rd)
	}
}

func TestParseMTPDate(t *testing.T) {
	loc := time.Local
	cases := map[string]time.Time{
		"20240506T070809":      time.Date(2024, 5, 6, 7, 8, 9, 0, loc),
		"20240506T070809.0":    time.Date(2024, 5, 6, 7, 8, 9, 0, loc),
		"20240506T070809...":   time.Date(2024, 5, 6, 7, 8, 9, 0, loc), // Samsung
		"20240506T070809Z":     time.Date(2024, 5, 6, 7, 8, 9, 0, time.UTC),
		"20240506T070809+0200": time.Date(2024, 5, 6, 5, 8, 9, 0, time.UTC),
		"20240506T070809.5Z":   time.Date(2024, 5, 6, 7, 8, 9, 0, time.UTC),
		"":                     {},
		"garbage":              {},
		"20241399T999999":      {},
	}
	for in, want := range cases {
		if got := parseMTPDate(in); !got.Equal(want) {
			t.Errorf("%q -> %v, want %v", in, got, want)
		}
	}
}
