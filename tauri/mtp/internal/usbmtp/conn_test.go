//go:build cgo

package usbmtp

import (
	"bytes"
	"testing"
	"time"

	"github.com/ganeshrvel/go-mtpfs/mtp"
)

// rawObjectInfo doit avoir exactement la disposition binaire de
// mtp.ObjectInfo (seules les dates changent de type).
func TestRawObjectInfoLayout(t *testing.T) {
	mod := time.Date(2024, 5, 6, 7, 8, 9, 0, time.Local)
	in := mtp.ObjectInfo{
		StorageID: 0x10001, ObjectFormat: mtp.OFC_Association, CompressedSize: 0xFFFFFFFF,
		ParentObject: 42, AssociationType: 1, Filename: "Vidéo très longue.mp4",
		ModificationDate: mod, Keywords: "k",
	}
	var buf bytes.Buffer
	if err := mtp.Encode(&buf, &in); err != nil {
		t.Fatal(err)
	}
	var out rawObjectInfo
	if err := mtp.Decode(&buf, &out); err != nil {
		t.Fatal(err)
	}
	if out.StorageID != in.StorageID || out.ObjectFormat != in.ObjectFormat || out.CompressedSize != in.CompressedSize ||
		out.ParentObject != 42 || out.Filename != in.Filename || out.Keywords != "k" || out.CaptureDate != "" {
		t.Fatalf("decoded %+v", out)
	}
	if got := parseMTPDate(out.ModificationDate); !got.Equal(mod) {
		t.Fatalf("date %q -> %v, want %v", out.ModificationDate, got, mod)
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
