// Package fake simule un telephone MTP adosse a un dossier local, pour les
// tests et le developpement (--fake DIR). Il reproduit les contraintes MTP
// qui comptent pour la couche WebDAV : handles entiers, une seule
// transaction a la fois (un appel concurrent est une erreur, comme le
// serait une transaction USB entrelacee), taille obligatoire a l'envoi, pas
// d'ecrasement, session desynchronisee apres un envoi interrompu, et un
// delai optionnel pour simuler un lien USB lent.
package fake

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"copiteur-mtp/internal/core"
)

// MarkerTwoStorages : si ce fichier existe dans le dossier du faux
// telephone, il expose deux stockages (sous-dossiers "interne" et "sd").
const MarkerTwoStorages = ".two-storages"

// Options regle le faux telephone.
type Options struct {
	Name string
	// Delay : cout de chaque transaction, et cout par Mio transfere
	// (33 ms ~ 30 Mo/s).
	Delay time.Duration
	// Capacity : taille annoncee de chaque stockage (defaut 64 Gio).
	Capacity uint64

	// Simulation d'appareils limites (tests des replis).
	NoPartial         bool // ni GetPartialObject64 ni GetPartialObject
	NoMove            bool // pas de MoveObject
	NoCopy            bool // pas de CopyObject
	NoRename          bool // pas de SetObjectPropValue(ObjectFileName)
	NoRecursiveDelete bool // DeleteObject refuse les dossiers non vides
}

type storage struct {
	id   uint32
	dir  string
	desc string
}

type entry struct {
	sid uint32
	rel string // chemin relatif au dossier du stockage, separateur "/"
}

// Conn est une session MTP simulee.
type Conn struct {
	opts     Options
	mu       sync.Mutex
	storages []storage
	next     uint32
	byHandle map[uint32]entry
	byPath   map[entry]uint32
	desync   bool
	closed   bool
}

var errConcurrent = errors.New("fake MTP: concurrent transaction (missing lock)")

// Open ouvre une session sur le dossier dir.
func Open(dir string, opts Options) (*Conn, error) {
	st, err := os.Stat(dir)
	if err != nil {
		return nil, err
	}
	if !st.IsDir() {
		return nil, fmt.Errorf("%s is not a directory", dir)
	}
	if opts.Capacity == 0 {
		opts.Capacity = 64 << 30
	}
	c := &Conn{opts: opts, next: 1, byHandle: map[uint32]entry{}, byPath: map[entry]uint32{}}
	if _, err := os.Stat(filepath.Join(dir, MarkerTwoStorages)); err == nil {
		for _, s := range []storage{
			{id: 0x00010001, dir: filepath.Join(dir, "interne"), desc: "Espace de stockage interne partagé"},
			{id: 0x00020001, dir: filepath.Join(dir, "sd"), desc: "Carte SD"},
		} {
			if err := os.MkdirAll(s.dir, 0o755); err != nil {
				return nil, err
			}
			c.storages = append(c.storages, s)
		}
	} else {
		c.storages = []storage{{id: 0x00010001, dir: dir, desc: "Espace de stockage interne partagé"}}
	}
	return c, nil
}

// begin simule le debut d'une transaction.
func (c *Conn) begin() (func(), error) {
	if !c.mu.TryLock() {
		log.Printf("BUG: %v", errConcurrent)
		return nil, errConcurrent
	}
	if c.closed {
		c.mu.Unlock()
		return nil, fmt.Errorf("%w: session closed", core.ErrGone)
	}
	if c.desync {
		c.mu.Unlock()
		return nil, fmt.Errorf("%w: previous transaction interrupted", core.ErrDesync)
	}
	c.sleep(0)
	return c.mu.Unlock, nil
}

func (c *Conn) sleep(bytes int64) {
	if c.opts.Delay <= 0 {
		return
	}
	d := c.opts.Delay
	if bytes > 0 {
		d = time.Duration(float64(c.opts.Delay) * float64(bytes) / float64(1<<20))
	}
	time.Sleep(d)
}

func (c *Conn) storage(id uint32) (storage, bool) {
	for _, s := range c.storages {
		if s.id == id {
			return s, true
		}
	}
	return storage{}, false
}

func (c *Conn) abs(e entry) string {
	s, _ := c.storage(e.sid)
	return filepath.Join(s.dir, filepath.FromSlash(e.rel))
}

func (c *Conn) handleFor(e entry) uint32 {
	if h, ok := c.byPath[e]; ok {
		return h
	}
	h := c.next
	c.next++
	c.byHandle[h] = e
	c.byPath[e] = h
	return h
}

func (c *Conn) forget(h uint32) {
	if e, ok := c.byHandle[h]; ok {
		delete(c.byPath, e)
		delete(c.byHandle, h)
	}
}

// dirOf renvoie l'entree (dossier) designee par (storage, parent).
func (c *Conn) dirOf(sid, parent uint32) (entry, error) {
	if _, ok := c.storage(sid); !ok {
		return entry{}, fmt.Errorf("%w: storage %#x", core.ErrNotFound, sid)
	}
	if parent == core.RootParent || parent == 0 {
		return entry{sid: sid}, nil
	}
	e, ok := c.byHandle[parent]
	if !ok || e.sid != sid {
		return entry{}, fmt.Errorf("%w: parent %d", core.ErrNotFound, parent)
	}
	st, err := os.Stat(c.abs(e))
	if err != nil {
		c.forget(parent)
		return entry{}, fmt.Errorf("%w: parent %d", core.ErrNotFound, parent)
	}
	if !st.IsDir() {
		return entry{}, fmt.Errorf("%w: parent %d is a file", core.ErrNotFound, parent)
	}
	return e, nil
}

func child(e entry, name string) entry {
	if e.rel == "" {
		return entry{sid: e.sid, rel: name}
	}
	return entry{sid: e.sid, rel: e.rel + "/" + name}
}

func (c *Conn) lookup(h uint32) (entry, error) {
	e, ok := c.byHandle[h]
	if !ok {
		return entry{}, fmt.Errorf("%w: handle %d", core.ErrNotFound, h)
	}
	if _, err := os.Lstat(c.abs(e)); err != nil {
		c.forget(h)
		return entry{}, fmt.Errorf("%w: handle %d", core.ErrNotFound, h)
	}
	return e, nil
}

func (c *Conn) exists(e entry) bool {
	_, err := os.Lstat(c.abs(e))
	return err == nil
}

// Storages implemente core.Conn.
func (c *Conn) Storages() ([]core.Storage, error) {
	done, err := c.begin()
	if err != nil {
		return nil, err
	}
	defer done()
	out := make([]core.Storage, 0, len(c.storages))
	for _, s := range c.storages {
		var used uint64
		_ = filepath.WalkDir(s.dir, func(_ string, de fs.DirEntry, err error) error {
			if err == nil && !de.IsDir() {
				if fi, err := de.Info(); err == nil {
					used += uint64(fi.Size())
				}
			}
			return nil
		})
		free := uint64(0)
		if used < c.opts.Capacity {
			free = c.opts.Capacity - used
		}
		out = append(out, core.Storage{ID: s.id, Description: s.desc, Total: c.opts.Capacity, Free: free})
	}
	return out, nil
}

// Handles implemente core.Conn.
func (c *Conn) Handles(sid, parent uint32) ([]uint32, error) {
	done, err := c.begin()
	if err != nil {
		return nil, err
	}
	defer done()
	dir, err := c.dirOf(sid, parent)
	if err != nil {
		return nil, err
	}
	des, err := os.ReadDir(c.abs(dir))
	if err != nil {
		return nil, fmt.Errorf("%w: %v", core.ErrNotFound, err)
	}
	out := make([]uint32, 0, len(des))
	for _, de := range des {
		out = append(out, c.handleFor(child(dir, de.Name())))
	}
	return out, nil
}

// Info implemente core.Conn.
func (c *Conn) Info(h uint32) (core.Object, error) {
	done, err := c.begin()
	if err != nil {
		return core.Object{}, err
	}
	defer done()
	e, err := c.lookup(h)
	if err != nil {
		return core.Object{}, err
	}
	fi, err := os.Stat(c.abs(e))
	if err != nil {
		return core.Object{}, fmt.Errorf("%w: %v", core.ErrNotFound, err)
	}
	o := core.Object{Handle: h, StorageID: e.sid, Name: filepath.Base(c.abs(e)), IsDir: fi.IsDir(), ModTime: fi.ModTime()}
	if !o.IsDir {
		o.Size = fi.Size()
	}
	return o, nil
}

// PartialRead implemente core.Conn.
func (c *Conn) PartialRead(int64) bool { return !c.opts.NoPartial }

// ReadPartial implemente core.Conn.
func (c *Conn) ReadPartial(h uint32, off int64, n uint32, w io.Writer) error {
	if c.opts.NoPartial {
		return core.ErrNotSupported
	}
	done, err := c.begin()
	if err != nil {
		return err
	}
	defer done()
	e, err := c.lookup(h)
	if err != nil {
		return err
	}
	f, err := os.Open(c.abs(e))
	if err != nil {
		return fmt.Errorf("%w: %v", core.ErrNotFound, err)
	}
	defer f.Close()
	k, err := io.Copy(w, io.NewSectionReader(f, off, int64(n)))
	c.sleep(k)
	return err
}

// ReadAll implemente core.Conn.
func (c *Conn) ReadAll(h uint32, w io.Writer) error {
	done, err := c.begin()
	if err != nil {
		return err
	}
	defer done()
	e, err := c.lookup(h)
	if err != nil {
		return err
	}
	f, err := os.Open(c.abs(e))
	if err != nil {
		return fmt.Errorf("%w: %v", core.ErrNotFound, err)
	}
	defer f.Close()
	buf := make([]byte, 1<<20)
	for {
		n, err := f.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				// sur un vrai appareil, la transaction serait cassee
				c.desync = true
				return fmt.Errorf("%w: writer failed: %v", core.ErrDesync, werr)
			}
			c.sleep(int64(n))
		}
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
	}
}

// CreateFolder implemente core.Conn.
func (c *Conn) CreateFolder(sid, parent uint32, name string) (uint32, error) {
	done, err := c.begin()
	if err != nil {
		return 0, err
	}
	defer done()
	dir, err := c.dirOf(sid, parent)
	if err != nil {
		return 0, err
	}
	e := child(dir, name)
	if c.exists(e) {
		return 0, fmt.Errorf("%w: %s", core.ErrExists, name)
	}
	if err := os.Mkdir(c.abs(e), 0o755); err != nil {
		return 0, err
	}
	return c.handleFor(e), nil
}

// Send implemente core.Conn.
func (c *Conn) Send(sid, parent uint32, name string, size int64, _ time.Time, r io.Reader) (uint32, error) {
	done, err := c.begin()
	if err != nil {
		return 0, err
	}
	defer done()
	if size < 0 {
		return 0, errors.New("fake MTP: SendObjectInfo needs the size up front")
	}
	dir, err := c.dirOf(sid, parent)
	if err != nil {
		return 0, err
	}
	e := child(dir, name)
	if c.exists(e) {
		// Android refuse SendObjectInfo si le nom existe deja.
		return 0, fmt.Errorf("fake MTP: %w: %s (MTP cannot overwrite)", core.ErrExists, name)
	}
	s, _ := c.storage(sid)
	if size > 0 {
		var used int64
		_ = filepath.WalkDir(s.dir, func(_ string, de fs.DirEntry, err error) error {
			if err == nil && !de.IsDir() {
				if fi, err := de.Info(); err == nil {
					used += fi.Size()
				}
			}
			return nil
		})
		if uint64(used+size) > c.opts.Capacity {
			return 0, fmt.Errorf("fake MTP: %w", core.ErrStoreFull)
		}
	}
	f, err := os.Create(c.abs(e))
	if err != nil {
		return 0, err
	}
	h := c.handleFor(e)
	var sent int64
	buf := make([]byte, 1<<20)
	for sent < size {
		want := min(int64(len(buf)), size-sent)
		n, rerr := io.ReadFull(r, buf[:want])
		if n > 0 {
			if _, werr := f.Write(buf[:n]); werr != nil {
				f.Close()
				c.desync = true
				return h, fmt.Errorf("%w: %v", core.ErrDesync, werr)
			}
			sent += int64(n)
			c.sleep(int64(n))
		}
		if rerr != nil {
			// phase de donnees inachevee : l'objet partiel reste, la
			// session est desynchronisee (comme sur un vrai telephone).
			f.Close()
			c.desync = true
			return h, fmt.Errorf("%w: data phase interrupted after %d/%d bytes: %v", core.ErrDesync, sent, size, rerr)
		}
	}
	if err := f.Close(); err != nil {
		return h, err
	}
	return h, nil
}

// Delete implemente core.Conn.
func (c *Conn) Delete(h uint32) error {
	done, err := c.begin()
	if err != nil {
		return err
	}
	defer done()
	e, err := c.lookup(h)
	if err != nil {
		return err
	}
	p := c.abs(e)
	fi, err := os.Lstat(p)
	if err != nil {
		return fmt.Errorf("%w: %v", core.ErrNotFound, err)
	}
	if fi.IsDir() && c.opts.NoRecursiveDelete {
		if des, _ := os.ReadDir(p); len(des) > 0 {
			return errors.New("fake MTP: PartialDeletion (folder not empty)")
		}
	}
	if err := os.RemoveAll(p); err != nil {
		return err
	}
	c.remap(e, nil)
	return nil
}

// remap met a jour les handles de e et de ses descendants (to == nil :
// suppression).
func (c *Conn) remap(from entry, to *entry) {
	prefix := from.rel + "/"
	for h, e := range c.byHandle {
		if e.sid != from.sid || (e.rel != from.rel && !strings.HasPrefix(e.rel, prefix)) {
			continue
		}
		delete(c.byPath, e)
		if to == nil {
			delete(c.byHandle, h)
			continue
		}
		ne := entry{sid: to.sid, rel: to.rel + strings.TrimPrefix(e.rel, from.rel)}
		c.byHandle[h] = ne
		c.byPath[ne] = h
	}
}

func parentEntry(e entry) entry {
	i := strings.LastIndexByte(e.rel, '/')
	if i < 0 {
		return entry{sid: e.sid}
	}
	return entry{sid: e.sid, rel: e.rel[:i]}
}

// Rename implemente core.Conn.
func (c *Conn) Rename(h uint32, name string) error {
	if c.opts.NoRename {
		return core.ErrNotSupported
	}
	done, err := c.begin()
	if err != nil {
		return err
	}
	defer done()
	e, err := c.lookup(h)
	if err != nil {
		return err
	}
	ne := child(parentEntry(e), name)
	if c.exists(ne) && !strings.EqualFold(ne.rel, e.rel) {
		return fmt.Errorf("%w: %s", core.ErrExists, name)
	}
	if err := os.Rename(c.abs(e), c.abs(ne)); err != nil {
		return err
	}
	c.remap(e, &ne)
	return nil
}

// Move implemente core.Conn.
func (c *Conn) Move(h, sid, parent uint32) error {
	if c.opts.NoMove {
		return core.ErrNotSupported
	}
	done, err := c.begin()
	if err != nil {
		return err
	}
	defer done()
	e, err := c.lookup(h)
	if err != nil {
		return err
	}
	dir, err := c.dirOf(sid, parent)
	if err != nil {
		return err
	}
	name := filepath.Base(c.abs(e))
	ne := child(dir, name)
	if c.exists(ne) {
		return fmt.Errorf("%w: %s", core.ErrExists, name)
	}
	if err := os.Rename(c.abs(e), c.abs(ne)); err != nil {
		return err
	}
	c.remap(e, &ne)
	return nil
}

// Copy implemente core.Conn.
func (c *Conn) Copy(h, sid, parent uint32) (uint32, error) {
	if c.opts.NoCopy {
		return 0, core.ErrNotSupported
	}
	done, err := c.begin()
	if err != nil {
		return 0, err
	}
	defer done()
	e, err := c.lookup(h)
	if err != nil {
		return 0, err
	}
	src := c.abs(e)
	fi, err := os.Stat(src)
	if err != nil {
		return 0, fmt.Errorf("%w: %v", core.ErrNotFound, err)
	}
	if fi.IsDir() {
		return 0, core.ErrNotSupported
	}
	dir, err := c.dirOf(sid, parent)
	if err != nil {
		return 0, err
	}
	ne := child(dir, filepath.Base(src))
	if c.exists(ne) {
		return 0, fmt.Errorf("%w: %s", core.ErrExists, filepath.Base(src))
	}
	in, err := os.Open(src)
	if err != nil {
		return 0, err
	}
	defer in.Close()
	out, err := os.Create(c.abs(ne))
	if err != nil {
		return 0, err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return 0, err
	}
	if err := out.Close(); err != nil {
		return 0, err
	}
	return c.handleFor(ne), nil
}

// Resync implemente core.Conn.
func (c *Conn) Resync() error {
	if !c.mu.TryLock() {
		return errConcurrent
	}
	defer c.mu.Unlock()
	if c.closed {
		return core.ErrGone
	}
	c.desync = false
	c.sleep(0)
	return nil
}

// Close implemente core.Conn.
func (c *Conn) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.closed = true
	return nil
}

// Manager expose un seul faux telephone, toujours pret.
type Manager struct {
	dir  string
	opts Options
	dev  *core.Device
}

// DeviceID est l'identifiant du faux telephone.
const DeviceID = "fake-phone"

// NewManager cree le gestionnaire et ouvre la session.
func NewManager(dir string, opts Options) (*Manager, error) {
	if opts.Name == "" {
		opts.Name = "Téléphone de test"
	}
	m := &Manager{dir: dir, opts: opts, dev: core.NewDevice(DeviceID)}
	m.dev.SetIdentity(opts.Name, "Copiteur")
	if err := m.open(); err != nil {
		return nil, err
	}
	return m, nil
}

func (m *Manager) open() error {
	c, err := Open(m.dir, m.opts)
	if err != nil {
		return err
	}
	st, err := c.Storages()
	if err != nil {
		return err
	}
	m.dev.SetState(core.StateConnecting, "")
	m.dev.Attach(c, st)
	return nil
}

// Device renvoie le faux telephone (tests).
func (m *Manager) Device() *core.Device { return m.dev }

// Devices implemente server.Manager.
func (m *Manager) Devices() []*core.Device { return []*core.Device{m.dev} }

// Get implemente server.Manager.
func (m *Manager) Get(id string) *core.Device {
	if id == DeviceID {
		return m.dev
	}
	return nil
}

// Retry implemente server.Manager.
func (m *Manager) Retry(id string) bool {
	if id != DeviceID {
		return false
	}
	go func() {
		m.dev.Close(core.StateConnecting, "", 30*time.Second)
		if err := m.open(); err != nil {
			m.dev.SetState(core.StateError, err.Error())
		}
	}()
	return true
}

// Close implemente server.Manager.
func (m *Manager) Close() {
	m.dev.Close(core.StateError, "shutting down", 3*time.Second)
}
