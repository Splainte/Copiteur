package core

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"
)

// State est l'etat d'un appareil tel qu'expose par GET /api/devices.
type State string

const (
	StateConnecting State = "connecting"
	StateReady      State = "ready"
	StateLocked     State = "locked"
	StateBusy       State = "busy"
	StateError      State = "error"
)

// StorageStatus est la forme JSON d'un stockage dans /api/devices.
type StorageStatus struct {
	Name  string `json:"name"`
	Total uint64 `json:"total"`
	Free  uint64 `json:"free"`
}

// Status est la forme JSON d'un appareil dans /api/devices.
type Status struct {
	ID           string          `json:"id"`
	Name         string          `json:"name"`
	Manufacturer string          `json:"manufacturer"`
	State        State           `json:"state"`
	Error        string          `json:"error"`
	Storages     []StorageStatus `json:"storages"`
}

// NotReadyError est renvoyee quand l'appareil n'est pas pret (503).
type NotReadyError struct {
	State State
	Msg   string
}

func (e *NotReadyError) Error() string {
	if e.Msg != "" {
		return fmt.Sprintf("device %s: %s", e.State, e.Msg)
	}
	return fmt.Sprintf("device %s", e.State)
}

func (e *NotReadyError) Unwrap() error { return ErrNotReady }

// Valeurs par defaut des reglages de Device.
const (
	DefaultChunkSize = 8 << 20
	DefaultCacheTTL  = 4 * time.Second
	DefaultMaxPad    = 256 << 20
	DefaultInfoBatch = 32
)

// Device est un appareil MTP vu par la couche WebDAV. Toutes les
// transactions passent par mu : une seule a la fois par appareil, mais
// aucune operation longue (lecture d'un gros fichier, listing d'un gros
// dossier) ne le garde d'un bout a l'autre, sauf l'envoi d'un fichier
// (SendObject est une seule transaction MTP).
type Device struct {
	id string

	// Reglages (modifiables avant usage, ex. dans les tests).
	ChunkSize int
	CacheTTL  time.Duration
	MaxPad    int64 // upload coupe : on complete avec des zeros jusqu'a cette taille, au-dela on resynchronise
	InfoBatch int   // nombre de GetObjectInfo par prise du verrou pendant un listing

	// OnGone est appele (dans sa propre goroutine) quand la connexion a ete
	// fermee suite a une erreur USB.
	OnGone func(d *Device, err error)

	stMu         sync.RWMutex
	name         string
	manufacturer string
	state        State
	errMsg       string
	storages     []Storage
	storagesAt   time.Time

	mu       sync.Mutex // verrou des transactions MTP
	conn     Conn       // protege par mu
	closeReq atomic.Bool

	cacheMu  sync.Mutex
	cache    map[dirKey]*dirEntry
	inflight map[dirKey]*flight
	gen      uint64
}

type dirKey struct {
	storage uint32
	parent  uint32
}

type dirEntry struct {
	objs []Object
	at   time.Time
}

type flight struct {
	gen  uint64
	done chan struct{}
	objs []Object
	err  error
}

// NewDevice cree un appareil dans l'etat "connecting".
func NewDevice(id string) *Device {
	return &Device{
		id:        id,
		ChunkSize: DefaultChunkSize,
		CacheTTL:  DefaultCacheTTL,
		MaxPad:    DefaultMaxPad,
		InfoBatch: DefaultInfoBatch,
		state:     StateConnecting,
		cache:     map[dirKey]*dirEntry{},
		inflight:  map[dirKey]*flight{},
	}
}

// ID renvoie l'identifiant stable de l'appareil.
func (d *Device) ID() string { return d.id }

// SetIdentity met a jour le nom et le fabricant affiches.
func (d *Device) SetIdentity(name, manufacturer string) {
	d.stMu.Lock()
	d.name, d.manufacturer = name, manufacturer
	d.stMu.Unlock()
}

// SetState change l'etat affiche (sans toucher a la connexion).
func (d *Device) SetState(s State, msg string) {
	d.stMu.Lock()
	d.state, d.errMsg = s, msg
	d.stMu.Unlock()
}

// State renvoie l'etat courant.
func (d *Device) State() State {
	d.stMu.RLock()
	defer d.stMu.RUnlock()
	return d.state
}

// Status renvoie l'etat JSON. Ne prend jamais le verrou des transactions.
func (d *Device) Status() Status {
	d.stMu.RLock()
	defer d.stMu.RUnlock()
	st := Status{
		ID:           d.id,
		Name:         d.name,
		Manufacturer: d.manufacturer,
		State:        d.state,
		Error:        d.errMsg,
		Storages:     []StorageStatus{},
	}
	names := StorageNames(d.storages)
	for i, s := range d.storages {
		st.Storages = append(st.Storages, StorageStatus{Name: names[i], Total: s.Total, Free: s.Free})
	}
	return st
}

// Attach branche une session ouverte. Etat : ready s'il y a au moins un
// stockage, sinon locked.
func (d *Device) Attach(c Conn, storages []Storage) {
	d.mu.Lock()
	old := d.conn
	d.conn = c
	d.closeReq.Store(false)
	d.mu.Unlock()
	if old != nil && old != c {
		_ = old.Close()
	}
	d.invalidateAll()
	d.setStorages(storages)
}

func (d *Device) setStorages(storages []Storage) {
	d.stMu.Lock()
	defer d.stMu.Unlock()
	d.storages = storages
	d.storagesAt = time.Now()
	if d.state == StateBusy || d.state == StateError {
		// un echec concurrent (OnGone) a deja tranche
		return
	}
	if len(storages) > 0 {
		d.state, d.errMsg = StateReady, ""
	} else {
		d.state = StateLocked
		d.errMsg = "no storage exposed: unlock the phone and choose \"File transfer\" in the USB notification"
	}
}

// Close ferme la session (si elle existe) et passe l'appareil dans l'etat
// donne. Attend au plus wait que la transaction en cours se termine ; au
// dela, la fermeture est confiee a cette transaction (fermer le handle
// libusb pendant un transfert en cours n'est pas sur).
func (d *Device) Close(s State, msg string, wait time.Duration) {
	locked := lockWithin(&d.mu, wait)
	var c Conn
	if locked {
		c = d.conn
		d.conn = nil
		d.mu.Unlock()
	} else {
		d.closeReq.Store(true)
	}
	if c != nil {
		_ = c.Close()
	}
	d.invalidateAll()
	d.stMu.Lock()
	d.state, d.errMsg = s, msg
	d.storages = nil
	d.stMu.Unlock()
}

func lockWithin(mu *sync.Mutex, wait time.Duration) bool {
	deadline := time.Now().Add(wait)
	for {
		if mu.TryLock() {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// WithConn execute fn sous le verrou des transactions (pour les
// gestionnaires : re-interrogation des stockages d'un appareil verrouille).
func (d *Device) WithConn(fn func(c Conn) error) error {
	return d.do(fn)
}

// RefreshStorages relit la liste des stockages. Si wait est faux et qu'une
// transaction est en cours (gros upload), garde la liste en cache.
func (d *Device) RefreshStorages(wait bool) error {
	if wait {
		d.mu.Lock()
	} else if !d.mu.TryLock() {
		return nil
	}
	defer d.mu.Unlock()
	var st []Storage
	err := d.doLocked(func(c Conn) error {
		var err error
		st, err = c.Storages()
		return err
	})
	if err != nil {
		return err
	}
	d.stMu.RLock()
	changed := len(st) != len(d.storages)
	for i := 0; !changed && i < len(st); i++ {
		changed = st[i].ID != d.storages[i].ID
	}
	d.stMu.RUnlock()
	if changed {
		d.invalidateAll()
	}
	d.setStorages(st)
	return nil
}

func (d *Device) storageList() ([]Storage, time.Time) {
	d.stMu.RLock()
	defer d.stMu.RUnlock()
	return d.storages, d.storagesAt
}

// do execute fn sous le verrou des transactions.
func (d *Device) do(fn func(c Conn) error) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.doLocked(fn)
}

func (d *Device) doLocked(fn func(c Conn) error) error {
	if d.conn == nil {
		return d.notReady()
	}
	err := fn(d.conn)
	if errors.Is(err, ErrGone) {
		d.goneLocked(err)
	} else if d.closeReq.Swap(false) {
		// Close() n'a pas pu attendre cette transaction
		c := d.conn
		d.conn = nil
		_ = c.Close()
	}
	return err
}

// goneLocked ferme la connexion apres une erreur USB (appareil debranche ou
// session cassee). Appele avec mu tenu.
func (d *Device) goneLocked(err error) {
	c := d.conn
	d.conn = nil
	if c != nil {
		_ = c.Close()
	}
	d.invalidateAll()
	d.stMu.Lock()
	d.state, d.errMsg = StateError, err.Error()
	d.storages = nil
	d.stMu.Unlock()
	if d.OnGone != nil {
		go d.OnGone(d, err)
	}
}

func (d *Device) notReady() error {
	d.stMu.RLock()
	defer d.stMu.RUnlock()
	s := d.state
	if s == StateReady {
		// etat pas encore mis a jour mais connexion deja fermee
		s = StateError
	}
	return &NotReadyError{State: s, Msg: d.errMsg}
}

// checkReady verifie, sans prendre le verrou des transactions, que
// l'appareil peut servir des requetes WebDAV.
func (d *Device) checkReady() error {
	d.stMu.RLock()
	defer d.stMu.RUnlock()
	if d.state != StateReady || len(d.storages) == 0 {
		s := d.state
		if s == StateReady {
			s = StateLocked
		}
		return &NotReadyError{State: s, Msg: d.errMsg}
	}
	return nil
}

// --- cache des listings ---

func (d *Device) invalidate(keys ...dirKey) {
	d.cacheMu.Lock()
	d.gen++
	for _, k := range keys {
		delete(d.cache, k)
	}
	d.cacheMu.Unlock()
}

func (d *Device) invalidateAll() {
	d.cacheMu.Lock()
	d.gen++
	clear(d.cache)
	d.cacheMu.Unlock()
}

// list renvoie les enfants d'un dossier, depuis le cache si possible. Les
// requetes simultanees sur le meme dossier partagent la meme lecture.
func (d *Device) list(ctx context.Context, k dirKey) ([]Object, error) {
	d.cacheMu.Lock()
	if e := d.cache[k]; e != nil && time.Since(e.at) < d.CacheTTL {
		d.cacheMu.Unlock()
		return e.objs, nil
	}
	if f := d.inflight[k]; f != nil && f.gen == d.gen {
		d.cacheMu.Unlock()
		select {
		case <-f.done:
			return f.objs, f.err
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	f := &flight{gen: d.gen, done: make(chan struct{})}
	d.inflight[k] = f
	d.cacheMu.Unlock()

	objs, err := d.fetch(ctx, k)

	d.cacheMu.Lock()
	if d.inflight[k] == f {
		delete(d.inflight, k)
	}
	if err == nil && f.gen == d.gen {
		d.cache[k] = &dirEntry{objs: objs, at: time.Now()}
	}
	d.cacheMu.Unlock()
	f.objs, f.err = objs, err
	close(f.done)
	return objs, err
}

// fetch lit un dossier sur l'appareil : GetObjectHandles puis un
// GetObjectInfo par enfant, par lots, en rendant le verrou entre deux lots
// pour qu'un telechargement en cours continue d'avancer.
func (d *Device) fetch(ctx context.Context, k dirKey) ([]Object, error) {
	var handles []uint32
	err := d.do(func(c Conn) error {
		var err error
		handles, err = c.Handles(k.storage, k.parent)
		return err
	})
	if err != nil {
		return nil, err
	}
	objs := make([]Object, 0, len(handles))
	batch := max(d.InfoBatch, 1)
	for i := 0; i < len(handles); i += batch {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		end := min(i+batch, len(handles))
		err := d.do(func(c Conn) error {
			for _, h := range handles[i:end] {
				o, err := c.Info(h)
				if errors.Is(err, ErrNotFound) {
					continue // objet disparu entre-temps
				}
				if err != nil {
					return err
				}
				if o.Name == "" || o.Name == "." || o.Name == ".." {
					continue
				}
				objs = append(objs, o)
			}
			return nil
		})
		if err != nil {
			return nil, err
		}
	}
	return objs, nil
}
