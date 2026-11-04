package server

import (
	"bytes"
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"time"

	"copiteur-mtp/internal/core"
)

// FixedDate remplace une date inconnue ou aberrante (jamais de valeur
// illisible pour le client).
var FixedDate = time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC)

func httpDate(t time.Time) string {
	if t.IsZero() || t.Year() < 1980 || t.Year() > 2200 {
		t = FixedDate
	}
	return t.UTC().Format(http.TimeFormat)
}

func contentType(name string) string {
	if t := mime.TypeByExtension(strings.ToLower(path.Ext(name))); t != "" {
		return t
	}
	return "application/octet-stream"
}

func href(id string, n core.Node) string {
	p := "/dav/" + id + "/"
	if n.Path != "" {
		p += n.Path
		if n.IsDir() {
			p += "/"
		}
	}
	return (&url.URL{Path: p}).EscapedPath()
}

func xmlText(b *bytes.Buffer, s string) {
	_ = xml.EscapeText(b, []byte(s))
}

func (s *Server) propfind(ctx context.Context, w http.ResponseWriter, r *http.Request, d *core.Device, id, p string) error {
	depth := strings.ToLower(strings.TrimSpace(r.Header.Get("Depth")))
	switch depth {
	case "0", "1":
	case "":
		depth = "1"
	default:
		// Depth: infinity refuse (RFC 4918 9.1)
		w.Header().Set("Content-Type", "application/xml; charset=utf-8")
		w.WriteHeader(http.StatusForbidden)
		_, _ = io.WriteString(w, `<?xml version="1.0" encoding="utf-8"?>`+"\n"+`<D:error xmlns:D="DAV:"><D:propfind-finite-depth/></D:error>`)
		return errHandled
	}
	// Le corps (liste des proprietes demandees) est ignore : on renvoie
	// toujours le meme jeu de proprietes.
	_, _ = io.Copy(io.Discard, io.LimitReader(r.Body, 1<<20))

	n, err := d.Resolve(ctx, p)
	if err != nil {
		return err
	}
	const head = `<?xml version="1.0" encoding="utf-8"?>` + "\n" + `<D:multistatus xmlns:D="DAV:">`
	if depth == "0" || !n.IsDir() {
		var b bytes.Buffer
		b.WriteString(head)
		writeResponse(&b, d, id, n)
		b.WriteString("</D:multistatus>\n")
		w.Header().Set("Content-Type", "application/xml; charset=utf-8")
		w.Header().Set("Content-Length", strconv.Itoa(b.Len()))
		w.WriteHeader(http.StatusMultiStatus)
		_, _ = w.Write(b.Bytes())
		return nil
	}

	// Depth 1 sur un dossier : reponse EN FLUX. Un gros dossier (DCIM/Camera,
	// des dizaines de milliers de photos) demande un GetObjectInfo par objet,
	// soit des minutes ; sans flux, rclone (delai d'inactivite de 1 min)
	// abandonnerait avant le premier octet. L'en-tete 207 part avec le
	// premier lot d'enfants (une erreur avant reste une vraie reponse
	// d'erreur), puis chaque lot est envoye et pousse des sa lecture.
	rc := http.NewResponseController(w)
	started := false
	var b bytes.Buffer
	start := func() {
		started = true
		w.Header().Set("Content-Type", "application/xml; charset=utf-8")
		w.WriteHeader(http.StatusMultiStatus)
		b.WriteString(head)
		writeResponse(&b, d, id, n)
	}
	send := func() error {
		_ = rc.SetWriteDeadline(time.Now().Add(IdleTimeout))
		_, err := w.Write(b.Bytes())
		b.Reset()
		if err == nil {
			err = rc.Flush()
		}
		return err
	}
	err = d.ReadDirStream(ctx, n, func(batch []core.Node) error {
		if !started {
			start()
		}
		for _, c := range batch {
			writeResponse(&b, d, id, c)
		}
		return send()
	})
	if err != nil {
		if !started {
			return err
		}
		// 207 deja envoye : on coupe la connexion plutot que de laisser
		// le client croire a une liste complete (rclone supprimerait des
		// fichiers "absents" lors d'une synchro).
		panic(http.ErrAbortHandler)
	}
	if !started {
		start() // dossier vide
	}
	b.WriteString("</D:multistatus>\n")
	_ = send()
	return nil
}

func writeResponse(b *bytes.Buffer, d *core.Device, id string, n core.Node) {
	b.WriteString("<D:response><D:href>")
	xmlText(b, href(id, n))
	b.WriteString("</D:href><D:propstat><D:prop>")
	b.WriteString("<D:displayname>")
	xmlText(b, n.Name())
	b.WriteString("</D:displayname>")
	if n.IsDir() {
		b.WriteString("<D:resourcetype><D:collection/></D:resourcetype>")
	} else {
		b.WriteString("<D:resourcetype/>")
		fmt.Fprintf(b, "<D:getcontentlength>%d</D:getcontentlength>", n.Size())
		b.WriteString("<D:getcontenttype>")
		xmlText(b, contentType(n.Name()))
		b.WriteString("</D:getcontenttype>")
	}
	fmt.Fprintf(b, "<D:getlastmodified>%s</D:getlastmodified>", httpDate(n.ModTime()))
	if n.IsRoot() || n.IsStorageRoot() {
		if free, used, ok := d.Quota(n); ok {
			fmt.Fprintf(b, "<D:quota-available-bytes>%d</D:quota-available-bytes><D:quota-used-bytes>%d</D:quota-used-bytes>", free, used)
		}
	}
	b.WriteString("</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>\n")
}

// --- GET / HEAD ---

// parseRange interprete un en-tete Range a plage unique. ok=false : en-tete
// absent, multi-plages ou invalide (on renvoie tout le fichier).
// unsat=true : plage hors du fichier (416).
func parseRange(h string, size int64) (start, length int64, ok, unsat bool) {
	h = strings.TrimSpace(h)
	if h == "" || size == 0 {
		return 0, 0, false, false
	}
	spec, found := strings.CutPrefix(h, "bytes=")
	if !found || strings.Contains(spec, ",") {
		return 0, 0, false, false
	}
	a, b, found := strings.Cut(strings.TrimSpace(spec), "-")
	if !found {
		return 0, 0, false, false
	}
	a, b = strings.TrimSpace(a), strings.TrimSpace(b)
	if a == "" {
		// suffixe : les n derniers octets
		n, err := strconv.ParseInt(b, 10, 64)
		if err != nil || n < 0 {
			return 0, 0, false, false
		}
		if n == 0 {
			return 0, 0, false, true
		}
		n = min(n, size)
		return size - n, n, true, false
	}
	first, err := strconv.ParseInt(a, 10, 64)
	if err != nil || first < 0 {
		return 0, 0, false, false
	}
	last := size - 1
	if b != "" {
		last, err = strconv.ParseInt(b, 10, 64)
		if err != nil || last < first {
			return 0, 0, false, false
		}
		last = min(last, size-1)
	}
	if first >= size {
		return 0, 0, false, true
	}
	return first, last - first + 1, true, false
}

// lazyWriter n'envoie les en-tetes qu'au premier octet : une erreur sur le
// premier bloc peut encore devenir une vraie reponse d'erreur.
type lazyWriter struct {
	w       http.ResponseWriter
	status  int
	started bool
}

func (l *lazyWriter) Write(p []byte) (int, error) {
	if !l.started {
		l.started = true
		l.w.WriteHeader(l.status)
	}
	return l.w.Write(p)
}

func (s *Server) get(ctx context.Context, w http.ResponseWriter, r *http.Request, d *core.Device, p string) error {
	n, err := d.Resolve(ctx, p)
	if err != nil {
		return err
	}
	if n.IsDir() {
		w.Header().Set("Allow", "OPTIONS, PROPFIND, DELETE, MKCOL, MOVE")
		http.Error(w, "GET on a folder", http.StatusMethodNotAllowed)
		return errHandled
	}
	size := n.Size()
	h := w.Header()
	h.Set("Content-Type", contentType(n.Name()))
	h.Set("Last-Modified", httpDate(n.ModTime()))
	h.Set("Accept-Ranges", "bytes")
	start, length := int64(0), size
	status := http.StatusOK
	if r.Header.Get("Range") != "" {
		a, l, ok, unsat := parseRange(r.Header.Get("Range"), size)
		if unsat {
			h.Set("Content-Range", fmt.Sprintf("bytes */%d", size))
			http.Error(w, "range not satisfiable", http.StatusRequestedRangeNotSatisfiable)
			return errHandled
		}
		if ok {
			start, length, status = a, l, http.StatusPartialContent
			h.Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, start+length-1, size))
		}
	}
	h.Set("Content-Length", strconv.FormatInt(length, 10))
	if r.Method == http.MethodHead || length == 0 {
		w.WriteHeader(status)
		return nil
	}
	lw := &lazyWriter{w: w, status: status}
	err = d.ReadRange(ctx, n, start, length, &deadlineWriter{w: lw, rc: http.NewResponseController(w)})
	if err == nil {
		return nil
	}
	if !lw.started {
		// rien n'est parti : vraie reponse d'erreur
		for _, k := range []string{"Content-Range", "Content-Length", "Accept-Ranges", "Last-Modified"} {
			h.Del(k)
		}
		return err
	}
	if !errors.Is(err, context.Canceled) {
		// reponse tronquee : on coupe la connexion pour que le client le
		// sache (la longueur annoncee ne sera pas atteinte).
		panic(http.ErrAbortHandler)
	}
	return errHandled
}
