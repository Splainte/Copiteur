package server

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/text/unicode/norm"

	"copiteur-mtp/internal/core"
	"copiteur-mtp/internal/fake"
)

const testToken = "0123456789abcdef0123456789abcdef-test"

type env struct {
	t   *testing.T
	dir string
	srv *httptest.Server
	dev *core.Device
}

func newEnv(t *testing.T, opts fake.Options, setup func(dir string)) *env {
	t.Helper()
	dir := t.TempDir()
	if setup != nil {
		setup(dir)
	}
	m, err := fake.NewManager(dir, opts)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(New(testToken, m))
	t.Cleanup(func() {
		srv.Close()
		m.Close()
	})
	return &env{t: t, dir: dir, srv: srv, dev: m.Device()}
}

func (e *env) url(p string) string {
	return e.srv.URL + "/dav/" + fake.DeviceID + "/" + strings.TrimPrefix(p, "/")
}

type resp struct {
	code int
	body []byte
	hdr  http.Header
}

func (e *env) do(method, url string, hdr map[string]string, body io.Reader) resp {
	e.t.Helper()
	req, err := http.NewRequest(method, url, body)
	if err != nil {
		e.t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+testToken)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	if b, ok := body.(*bytes.Reader); ok {
		req.ContentLength = int64(b.Len())
	}
	r, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatalf("%s %s: %v", method, url, err)
	}
	defer r.Body.Close()
	b, err := io.ReadAll(r.Body)
	if err != nil {
		e.t.Fatalf("%s %s: read body: %v", method, url, err)
	}
	return resp{code: r.StatusCode, body: b, hdr: r.Header}
}

func (e *env) dav(method, p string, hdr map[string]string, body []byte) resp {
	e.t.Helper()
	var rd io.Reader
	if body != nil {
		rd = bytes.NewReader(body)
	}
	return e.do(method, e.url(p), hdr, rd)
}

func (e *env) write(rel string, data []byte) {
	e.t.Helper()
	p := filepath.Join(e.dir, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		e.t.Fatal(err)
	}
	if err := os.WriteFile(p, data, 0o644); err != nil {
		e.t.Fatal(err)
	}
}

func (e *env) read(rel string) ([]byte, bool) {
	b, err := os.ReadFile(filepath.Join(e.dir, filepath.FromSlash(rel)))
	return b, err == nil
}

func (e *env) exists(rel string) bool {
	_, err := os.Stat(filepath.Join(e.dir, filepath.FromSlash(rel)))
	return err == nil
}

func expect(t *testing.T, r resp, code int) {
	t.Helper()
	if r.code != code {
		t.Fatalf("status %d, want %d (body %q)", r.code, code, r.body)
	}
}

func randBytes(n int) []byte {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return b
}

// multistatus minimal pour les tests
type msResponse struct {
	Href string `xml:"href"`
	Prop struct {
		DisplayName  string    `xml:"displayname"`
		Length       string    `xml:"getcontentlength"`
		LastModified string    `xml:"getlastmodified"`
		Collection   *struct{} `xml:"resourcetype>collection"`
		QuotaAvail   string    `xml:"quota-available-bytes"`
		QuotaUsed    string    `xml:"quota-used-bytes"`
	} `xml:"propstat>prop"`
	Status string `xml:"propstat>status"`
}

func parseMS(t *testing.T, b []byte) []msResponse {
	t.Helper()
	var ms struct {
		Responses []msResponse `xml:"response"`
	}
	if err := xml.Unmarshal(b, &ms); err != nil {
		t.Fatalf("bad XML: %v\n%s", err, b)
	}
	return ms.Responses
}

func TestAuth(t *testing.T) {
	e := newEnv(t, fake.Options{}, nil)
	for _, h := range []string{"", "Bearer wrong", "Basic " + testToken, "Bearer " + testToken + "x"} {
		req, _ := http.NewRequest("GET", e.srv.URL+"/api/devices", nil)
		if h != "" {
			req.Header.Set("Authorization", h)
		}
		r, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		r.Body.Close()
		if r.StatusCode != 401 {
			t.Errorf("Authorization %q: status %d, want 401", h, r.StatusCode)
		}
	}
	// DAV aussi
	req, _ := http.NewRequest("PROPFIND", e.url(""), nil)
	r, _ := http.DefaultClient.Do(req)
	r.Body.Close()
	if r.StatusCode != 401 {
		t.Errorf("PROPFIND without token: %d", r.StatusCode)
	}
}

func TestDevicesAPI(t *testing.T) {
	e := newEnv(t, fake.Options{Name: "Pixel test"}, nil)
	r := e.do("GET", e.srv.URL+"/api/devices", nil, nil)
	expect(t, r, 200)
	var raw []map[string]any
	if err := json.Unmarshal(r.body, &raw); err != nil {
		t.Fatal(err)
	}
	if len(raw) != 1 {
		t.Fatalf("got %d devices", len(raw))
	}
	for _, k := range []string{"id", "name", "manufacturer", "state", "error", "storages"} {
		if _, ok := raw[0][k]; !ok {
			t.Errorf("missing field %q in %s", k, r.body)
		}
	}
	if raw[0]["id"] != fake.DeviceID || raw[0]["state"] != "ready" || raw[0]["name"] != "Pixel test" {
		t.Errorf("unexpected device %s", r.body)
	}
	st := raw[0]["storages"].([]any)[0].(map[string]any)
	if st["name"] == "" || st["total"].(float64) <= 0 || st["free"].(float64) <= 0 {
		t.Errorf("bad storage %v", st)
	}
	expect(t, e.do("POST", e.srv.URL+"/api/devices/"+fake.DeviceID+"/retry", nil, nil), 202)
	expect(t, e.do("POST", e.srv.URL+"/api/devices/nope/retry", nil, nil), 404)
	// apres le retry l'appareil redevient pret
	deadline := time.Now().Add(3 * time.Second)
	for e.dev.State() != core.StateReady && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	expect(t, e.dav("PROPFIND", "", map[string]string{"Depth": "0"}, nil), 207)
	// appareil inconnu
	expect(t, e.do("PROPFIND", e.srv.URL+"/dav/unknown/", nil, nil), 503)
}

func TestPropfind(t *testing.T) {
	e := newEnv(t, fake.Options{}, nil)
	e.write("a b/é#?.txt", []byte("hello"))
	e.write("top.bin", randBytes(1234))
	expect(t, e.dav("PROPFIND", "", map[string]string{"Depth": "infinity"}, nil), 403)

	r := e.dav("PROPFIND", "", map[string]string{"Depth": "1"}, nil)
	expect(t, r, 207)
	ms := parseMS(t, r.body)
	if len(ms) != 3 {
		t.Fatalf("got %d responses: %s", len(ms), r.body)
	}
	if ms[0].Href != "/dav/"+fake.DeviceID+"/" || ms[0].Prop.Collection == nil || ms[0].Prop.QuotaAvail == "" || ms[0].Prop.QuotaUsed == "" {
		t.Errorf("bad root response %+v", ms[0])
	}
	found := map[string]msResponse{}
	for _, m := range ms[1:] {
		found[m.Href] = m
		if !strings.Contains(m.Status, "200") {
			t.Errorf("status %q", m.Status)
		}
		if _, err := time.Parse(http.TimeFormat, m.Prop.LastModified); err != nil {
			t.Errorf("bad date %q", m.Prop.LastModified)
		}
	}
	dirHref := "/dav/" + fake.DeviceID + "/a%20b/"
	if d, ok := found[dirHref]; !ok || d.Prop.Collection == nil {
		t.Errorf("folder missing or not a collection: %v", found)
	}
	if f, ok := found["/dav/"+fake.DeviceID+"/top.bin"]; !ok || f.Prop.Length != "1234" || f.Prop.Collection != nil {
		t.Errorf("file missing: %v", found)
	}

	// enfant au nom special, adresse encodee
	r = e.dav("PROPFIND", "a%20b/", map[string]string{"Depth": "1"}, nil)
	expect(t, r, 207)
	ms = parseMS(t, r.body)
	if len(ms) != 2 || ms[1].Href != "/dav/"+fake.DeviceID+"/a%20b/%C3%A9%23%3F.txt" || ms[1].Prop.DisplayName != "é#?.txt" {
		t.Fatalf("bad listing %s", r.body)
	}
	// Depth 0 sur un fichier (rclone apres un PUT)
	r = e.dav("PROPFIND", "a%20b/%C3%A9%23%3F.txt", map[string]string{"Depth": "0"}, nil)
	expect(t, r, 207)
	if ms = parseMS(t, r.body); len(ms) != 1 || ms[0].Prop.Length != "5" {
		t.Fatalf("bad file propfind %s", r.body)
	}
	// Depth 1 sur un fichier : juste le fichier
	r = e.dav("PROPFIND", "top.bin", map[string]string{"Depth": "1"}, nil)
	expect(t, r, 207)
	if ms = parseMS(t, r.body); len(ms) != 1 {
		t.Fatalf("bad file propfind depth 1: %s", r.body)
	}
	expect(t, e.dav("PROPFIND", "nope/", map[string]string{"Depth": "1"}, nil), 404)
	expect(t, e.dav("PROPFIND", "top.bin/x", map[string]string{"Depth": "1"}, nil), 404)
	r = e.dav("OPTIONS", "", nil, nil)
	expect(t, r, 200)
	if r.hdr.Get("DAV") != "1" {
		t.Errorf("DAV header %q", r.hdr.Get("DAV"))
	}
}

func TestGetRanges(t *testing.T) {
	for _, mode := range []string{"partial", "chunked", "whole"} {
		t.Run(mode, func(t *testing.T) {
			opts := fake.Options{}
			if mode == "whole" {
				opts.NoPartial = true
			}
			e := newEnv(t, opts, nil)
			if mode == "chunked" {
				e.dev.ChunkSize = 4096 // force plusieurs blocs
			}
			data := randBytes(100_000)
			e.write("f.bin", data)
			e.write("empty", nil)
			size := len(data)
			cases := []struct {
				rng        string
				code       int
				start, end int // end exclusif
			}{
				{"", 200, 0, size},
				{"bytes=0-0", 206, 0, 1},
				{"bytes=10-19", 206, 10, 20},
				{"bytes=4000-9000", 206, 4000, 9001},
				{"bytes=-5", 206, size - 5, size},
				{"bytes=-200000", 206, 0, size},
				{"bytes=99990-", 206, 99990, size},
				{"bytes=99990-200000", 206, 99990, size},
				{"bytes=0-", 206, 0, size},
				{fmt.Sprintf("bytes=%d-", size), 416, 0, 0},
				{"bytes=-0", 416, 0, 0},
				{"bytes=0-1,5-6", 200, 0, size},
				{"bytes=abc", 200, 0, size},
				{"bytes=20-10", 200, 0, size},
			}
			for _, c := range cases {
				hdr := map[string]string{}
				if c.rng != "" {
					hdr["Range"] = c.rng
				}
				r := e.dav("GET", "f.bin", hdr, nil)
				if r.code != c.code {
					t.Fatalf("%q: status %d want %d", c.rng, r.code, c.code)
				}
				if c.code == 416 {
					if r.hdr.Get("Content-Range") != fmt.Sprintf("bytes */%d", size) {
						t.Errorf("%q: Content-Range %q", c.rng, r.hdr.Get("Content-Range"))
					}
					continue
				}
				if !bytes.Equal(r.body, data[c.start:c.end]) {
					t.Fatalf("%q: wrong body (%d bytes)", c.rng, len(r.body))
				}
				if r.hdr.Get("Content-Length") != fmt.Sprint(c.end-c.start) {
					t.Errorf("%q: Content-Length %q", c.rng, r.hdr.Get("Content-Length"))
				}
				if c.code == 206 {
					want := fmt.Sprintf("bytes %d-%d/%d", c.start, c.end-1, size)
					if r.hdr.Get("Content-Range") != want {
						t.Errorf("%q: Content-Range %q want %q", c.rng, r.hdr.Get("Content-Range"), want)
					}
				}
				if _, err := time.Parse(http.TimeFormat, r.hdr.Get("Last-Modified")); err != nil {
					t.Errorf("Last-Modified %q", r.hdr.Get("Last-Modified"))
				}
			}
			r := e.dav("HEAD", "f.bin", map[string]string{"Range": "bytes=5-9"}, nil)
			if r.code != 206 || len(r.body) != 0 || r.hdr.Get("Content-Length") != "5" {
				t.Errorf("HEAD range: %d %q %q", r.code, r.hdr.Get("Content-Length"), r.body)
			}
			r = e.dav("GET", "empty", map[string]string{"Range": "bytes=0-"}, nil)
			if r.code != 200 || len(r.body) != 0 {
				t.Errorf("empty file: %d %d", r.code, len(r.body))
			}
			expect(t, e.dav("GET", "missing", nil, nil), 404)
			expect(t, e.dav("GET", "", nil, nil), 405)
		})
	}
}

func TestPut(t *testing.T) {
	e := newEnv(t, fake.Options{}, nil)
	e.write("dir/x", nil)
	data := randBytes(70_000)
	expect(t, e.dav("PUT", "new.bin", nil, data), 201)
	if b, _ := e.read("new.bin"); !bytes.Equal(b, data) {
		t.Fatal("content mismatch")
	}
	// remplacement : MTP ne sait pas ecraser, le serveur supprime d'abord
	data2 := randBytes(10)
	expect(t, e.dav("PUT", "new.bin", nil, data2), 204)
	if b, _ := e.read("new.bin"); !bytes.Equal(b, data2) {
		t.Fatal("overwrite content mismatch")
	}
	// la liste reflete tout de suite la nouvelle taille
	r := e.dav("PROPFIND", "new.bin", map[string]string{"Depth": "0"}, nil)
	if ms := parseMS(t, r.body); ms[0].Prop.Length != "10" {
		t.Errorf("stale size %s", ms[0].Prop.Length)
	}
	// 0 octet
	expect(t, e.dav("PUT", "zero", nil, []byte{}), 201)
	if b, ok := e.read("zero"); !ok || len(b) != 0 {
		t.Fatal("zero-byte file")
	}
	// sans Content-Length (chunked)
	data3 := randBytes(300_000)
	req, _ := http.NewRequest("PUT", e.url("chunked.bin"), io.MultiReader(bytes.NewReader(data3[:1000]), bytes.NewReader(data3[1000:])))
	req.Header.Set("Authorization", "Bearer "+testToken)
	req.ContentLength = -1
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 201 {
		t.Fatalf("chunked PUT: %d", res.StatusCode)
	}
	if b, _ := e.read("chunked.bin"); !bytes.Equal(b, data3) {
		t.Fatal("chunked content mismatch")
	}
	// parent absent -> 409, PUT sur un dossier -> 409, nom invalide
	expect(t, e.dav("PUT", "no/such/file", nil, data2), 409)
	expect(t, e.dav("PUT", "dir", nil, data2), 409)
	expect(t, e.dav("PUT", "", nil, data2), 403)
	// dans un sous-dossier
	expect(t, e.dav("PUT", "dir/y.txt", nil, []byte("yy")), 201)
	if b, _ := e.read("dir/y.txt"); string(b) != "yy" {
		t.Fatal("subfolder PUT")
	}
}

func TestStoreFull(t *testing.T) {
	e := newEnv(t, fake.Options{Capacity: 1000}, nil)
	expect(t, e.dav("PUT", "big", nil, randBytes(2000)), 507)
	if e.exists("big") {
		t.Fatal("object left behind")
	}
	expect(t, e.dav("PUT", "small", nil, randBytes(100)), 201)
}

// putInterrupted envoie un PUT annoncant total octets mais n'en envoie que
// sent, puis coupe la connexion.
func putInterrupted(t *testing.T, e *env, p string, total, sent int) {
	t.Helper()
	conn, err := net.Dial("tcp", strings.TrimPrefix(e.srv.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	fmt.Fprintf(conn, "PUT /dav/%s/%s HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer %s\r\nContent-Length: %d\r\n\r\n", fake.DeviceID, p, testToken, total)
	_, _ = conn.Write(randBytes(sent))
	time.Sleep(100 * time.Millisecond)
	conn.Close()
}

func TestInterruptedUpload(t *testing.T) {
	for _, mode := range []string{"padded", "resync"} {
		t.Run(mode, func(t *testing.T) {
			e := newEnv(t, fake.Options{}, nil)
			if mode == "resync" {
				e.dev.MaxPad = 0
			}
			e.write("keep.txt", []byte("keep"))
			putInterrupted(t, e, "partial.bin", 5_000_000, 100_000)
			// le serveur termine la requete en arriere-plan
			deadline := time.Now().Add(5 * time.Second)
			for e.exists("partial.bin") && time.Now().Before(deadline) {
				time.Sleep(20 * time.Millisecond)
			}
			// attendre que le verrou soit libere (requete finie)
			r := e.dav("PROPFIND", "", map[string]string{"Depth": "1"}, nil)
			expect(t, r, 207)
			if e.exists("partial.bin") {
				t.Fatal("partial object not cleaned up")
			}
			if strings.Contains(string(r.body), "partial.bin") {
				t.Fatal("partial object still listed")
			}
			if e.dev.State() != core.StateReady {
				t.Fatalf("device state %s", e.dev.State())
			}
			// l'appareil repond toujours normalement
			expect(t, e.dav("PUT", "after.bin", nil, []byte("ok")), 201)
			r = e.dav("GET", "keep.txt", nil, nil)
			if r.code != 200 || string(r.body) != "keep" {
				t.Fatalf("after interrupted upload: %d %q", r.code, r.body)
			}
		})
	}
}

func TestMkcolDelete(t *testing.T) {
	for _, mode := range []string{"recursive", "manual"} {
		t.Run(mode, func(t *testing.T) {
			e := newEnv(t, fake.Options{NoRecursiveDelete: mode == "manual"}, nil)
			expect(t, e.dav("MKCOL", "d1/", nil, nil), 201)
			expect(t, e.dav("MKCOL", "d1", nil, nil), 405)
			expect(t, e.dav("MKCOL", "x/y/", nil, nil), 409)
			expect(t, e.dav("MKCOL", "d1/sub", nil, nil), 201)
			expect(t, e.dav("PUT", "d1/sub/f", nil, []byte("1")), 201)
			expect(t, e.dav("PUT", "d1/g", nil, []byte("2")), 201)
			if !e.exists("d1/sub/f") {
				t.Fatal("tree not created")
			}
			expect(t, e.dav("DELETE", "d1/g", nil, nil), 204)
			expect(t, e.dav("DELETE", "d1/g", nil, nil), 404)
			expect(t, e.dav("DELETE", "d1/", nil, nil), 204)
			if e.exists("d1") {
				t.Fatal("folder not deleted")
			}
			expect(t, e.dav("PROPFIND", "d1/", map[string]string{"Depth": "1"}, nil), 404)
			expect(t, e.dav("DELETE", "", nil, nil), 403)
		})
	}
}

func TestMove(t *testing.T) {
	for _, mode := range []string{"native", "fallback"} {
		t.Run(mode, func(t *testing.T) {
			e := newEnv(t, fake.Options{NoMove: mode == "fallback", NoCopy: mode == "fallback"}, nil)
			dest := func(p string) map[string]string {
				return map[string]string{"Destination": e.url(p)}
			}
			e.write("a.txt", []byte("A"))
			e.write("sub/keep", []byte("K"))
			// renommage dans le meme dossier
			expect(t, e.dav("MOVE", "a.txt", dest("b.txt"), nil), 201)
			if b, _ := e.read("b.txt"); string(b) != "A" || e.exists("a.txt") {
				t.Fatal("rename failed")
			}
			// vers un sous-dossier, sous un autre nom ; Destination en chemin seul
			expect(t, e.dav("MOVE", "b.txt", map[string]string{"Destination": "/dav/" + fake.DeviceID + "/sub/c.txt"}, nil), 201)
			if b, _ := e.read("sub/c.txt"); string(b) != "A" || e.exists("b.txt") {
				t.Fatal("move into subfolder failed")
			}
			// Overwrite F -> 412 ; T -> 204
			e.write("o.txt", []byte("O"))
			expect(t, e.dav("MOVE", "o.txt", map[string]string{"Destination": e.url("sub/c.txt"), "Overwrite": "F"}, nil), 412)
			expect(t, e.dav("MOVE", "o.txt", map[string]string{"Destination": e.url("sub/c.txt"), "Overwrite": "T"}, nil), 204)
			if b, _ := e.read("sub/c.txt"); string(b) != "O" || e.exists("o.txt") {
				t.Fatal("overwrite move failed")
			}
			// dossier vers un autre dossier (avec renommage)
			e.write("folder/inner/z", []byte("Z"))
			expect(t, e.dav("MKCOL", "target", nil, nil), 201)
			expect(t, e.dav("MOVE", "folder/", map[string]string{"Destination": e.url("target/moved/")}, nil), 201)
			if b, _ := e.read("target/moved/inner/z"); string(b) != "Z" || e.exists("folder") {
				t.Fatal("folder move failed")
			}
			// dans un dossier ou le nom d'origine existe deja
			e.write("n.txt", []byte("N"))
			e.write("target/n.txt", []byte("other"))
			expect(t, e.dav("MOVE", "n.txt", dest("target/n2.txt"), nil), 201)
			if b, _ := e.read("target/n2.txt"); string(b) != "N" {
				t.Fatal("move with name clash")
			}
			if b, _ := e.read("target/n.txt"); string(b) != "other" {
				t.Fatal("clashing file damaged")
			}
			// erreurs
			expect(t, e.dav("MOVE", "target/", dest("target/moved/x/"), nil), 403)
			expect(t, e.dav("MOVE", "nope", dest("x"), nil), 404)
			expect(t, e.dav("MOVE", "target/n2.txt", dest("nodir/x"), nil), 409)
			expect(t, e.dav("MOVE", "target/n2.txt", map[string]string{"Destination": e.srv.URL + "/dav/other/x"}, nil), 502)
			expect(t, e.dav("MOVE", "target/n2.txt", nil, nil), 400)
		})
	}
}

func TestCopy(t *testing.T) {
	for _, mode := range []string{"native", "fallback"} {
		t.Run(mode, func(t *testing.T) {
			e := newEnv(t, fake.Options{NoCopy: mode == "fallback"}, nil)
			e.dev.ChunkSize = 10_000
			data := randBytes(123_456)
			e.write("src.bin", data)
			e.write("d/x", nil)
			expect(t, e.dav("COPY", "src.bin", map[string]string{"Destination": e.url("d/src.bin")}, nil), 201)
			expect(t, e.dav("COPY", "src.bin", map[string]string{"Destination": e.url("d/renamed.bin")}, nil), 201)
			expect(t, e.dav("COPY", "src.bin", map[string]string{"Destination": e.url("same-folder.bin")}, nil), 201)
			for _, p := range []string{"src.bin", "d/src.bin", "d/renamed.bin", "same-folder.bin"} {
				if b, _ := e.read(p); !bytes.Equal(b, data) {
					t.Fatalf("%s: content mismatch", p)
				}
			}
			expect(t, e.dav("COPY", "src.bin", map[string]string{"Destination": e.url("d/x"), "Overwrite": "F"}, nil), 412)
			expect(t, e.dav("COPY", "src.bin", map[string]string{"Destination": e.url("d/x")}, nil), 204)
			if b, _ := e.read("d/x"); !bytes.Equal(b, data) {
				t.Fatal("overwrite copy")
			}
			expect(t, e.dav("COPY", "d/", map[string]string{"Destination": e.url("d2/")}, nil), 501)
		})
	}
}

func TestMultiStorage(t *testing.T) {
	e := newEnv(t, fake.Options{}, func(dir string) {
		_ = os.WriteFile(filepath.Join(dir, fake.MarkerTwoStorages), nil, 0o644)
	})
	r := e.dav("PROPFIND", "", map[string]string{"Depth": "1"}, nil)
	expect(t, r, 207)
	ms := parseMS(t, r.body)
	if len(ms) != 3 {
		t.Fatalf("root: %s", r.body)
	}
	names := []string{ms[1].Prop.DisplayName, ms[2].Prop.DisplayName}
	if names[0] != "Espace de stockage interne partagé" || names[1] != "Carte SD" {
		t.Fatalf("storage names %v", names)
	}
	if ms[1].Prop.Collection == nil || ms[0].Prop.QuotaAvail == "" {
		t.Fatal("storages must be collections, root must have quota")
	}
	expect(t, e.dav("PUT", "Carte%20SD/photo.jpg", nil, []byte("jpg")), 201)
	if b, _ := e.read("sd/photo.jpg"); string(b) != "jpg" {
		t.Fatal("PUT in second storage")
	}
	expect(t, e.dav("PUT", "root.txt", nil, []byte("x")), 403)
	expect(t, e.dav("MKCOL", "Carte%20SD/dir", nil, nil), 201)
	expect(t, e.dav("MKCOL", "Carte%20SD/", nil, nil), 405)
	expect(t, e.dav("MKCOL", "", nil, nil), 405)
	// deplacement entre stockages
	expect(t, e.dav("MOVE", "Carte%20SD/photo.jpg", map[string]string{"Destination": e.url("Espace%20de%20stockage%20interne%20partag%C3%A9/photo.jpg")}, nil), 201)
	if b, _ := e.read("interne/photo.jpg"); string(b) != "jpg" || e.exists("sd/photo.jpg") {
		t.Fatal("cross-storage move")
	}
	expect(t, e.dav("DELETE", "Carte%20SD/", nil, nil), 403)
	r = e.do("GET", e.srv.URL+"/api/devices", nil, nil)
	var st []core.Status
	_ = json.Unmarshal(r.body, &st)
	if len(st[0].Storages) != 2 {
		t.Fatalf("api storages %s", r.body)
	}
}

// Requetes concurrentes : le faux appareil echoue si deux transactions se
// chevauchent ; aucune ne doit donc echouer.
func TestConcurrency(t *testing.T) {
	e := newEnv(t, fake.Options{Delay: time.Millisecond}, nil)
	e.dev.ChunkSize = 64 << 10
	data := randBytes(2 << 20)
	e.write("big.bin", data)
	for i := range 20 {
		e.write(fmt.Sprintf("dir%d/f", i%4), []byte("x"))
	}
	var wg sync.WaitGroup
	errs := make(chan string, 100)
	for i := range 12 {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			switch i % 3 {
			case 0:
				r := e.dav("GET", "big.bin", nil, nil)
				if r.code != 200 || !bytes.Equal(r.body, data) {
					errs <- fmt.Sprintf("GET %d", r.code)
				}
			case 1:
				r := e.dav("PROPFIND", fmt.Sprintf("dir%d/", i%4), map[string]string{"Depth": "1"}, nil)
				if r.code != 207 {
					errs <- fmt.Sprintf("PROPFIND %d %s", r.code, r.body)
				}
			case 2:
				r := e.dav("PUT", fmt.Sprintf("dir%d/new%d", i%4, i), nil, randBytes(50_000))
				if r.code != 201 {
					errs <- fmt.Sprintf("PUT %d %s", r.code, r.body)
				}
			}
		}(i)
	}
	wg.Wait()
	close(errs)
	for s := range errs {
		t.Error(s)
	}
}

// Noms : NFD (rclone sur macOS) normalise en NFC, emoji distincts, limites
// de longueur.
func TestNames(t *testing.T) {
	e := newEnv(t, fake.Options{}, nil)
	nfd := norm.NFD.String("Été à Noël.jpg")
	nfc := norm.NFC.String(nfd)
	if nfd == nfc {
		t.Fatal("test setup: NFD == NFC")
	}
	expect(t, e.dav("PUT", url.PathEscape(nfd), nil, []byte("nfd")), 201)
	if !e.exists(nfc) || e.exists(nfd) {
		t.Fatal("name not stored in NFC")
	}
	// relu par son nom NFD comme NFC, et remplace (pas de doublon)
	if r := e.dav("GET", url.PathEscape(nfd), nil, nil); r.code != 200 || string(r.body) != "nfd" {
		t.Fatalf("GET NFD: %d", r.code)
	}
	expect(t, e.dav("PUT", url.PathEscape(nfd), nil, []byte("v2")), 204)
	// fichier NFD deja present sur le telephone : trouve par un chemin NFC
	e.write(norm.NFD.String("déjà.txt"), []byte("old"))
	if r := e.dav("GET", url.PathEscape("déjà.txt"), nil, nil); r.code != 200 || string(r.body) != "old" {
		t.Fatalf("GET NFC of NFD file: %d", r.code)
	}
	// emoji : deux noms differents restent deux fichiers differents
	expect(t, e.dav("PUT", url.PathEscape("😀.jpg"), nil, []byte("grin")), 201)
	expect(t, e.dav("PUT", url.PathEscape("😁.jpg"), nil, []byte("beam")), 201)
	if r := e.dav("GET", url.PathEscape("😁.jpg"), nil, nil); string(r.body) != "beam" {
		t.Fatalf("emoji collision: %q", r.body)
	}
	// limites : 253 unites UTF-16 / 255 octets
	expect(t, e.dav("PUT", strings.Repeat("a", 253), nil, []byte("x")), 201)
	expect(t, e.dav("PUT", strings.Repeat("b", 254), nil, []byte("x")), 400)
	expect(t, e.dav("PUT", url.PathEscape(strings.Repeat("é", 128)), nil, []byte("x")), 400) // 256 octets
	expect(t, e.dav("MKCOL", url.PathEscape(strings.Repeat("😀", 127)), nil, nil), 400)       // 254 unites
}

// Gros dossier : apres une modification, seul le nouvel objet est relu
// (difference de handles), et les renommages/suppressions restent justes.
func TestIncrementalListing(t *testing.T) {
	var calls atomic.Int64
	e := newEnv(t, fake.Options{InfoCalls: &calls}, func(dir string) {
		for i := range 40 {
			_ = os.MkdirAll(filepath.Join(dir, "cam"), 0o755)
			_ = os.WriteFile(filepath.Join(dir, "cam", fmt.Sprintf("IMG_%03d.jpg", i)), []byte("x"), 0o644)
		}
	})
	e.dev.IncrementalMin = 10
	count := func() int {
		r := e.dav("PROPFIND", "cam/", map[string]string{"Depth": "1"}, nil)
		expect(t, r, 207)
		return len(parseMS(t, r.body)) - 1
	}
	if n := count(); n != 40 {
		t.Fatalf("got %d", n)
	}
	before := calls.Load()
	expect(t, e.dav("PUT", "cam/new.jpg", nil, []byte("n")), 201)
	if n := count(); n != 41 {
		t.Fatalf("after PUT: %d", n)
	}
	if d := calls.Load() - before; d > 3 {
		t.Errorf("%d GetObjectInfo after one PUT in a big folder (want only the new object)", d)
	}
	// renommage : l'objet garde son handle, son nom doit changer
	expect(t, e.dav("MOVE", "cam/IMG_000.jpg", map[string]string{"Destination": e.url("cam/renamed.jpg")}, nil), 201)
	r := e.dav("PROPFIND", "cam/", map[string]string{"Depth": "1"}, nil)
	if !strings.Contains(string(r.body), "renamed.jpg") || strings.Contains(string(r.body), "IMG_000.jpg") {
		t.Fatal("stale name after rename in a big folder")
	}
	expect(t, e.dav("DELETE", "cam/IMG_001.jpg", nil, nil), 204)
	if n := count(); n != 40 {
		t.Fatalf("after DELETE: %d", n)
	}
	// expiration du cache : rafraichissement par difference aussi
	e.dev.CacheTTL = 0
	before = calls.Load()
	if n := count(); n != 40 {
		t.Fatalf("after expiry: %d", n)
	}
	// (1 = le dossier "cam" lui-meme, dans la racine, petite donc relue)
	if d := calls.Load() - before; d > 1 {
		t.Errorf("%d GetObjectInfo on an unchanged big folder", d)
	}
}

// PROPFIND Depth 1 en flux : les premiers octets partent avant la fin de la
// lecture d'un dossier lent (sinon rclone abandonne apres 1 min).
func TestPropfindStreaming(t *testing.T) {
	e := newEnv(t, fake.Options{Delay: 5 * time.Millisecond}, func(dir string) {
		_ = os.MkdirAll(filepath.Join(dir, "big"), 0o755)
		for i := range 500 {
			_ = os.WriteFile(filepath.Join(dir, "big", fmt.Sprintf("f%04d", i)), nil, 0o644)
		}
	})
	req, _ := http.NewRequest("PROPFIND", e.url("big/"), nil)
	req.Header.Set("Authorization", "Bearer "+testToken)
	req.Header.Set("Depth", "1")
	t0 := time.Now()
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	first := make([]byte, 64)
	if _, err := io.ReadFull(res.Body, first); err != nil {
		t.Fatal(err)
	}
	ttfb := time.Since(t0)
	rest, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	total := time.Since(t0)
	t.Logf("first bytes after %v, complete after %v", ttfb, total)
	if res.StatusCode != 207 {
		t.Fatalf("status %d", res.StatusCode)
	}
	if ttfb > time.Second || total < 2*ttfb {
		t.Fatalf("not streamed: first bytes %v, total %v", ttfb, total)
	}
	if ms := parseMS(t, append(first, rest...)); len(ms) != 501 {
		t.Fatalf("got %d responses", len(ms))
	}
	// deuxieme lecture : depuis le cache, d'un coup
	t0 = time.Now()
	r := e.dav("PROPFIND", "big/", map[string]string{"Depth": "1"}, nil)
	if len(parseMS(t, r.body)) != 501 || time.Since(t0) > time.Second {
		t.Fatalf("cached listing: %v", time.Since(t0))
	}
}
