package main

// Test d'integration : le vrai binaire rclone (patche, celui que Copiteur
// embarque) contre `copiteur-mtp --fake`. Ignore si le binaire rclone est
// absent (variable COPITEUR_RCLONE pour en indiquer un autre) ou avec -short.

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

const itToken = "integration-token-0123456789abcdefghijkl"

func rclonePath(t *testing.T) string {
	if p := os.Getenv("COPITEUR_RCLONE"); p != "" {
		return p
	}
	triple := map[string]string{
		"linux/amd64":  "x86_64-unknown-linux-gnu",
		"linux/arm64":  "aarch64-unknown-linux-gnu",
		"darwin/arm64": "aarch64-apple-darwin",
		"darwin/amd64": "x86_64-apple-darwin",
	}[runtime.GOOS+"/"+runtime.GOARCH]
	p, _ := filepath.Abs(filepath.Join("..", "src-tauri", "binaries", "rclone-"+triple))
	if _, err := os.Stat(p); err != nil {
		t.Skipf("rclone binary not found (%s)", p)
	}
	return p
}

var buildOnce sync.Once
var builtBin string
var buildErr error

func buildBinary(t *testing.T) string {
	buildOnce.Do(func() {
		dir, err := os.MkdirTemp("", "copiteur-mtp-it-*")
		if err != nil {
			buildErr = err
			return
		}
		builtBin = filepath.Join(dir, "copiteur-mtp")
		out, err := exec.Command("go", "build", "-o", builtBin, ".").CombinedOutput()
		if err != nil {
			buildErr = fmt.Errorf("go build: %v\n%s", err, out)
		}
	})
	if buildErr != nil {
		t.Fatal(buildErr)
	}
	return builtBin
}

type proc struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	port   int
	stderr *syncBuf
	done   chan struct{} // ferme quand le processus est sorti
}

type syncBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuf) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuf) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

func startServer(t *testing.T, args ...string) *proc {
	t.Helper()
	cmd := exec.Command(buildBinary(t), args...)
	cmd.Env = append(os.Environ(), "COPITEUR_MTP_TOKEN="+itToken)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	p := &proc{cmd: cmd, stdin: stdin, stderr: &syncBuf{}, done: make(chan struct{})}
	cmd.Stderr = p.stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	go func() { _ = cmd.Wait(); close(p.done) }()
	sc := bufio.NewScanner(stdout)
	if !sc.Scan() {
		t.Fatalf("no port line; stderr: %s", p.stderr.String())
	}
	var line struct {
		Port int `json:"port"`
	}
	if err := json.Unmarshal(sc.Bytes(), &line); err != nil || line.Port == 0 {
		t.Fatalf("bad port line %q", sc.Text())
	}
	if rest, _ := io.ReadAll(stdout); len(rest) != 0 {
		t.Errorf("extra stdout output: %q", rest)
	}
	p.port = line.Port
	t.Cleanup(func() {
		_ = stdin.Close()
		select {
		case <-p.done:
		case <-time.After(5 * time.Second):
			_ = cmd.Process.Kill()
			t.Error("server did not exit after stdin EOF")
		}
		if t.Failed() {
			t.Logf("server stderr:\n%s", p.stderr.String())
		}
	})
	return p
}

func (p *proc) url() string {
	return fmt.Sprintf("http://127.0.0.1:%d/dav/fake-phone", p.port)
}

// rclone lance rclone avec le remote "phone:" configure comme dans
// Copiteur (variables d'environnement, pas de fichier de config).
func rclone(t *testing.T, p *proc, args ...string) []byte {
	t.Helper()
	cmd := exec.Command(rclonePath(t), append([]string{"--config", "/dev/null", "--low-level-retries", "2", "--retries", "1"}, args...)...)
	cmd.Env = append(os.Environ(),
		"RCLONE_CONFIG_PHONE_TYPE=webdav",
		"RCLONE_CONFIG_PHONE_URL="+p.url(),
		"RCLONE_CONFIG_PHONE_VENDOR=other",
		"RCLONE_CONFIG_PHONE_BEARER_TOKEN="+itToken,
	)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("rclone %v: %v\n%s", args, err, stderr.String())
	}
	return out
}

// options globales utilisees par Copiteur pour le telephone
var appFlags = []string{"--inplace", "--multi-thread-streams", "1", "--ignore-times", "--transfers", "1"}

func sha(t *testing.T, path string) string {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		t.Fatal(err)
	}
	return fmt.Sprintf("%x", h.Sum(nil))
}

func writeRandom(t *testing.T, path string, n int64) {
	t.Helper()
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.CopyN(f, rand.Reader, n); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
}

type lsItem struct {
	Path  string
	Name  string
	Size  int64
	IsDir bool
}

func lsjson(t *testing.T, p *proc, remote string, extra ...string) map[string]lsItem {
	t.Helper()
	out := rclone(t, p, append([]string{"lsjson", remote}, extra...)...)
	var items []lsItem
	if err := json.Unmarshal(out, &items); err != nil {
		t.Fatalf("lsjson: %v: %s", err, out)
	}
	m := map[string]lsItem{}
	for _, it := range items {
		m[it.Path] = it
	}
	return m
}

func TestRcloneIntegration(t *testing.T) {
	if testing.Short() {
		t.Skip("integration test")
	}
	rclonePath(t)
	phone := t.TempDir()
	local := t.TempDir()
	p := startServer(t, "--fake", phone)

	if got := lsjson(t, p, "phone:"); len(got) != 0 {
		t.Fatalf("empty phone lists %v", got)
	}

	sizes := map[string]int64{"zero.bin": 0, "small.bin": 1024, "big.bin": 60 << 20}
	for name, n := range sizes {
		writeRandom(t, filepath.Join(local, name), n)
	}

	// --- envoi ---
	for name := range sizes {
		rclone(t, p, append([]string{"copyto", filepath.Join(local, name), "phone:up/" + name}, appFlags...)...)
		if sha(t, filepath.Join(phone, "up", name)) != sha(t, filepath.Join(local, name)) {
			t.Fatalf("upload %s: content mismatch", name)
		}
	}
	// remplacement d'un fichier existant, sans --inplace cette fois
	writeRandom(t, filepath.Join(local, "small2.bin"), 2048)
	rclone(t, p, "copyto", filepath.Join(local, "small2.bin"), "phone:up/small.bin", "--ignore-times")
	if sha(t, filepath.Join(phone, "up", "small.bin")) != sha(t, filepath.Join(local, "small2.bin")) {
		t.Fatal("overwrite: content mismatch")
	}
	ls := lsjson(t, p, "phone:up")
	if len(ls) != 3 || ls["big.bin"].Size != 60<<20 || ls["small.bin"].Size != 2048 || ls["zero.bin"].Size != 0 {
		t.Fatalf("listing after upload: %+v", ls)
	}

	// --- telechargement ---
	want := sha(t, filepath.Join(local, "big.bin"))
	for _, streams := range []string{"1", "4"} {
		dst := filepath.Join(local, "down-"+streams+".bin")
		// petits blocs : 4 requetes GET avec Range en parallele
		rclone(t, p, "copyto", "phone:up/big.bin", dst, "--multi-thread-streams", streams, "--multi-thread-cutoff", "1M", "--multi-thread-chunk-size", "4M", "--ignore-times")
		if sha(t, dst) != want {
			t.Fatalf("download with %s stream(s): content mismatch", streams)
		}
	}
	rclone(t, p, "copyto", "phone:up/zero.bin", filepath.Join(local, "down-zero.bin"))
	if st, err := os.Stat(filepath.Join(local, "down-zero.bin")); err != nil || st.Size() != 0 {
		t.Fatal("zero-byte download")
	}

	// --- dossiers, deplacements, suppressions ---
	rclone(t, p, "mkdir", "phone:newdir/sub")
	if st, err := os.Stat(filepath.Join(phone, "newdir", "sub")); err != nil || !st.IsDir() {
		t.Fatal("mkdir")
	}
	rclone(t, p, "moveto", "phone:up/small.bin", "phone:up/renamed.bin")
	rclone(t, p, "moveto", "phone:up/renamed.bin", "phone:newdir/sub/moved.bin")
	if _, err := os.Stat(filepath.Join(phone, "newdir", "sub", "moved.bin")); err != nil {
		t.Fatal("moveto into subfolder")
	}
	rclone(t, p, "deletefile", "phone:up/zero.bin")
	if _, err := os.Stat(filepath.Join(phone, "up", "zero.bin")); err == nil {
		t.Fatal("deletefile")
	}
	// copie cote serveur (COPY WebDAV -> CopyObject)
	rclone(t, p, "copyto", "phone:newdir/sub/moved.bin", "phone:up/copy.bin")
	if sha(t, filepath.Join(phone, "up", "copy.bin")) != sha(t, filepath.Join(local, "small2.bin")) {
		t.Fatal("server-side copy content")
	}
	if !strings.Contains(p.stderr.String(), "COPY /fake-phone/newdir/sub/moved.bin: ok") {
		t.Error("rclone did not use a server-side COPY")
	}
	// deplacement de dossier (DirMove -> MOVE)
	rclone(t, p, "moveto", "phone:newdir/sub", "phone:movedsub")
	if _, err := os.Stat(filepath.Join(phone, "movedsub", "moved.bin")); err != nil {
		t.Fatal("dir move")
	}
	rclone(t, p, "purge", "phone:newdir")
	if _, err := os.Stat(filepath.Join(phone, "newdir")); err == nil {
		t.Fatal("purge")
	}
	// about (quota)
	var about struct{ Total, Free int64 }
	if err := json.Unmarshal(rclone(t, p, "about", "phone:", "--json"), &about); err != nil || about.Total <= 0 || about.Free <= 0 {
		t.Fatalf("about: %+v %v", about, err)
	}
	// le gros fichier telecharge plusieurs fois ne doit avoir provoque aucune
	// transaction concurrente
	if strings.Contains(p.stderr.String(), "BUG") {
		t.Fatal("concurrent transaction detected")
	}
}

// Un listing doit repondre vite pendant un gros telechargement (lien USB
// simule a ~30 Mo/s).
func TestRcloneResponsiveDuringDownload(t *testing.T) {
	if testing.Short() {
		t.Skip("integration test")
	}
	rclonePath(t)
	phone := t.TempDir()
	local := t.TempDir()
	writeRandom(t, filepath.Join(phone, "big.bin"), 60<<20)
	if err := os.MkdirAll(filepath.Join(phone, "other"), 0o755); err != nil {
		t.Fatal(err)
	}
	for i := range 5 {
		writeRandom(t, filepath.Join(phone, "other", fmt.Sprintf("f%d", i)), 100)
	}
	p := startServer(t, "--fake", phone, "--fake-delay-ms", "33")

	done := make(chan struct{})
	start := time.Now()
	go func() {
		defer close(done)
		rclone(t, p, "copyto", "phone:big.bin", filepath.Join(local, "big.bin"), "--multi-thread-streams", "1")
	}()
	time.Sleep(700 * time.Millisecond)
	var worst time.Duration
	for i := 0; i < 3; i++ {
		select {
		case <-done:
			t.Fatal("download finished before the listing test (link not slow enough?)")
		default:
		}
		req, _ := http.NewRequest("PROPFIND", p.url()+"/other/", nil)
		req.Header.Set("Authorization", "Bearer "+itToken)
		req.Header.Set("Depth", "1")
		t0 := time.Now()
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(res.Body)
		res.Body.Close()
		d := time.Since(t0)
		if res.StatusCode != 207 || strings.Count(string(body), "<D:response>") != 6 {
			t.Fatalf("PROPFIND: %d %s", res.StatusCode, body)
		}
		worst = max(worst, d)
		time.Sleep(4500 * time.Millisecond / 10)
	}
	<-done
	total := time.Since(start)
	t.Logf("download %v, worst PROPFIND during download %v", total, worst)
	if worst >= time.Second {
		t.Fatalf("PROPFIND took %v during download", worst)
	}
	if sha(t, filepath.Join(local, "big.bin")) != sha(t, filepath.Join(phone, "big.bin")) {
		t.Fatal("download content")
	}
}

func TestProcessContract(t *testing.T) {
	if testing.Short() {
		t.Skip("integration test")
	}
	bin := buildBinary(t)
	// jeton absent / trop court
	for _, tok := range []string{"", "short"} {
		cmd := exec.Command(bin, "--fake", t.TempDir())
		cmd.Env = append(os.Environ(), "COPITEUR_MTP_TOKEN="+tok)
		out, err := cmd.Output()
		if err == nil || len(out) != 0 {
			t.Errorf("token %q: started anyway (out %q)", tok, out)
		}
	}
	// SIGTERM
	p := startServer(t, "--fake", t.TempDir())
	if err := p.cmd.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	select {
	case <-p.done:
	case <-time.After(5 * time.Second):
		t.Fatal("no exit on SIGTERM")
	}
	if !strings.Contains(p.stderr.String(), "shutting down") {
		t.Errorf("stderr: %s", p.stderr.String())
	}
	// fin de stdin
	p2 := startServer(t, "--fake", t.TempDir())
	_ = p2.stdin.Close()
	select {
	case <-p2.done:
	case <-time.After(5 * time.Second):
		t.Fatal("no exit on stdin EOF")
	}
	// ecoute sur 127.0.0.1 seulement : verifie via l'adresse annoncee
	p3 := startServer(t, "--fake", t.TempDir())
	res, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/api/devices", p3.port))
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 401 {
		t.Fatalf("no token: %d", res.StatusCode)
	}
}
