// Package server expose l'API de controle (/api/...) et le sous-ensemble
// WebDAV (/dav/{id}/...) utilise par le backend webdav de rclone.
package server

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"copiteur-mtp/internal/core"
)

// Manager est implemente par le gestionnaire USB et par le faux telephone.
type Manager interface {
	Devices() []*core.Device
	Get(id string) *core.Device
	Retry(id string) bool
	Close()
}

// IdleTimeout : delai max sans octet echange avec le client pendant un
// PUT ou un GET (evite qu'un client bloque garde l'appareil indefiniment).
var IdleTimeout = 60 * time.Second

// Server est le handler HTTP.
type Server struct {
	token []byte
	m     Manager
}

// New cree le handler.
func New(token string, m Manager) *Server {
	return &Server{token: []byte("Bearer " + token), m: m}
}

func (s *Server) authorized(r *http.Request) bool {
	got := r.Header.Get("Authorization")
	// le schema est insensible a la casse
	if len(got) > 7 && strings.EqualFold(got[:7], "bearer ") {
		got = "Bearer " + got[7:]
	}
	return subtle.ConstantTimeCompare([]byte(got), s.token) == 1
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !s.authorized(r) {
		w.Header().Set("WWW-Authenticate", `Bearer realm="copiteur-mtp"`)
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	p := r.URL.Path
	switch {
	case p == "/api/devices":
		s.apiDevices(w, r)
	case strings.HasPrefix(p, "/api/devices/") && strings.HasSuffix(p, "/retry"):
		id := strings.TrimSuffix(strings.TrimPrefix(p, "/api/devices/"), "/retry")
		s.apiRetry(w, r, id)
	case strings.HasPrefix(p, "/dav/"):
		rest := strings.TrimPrefix(p, "/dav/")
		id, sub, _ := strings.Cut(rest, "/")
		if id == "" {
			http.NotFound(w, r)
			return
		}
		s.dav(w, r, id, sub)
	default:
		http.NotFound(w, r)
	}
}

func (s *Server) apiDevices(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	out := []core.Status{}
	for _, d := range s.m.Devices() {
		out = append(out, d.Status())
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(out)
}

func (s *Server) apiRetry(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.m.Retry(id) {
		http.Error(w, "unknown device", http.StatusNotFound)
		return
	}
	w.WriteHeader(http.StatusAccepted)
}

const davAllow = "OPTIONS, PROPFIND, GET, HEAD, PUT, DELETE, MKCOL, MOVE, COPY"

func (s *Server) dav(w http.ResponseWriter, r *http.Request, id, sub string) {
	if r.Method == http.MethodOptions {
		w.Header().Set("DAV", "1")
		w.Header().Set("Allow", davAllow)
		w.Header().Set("MS-Author-Via", "DAV")
		w.WriteHeader(http.StatusOK)
		return
	}
	d := s.m.Get(id)
	if d == nil {
		http.Error(w, "device not connected", http.StatusServiceUnavailable)
		return
	}
	rc := http.NewResponseController(w)
	defer func() {
		_ = rc.SetReadDeadline(time.Time{})
		_ = rc.SetWriteDeadline(time.Time{})
	}()
	ctx := r.Context()
	p := core.CleanPath(sub)
	var err error
	switch r.Method {
	case "PROPFIND":
		err = s.propfind(ctx, w, r, d, id, p)
	case http.MethodGet, http.MethodHead:
		err = s.get(ctx, w, r, d, p)
	case http.MethodPut:
		err = s.put(ctx, w, r, d, p)
	case http.MethodDelete:
		if err = d.Delete(ctx, p); err == nil {
			w.WriteHeader(http.StatusNoContent)
		}
	case "MKCOL":
		if r.ContentLength > 0 {
			http.Error(w, "MKCOL with a body is not supported", http.StatusUnsupportedMediaType)
			return
		}
		if err = d.Mkdir(ctx, p); err == nil {
			w.WriteHeader(http.StatusCreated)
		}
	case "MOVE", "COPY":
		err = s.moveCopy(ctx, w, r, d, id, p)
	default:
		w.Header().Set("Allow", davAllow)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if r.Method != "PROPFIND" && r.Method != http.MethodGet && r.Method != http.MethodHead {
		if err != nil {
			log.Printf("%s %s: %v", r.Method, logPath(id, p), err)
		} else {
			log.Printf("%s %s: ok", r.Method, logPath(id, p))
		}
	} else if err != nil && !errors.Is(err, core.ErrNotFound) {
		log.Printf("%s %s: %v", r.Method, logPath(id, p), err)
	}
	if err != nil {
		writeError(w, err)
	}
}

func logPath(id, p string) string { return "/" + id + "/" + p }

// errHandled : la reponse a deja ete ecrite.
var errHandled = errors.New("handled")

func statusFor(err error) int {
	var nre *core.NotReadyError
	switch {
	case errors.As(err, &nre), errors.Is(err, core.ErrGone), errors.Is(err, core.ErrBusy),
		errors.Is(err, core.ErrNotReady), errors.Is(err, core.ErrDesync):
		return http.StatusServiceUnavailable
	case errors.Is(err, core.ErrNotFound):
		return http.StatusNotFound
	case errors.Is(err, core.ErrConflict), errors.Is(err, core.ErrNotDir), errors.Is(err, core.ErrIsDir):
		return http.StatusConflict
	case errors.Is(err, core.ErrExists):
		return http.StatusMethodNotAllowed
	case errors.Is(err, core.ErrPrecondition):
		return http.StatusPreconditionFailed
	case errors.Is(err, core.ErrForbidden), errors.Is(err, core.ErrReadOnly):
		return http.StatusForbidden
	case errors.Is(err, core.ErrBadName), errors.Is(err, core.ErrIncomplete):
		return http.StatusBadRequest
	case errors.Is(err, core.ErrNotSupported):
		return http.StatusNotImplemented
	case errors.Is(err, core.ErrStoreFull):
		return http.StatusInsufficientStorage
	}
	return http.StatusInternalServerError
}

func writeError(w http.ResponseWriter, err error) {
	if errors.Is(err, errHandled) {
		return
	}
	if errors.Is(err, context.Canceled) {
		return // client parti
	}
	code := statusFor(err)
	msg := err.Error()
	if code == http.StatusServiceUnavailable {
		w.Header().Set("Retry-After", "2")
	}
	http.Error(w, msg, code)
}

// --- PUT ---

type deadlineReader struct {
	r  io.Reader
	rc *http.ResponseController
}

func (d *deadlineReader) Read(p []byte) (int, error) {
	_ = d.rc.SetReadDeadline(time.Now().Add(IdleTimeout))
	return d.r.Read(p)
}

type deadlineWriter struct {
	w  io.Writer
	rc *http.ResponseController
}

func (d *deadlineWriter) Write(p []byte) (int, error) {
	_ = d.rc.SetWriteDeadline(time.Now().Add(IdleTimeout))
	return d.w.Write(p)
}

func (s *Server) put(ctx context.Context, w http.ResponseWriter, r *http.Request, d *core.Device, p string) error {
	if p == "" {
		return fmt.Errorf("%w: PUT on the root", core.ErrForbidden)
	}
	rc := http.NewResponseController(w)
	var body io.Reader = &deadlineReader{r: r.Body, rc: rc}
	size := r.ContentLength
	if size < 0 {
		// Taille inconnue (chunked) : MTP exige la taille avant l'envoi,
		// on passe par un fichier temporaire.
		tmp, err := os.CreateTemp("", "copiteur-mtp-put-*")
		if err != nil {
			return err
		}
		defer os.Remove(tmp.Name())
		defer tmp.Close()
		n, err := io.Copy(tmp, body)
		if err != nil {
			return fmt.Errorf("%w: %v", core.ErrIncomplete, err)
		}
		if _, err := tmp.Seek(0, io.SeekStart); err != nil {
			return err
		}
		size, body = n, tmp
	}
	created, err := d.Put(ctx, p, size, time.Now(), body)
	if err != nil {
		return err
	}
	if created {
		w.WriteHeader(http.StatusCreated)
	} else {
		w.WriteHeader(http.StatusNoContent)
	}
	return nil
}

// --- MOVE / COPY ---

func (s *Server) moveCopy(ctx context.Context, w http.ResponseWriter, r *http.Request, d *core.Device, id, p string) error {
	dest := r.Header.Get("Destination")
	if dest == "" {
		http.Error(w, "missing Destination header", http.StatusBadRequest)
		return errHandled
	}
	u, err := url.Parse(dest)
	if err != nil {
		http.Error(w, "bad Destination header", http.StatusBadRequest)
		return errHandled
	}
	prefix := "/dav/" + id
	dp := u.Path
	if dp != prefix && !strings.HasPrefix(dp, prefix+"/") {
		if strings.HasPrefix(dp, "/dav/") {
			http.Error(w, "cannot move or copy between devices", http.StatusBadGateway)
		} else {
			http.Error(w, "Destination outside of this device", http.StatusBadRequest)
		}
		return errHandled
	}
	dp = core.CleanPath(strings.TrimPrefix(dp, prefix))
	if p == "" || dp == "" {
		return fmt.Errorf("%w: MOVE/COPY of the root", core.ErrForbidden)
	}
	overwrite := !strings.EqualFold(strings.TrimSpace(r.Header.Get("Overwrite")), "F")
	var existed bool
	if r.Method == "MOVE" {
		existed, err = d.Move(ctx, p, dp, overwrite)
	} else {
		existed, err = d.Copy(ctx, p, dp, overwrite)
	}
	if err != nil {
		return err
	}
	if existed {
		w.WriteHeader(http.StatusNoContent)
	} else {
		w.WriteHeader(http.StatusCreated)
	}
	return nil
}
