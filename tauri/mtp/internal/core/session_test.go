package core_test

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"

	"copiteur-mtp/internal/core"
	"copiteur-mtp/internal/fake"
)

type failingReader struct{ n int }

func (f *failingReader) Read(p []byte) (int, error) {
	if f.n <= 0 {
		return 0, io.ErrUnexpectedEOF
	}
	k := min(len(p), f.n)
	f.n -= k
	return k, nil
}

// Une requete dont les handles ont ete resolus avant un Resync (upload
// coupe ailleurs) doit echouer en ErrDesync (503), pas lire un autre objet.
func TestSessionPinnedAcrossResync(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "a.bin"), bytes.Repeat([]byte("a"), 5000), 0o644); err != nil {
		t.Fatal(err)
	}
	m, err := fake.NewManager(dir, fake.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	d := m.Device()
	d.MaxPad = 0 // upload coupe -> Resync

	ctx := d.Pin(context.Background())
	n, err := d.Resolve(ctx, "a.bin")
	if err != nil {
		t.Fatal(err)
	}
	// upload interrompu dans une autre requete -> Resync de la session
	_, err = d.Put(context.Background(), "b.bin", 10000, time.Now(), &failingReader{n: 100})
	if !errors.Is(err, core.ErrIncomplete) {
		t.Fatalf("interrupted Put: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "b.bin")); err == nil {
		t.Fatal("partial file left")
	}
	var buf bytes.Buffer
	if err := d.ReadRange(ctx, n, 0, 10, &buf); !errors.Is(err, core.ErrDesync) {
		t.Fatalf("stale request after Resync: %v", err)
	}
	if err := d.Delete(ctx, "a.bin"); !errors.Is(err, core.ErrDesync) {
		t.Fatalf("stale Delete after Resync: %v", err)
	}
	// une nouvelle requete fonctionne
	ctx2 := d.Pin(context.Background())
	n, err = d.Resolve(ctx2, "a.bin")
	if err != nil {
		t.Fatal(err)
	}
	buf.Reset()
	if err := d.ReadRange(ctx2, n, 0, 10, &buf); err != nil || buf.String() != "aaaaaaaaaa" {
		t.Fatalf("fresh request: %v %q", err, buf.String())
	}
}
