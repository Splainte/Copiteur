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
	DefaultChunkSize      = 8 << 20
	DefaultCacheTTL       = 4 * time.Second
	DefaultMaxPad         = 256 << 20
	DefaultInfoBatch      = 32
	DefaultIncrementalMin = 256
	DefaultFullRefreshAge = 10 * time.Minute
	DefaultRecentAge      = 10 * time.Minute
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
	// FullRefreshAge : au-dela, un gros dossier est relu en entier (pas par
	// difference), pour rattraper les fichiers modifies sur le telephone.
	FullRefreshAge time.Duration
	// RecentAge : dans un rafraichissement par difference, les objets
	// modifies il y a moins de RecentAge (ou de taille 0 : en cours
	// d'ecriture) sont relus quand meme.
	RecentAge time.Duration
	// IncrementalMin : un dossier en cache d'au moins ce nombre d'objets est
	// rafraichi par difference de handles (un seul GetObjectHandles puis
	// GetObjectInfo des seuls nouveaux handles) au lieu d'etre relu en
	// entier. Indispensable pour DCIM/Camera (des dizaines de milliers de
	// photos = des minutes de GetObjectInfo). Contrepartie : un fichier
	// modifie SUR le telephone en gardant son handle n'est pas relu.
	IncrementalMin int

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
	// sess change a chaque nouvelle session MTP (Attach, Resync, perte de
	// l'appareil) : les handles d'une session ne valent rien dans la
	// suivante. Modifie sous mu. Voir Pin.
	sess atomic.Uint64

	cacheMu  sync.Mutex
	cache    map[dirKey]*dirEntry
	inflight map[dirKey]*flight
	kgen     map[dirKey]uint64 // generation par dossier (invalidate)
	epoch    uint64            // generation globale (invalidateAll)
}

type dirKey struct {
	storage uint32
	parent  uint32
}

type dirEntry struct {
	objs   []Object
	at     time.Time
	fullAt time.Time // derniere lecture complete (sans difference)
	stale  bool      // modifie par nous : a rafraichir (par difference si gros)
}

type cacheGen struct{ k, epoch uint64 }

type flight struct {
	gen  cacheGen
	done chan struct{}
	objs []Object
	err  error
}

// NewDevice cree un appareil dans l'etat "connecting".
func NewDevice(id string) *Device {
	return &Device{
		id:             id,
		ChunkSize:      DefaultChunkSize,
		CacheTTL:       DefaultCacheTTL,
		MaxPad:         DefaultMaxPad,
		InfoBatch:      DefaultInfoBatch,
		IncrementalMin: DefaultIncrementalMin,
		FullRefreshAge: DefaultFullRefreshAge,
		RecentAge:      DefaultRecentAge,
		state:          StateConnecting,
		cache:          map[dirKey]*dirEntry{},
		inflight:       map[dirKey]*flight{},
		kgen:           map[dirKey]uint64{},
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
	d.sess.Add(1)
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
	return d.do(context.Background(), fn)
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

type sessKey struct{ d *Device }

// Pin attache a ctx la session MTP courante. Toute transaction faite
// ensuite avec ce ctx echoue (ErrDesync -> 503, rclone reessaie) si la
// session a change entre-temps (Resync apres un upload coupe, reouverture) :
// les handles resolus avant ne designent plus forcement le meme objet.
// Sans effet si ctx est deja epingle.
func (d *Device) Pin(ctx context.Context) context.Context {
	if _, ok := ctx.Value(sessKey{d}).(uint64); ok {
		return ctx
	}
	return context.WithValue(ctx, sessKey{d}, d.sess.Load())
}

// repin epingle ctx sur la session courante (nettoyage apres notre propre
// Resync).
func (d *Device) repin(ctx context.Context) context.Context {
	return context.WithValue(ctx, sessKey{d}, d.sess.Load())
}

// sessOKLocked verifie la session epinglee (mu tenu).
func (d *Device) sessOKLocked(ctx context.Context) error {
	if v, ok := ctx.Value(sessKey{d}).(uint64); ok && v != d.sess.Load() {
		return fmt.Errorf("%w: the MTP session was reset during the request, retry", ErrDesync)
	}
	return nil
}

// do execute fn sous le verrou des transactions, si la session epinglee
// dans ctx est toujours la bonne.
func (d *Device) do(ctx context.Context, fn func(c Conn) error) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if err := d.sessOKLocked(ctx); err != nil {
		return err
	}
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
	d.sess.Add(1)
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

// invalidate marque des dossiers comme modifies : la prochaine lecture
// relit leurs handles (et seulement les nouveaux objets si le dossier est
// gros). Les lectures en cours sur ces dossiers ne seront pas mises en
// cache.
func (d *Device) invalidate(keys ...dirKey) {
	d.cacheMu.Lock()
	for _, k := range keys {
		d.kgen[k]++
		if e := d.cache[k]; e != nil {
			e.stale = true
		}
	}
	d.cacheMu.Unlock()
}

// forget retire un objet du cache d'un dossier (ses metadonnees ont
// change, ex. renommage : il sera relu).
func (d *Device) forget(k dirKey, h uint32) {
	d.cacheMu.Lock()
	d.kgen[k]++
	if e := d.cache[k]; e != nil {
		objs := make([]Object, 0, len(e.objs))
		for _, o := range e.objs {
			if o.Handle != h {
				objs = append(objs, o)
			}
		}
		e.objs, e.stale = objs, true
	}
	d.cacheMu.Unlock()
}

// invalidateAll vide tout le cache (nouvelle session : les handles ont pu
// etre renumerotes).
func (d *Device) invalidateAll() {
	d.cacheMu.Lock()
	d.epoch++
	clear(d.cache)
	d.cacheMu.Unlock()
}

func (d *Device) genLocked(k dirKey) cacheGen { return cacheGen{d.kgen[k], d.epoch} }

// list renvoie les enfants d'un dossier, depuis le cache si possible. Les
// requetes simultanees sur le meme dossier partagent la meme lecture.
func (d *Device) list(ctx context.Context, k dirKey) ([]Object, error) {
	return d.listEmit(ctx, k, nil)
}

// emitError : erreur du consommateur d'un listing en flux (client parti,
// ecriture impossible). Ce n'est pas une erreur de l'appareil : ceux qui
// attendaient la meme lecture la refont au lieu d'echouer.
type emitError struct{ err error }

func (e *emitError) Error() string { return "listing consumer: " + e.err.Error() }
func (e *emitError) Unwrap() error { return e.err }

// listEmit est list avec, si emit != nil, transmission des objets au fur
// et a mesure de leur lecture (PROPFIND en flux : des octets partent vers
// le client meme si le dossier met des minutes a etre lu). Une erreur
// d'emit interrompt la lecture.
func (d *Device) listEmit(ctx context.Context, k dirKey, emit func([]Object) error) ([]Object, error) {
	if emit != nil {
		user := emit
		emit = func(objs []Object) error {
			if err := user(objs); err != nil {
				return &emitError{err}
			}
			return nil
		}
	}
	for {
		d.cacheMu.Lock()
		e := d.cache[k]
		if e != nil && !e.stale && time.Since(e.at) < d.CacheTTL {
			objs := e.objs
			d.cacheMu.Unlock()
			if emit != nil {
				if err := emit(objs); err != nil {
					return nil, err
				}
			}
			return objs, nil
		}
		var prev []Object
		var prevFull time.Time
		if e != nil {
			prev, prevFull = e.objs, e.fullAt
		}
		cur := d.inflight[k]
		if emit == nil && cur != nil && cur.gen == d.genLocked(k) {
			// une lecture identique est en cours : on l'attend. (En mode
			// flux on ne l'attend pas : il faut que des octets partent.)
			d.cacheMu.Unlock()
			select {
			case <-cur.done:
			case <-ctx.Done():
				return nil, ctx.Err()
			}
			var ee *emitError
			if cur.err != nil && (errors.Is(cur.err, context.Canceled) || errors.Is(cur.err, context.DeadlineExceeded) ||
				errors.As(cur.err, &ee) || errors.Is(cur.err, ErrDesync)) {
				// echec propre a l'autre requete (client parti, session
				// epinglee perimee) : on relit nous-memes
				continue
			}
			return cur.objs, cur.err
		}
		f := &flight{gen: d.genLocked(k), done: make(chan struct{})}
		if cur == nil || cur.gen != f.gen || emit == nil {
			d.inflight[k] = f
		}
		d.cacheMu.Unlock()

		objs, full, err := d.fetch(ctx, k, prev, prevFull, emit)

		d.cacheMu.Lock()
		if d.inflight[k] == f {
			delete(d.inflight, k)
		}
		if err == nil && f.gen == d.genLocked(k) {
			ne := &dirEntry{objs: objs, at: time.Now(), fullAt: prevFull}
			if full {
				ne.fullAt = ne.at
			}
			d.cache[k] = ne
		}
		d.cacheMu.Unlock()
		f.objs, f.err = objs, err
		close(f.done)
		return objs, err
	}
}

// updateCached remplace (ou retire si gone) un objet dans le cache de son
// dossier, apres une relecture fraiche.
func (d *Device) updateCached(k dirKey, o Object, gone bool) {
	d.cacheMu.Lock()
	defer d.cacheMu.Unlock()
	e := d.cache[k]
	if e == nil {
		return
	}
	objs := make([]Object, 0, len(e.objs))
	for _, x := range e.objs {
		if x.Handle != o.Handle {
			objs = append(objs, x)
		} else if !gone {
			objs = append(objs, o)
		}
	}
	e.objs = objs
}

// fetch lit un dossier sur l'appareil : GetObjectHandles puis un
// GetObjectInfo par enfant, par lots, en rendant le verrou entre deux lots
// pour qu'un telechargement en cours continue d'avancer.
//
// Gros dossier deja lu (voir IncrementalMin) : seuls sont relus les
// nouveaux handles et les objets recents (modifies depuis moins de
// RecentAge, ou de taille 0 : photo/video peut-etre en cours d'ecriture) ;
// relecture complete si la derniere date de plus de FullRefreshAge.
// full = lecture complete.
func (d *Device) fetch(ctx context.Context, k dirKey, prev []Object, prevFull time.Time, emit func([]Object) error) (objs []Object, full bool, err error) {
	var handles []uint32
	err = d.do(ctx, func(c Conn) error {
		var err error
		handles, err = c.Handles(k.storage, k.parent)
		return err
	})
	if err != nil {
		return nil, false, err
	}
	objs = make([]Object, 0, len(handles))
	todo := handles
	full = true
	if d.IncrementalMin > 0 && len(prev) >= d.IncrementalMin && time.Since(prevFull) < d.FullRefreshAge {
		full = false
		known := make(map[uint32]Object, len(prev))
		for _, o := range prev {
			known[o.Handle] = o
		}
		recent := time.Now().Add(-d.RecentAge)
		todo = nil
		for _, h := range handles {
			o, ok := known[h]
			if ok && (o.IsDir || (o.Size > 0 && o.ModTime.Before(recent) && !o.ModTime.IsZero())) {
				objs = append(objs, o)
			} else {
				todo = append(todo, h)
			}
		}
		if emit != nil && len(objs) > 0 {
			if err := emit(objs); err != nil {
				return nil, false, err
			}
		}
	}
	batch := max(d.InfoBatch, 1)
	for i := 0; i < len(todo); i += batch {
		if err := ctx.Err(); err != nil {
			return nil, false, err
		}
		end := min(i+batch, len(todo))
		start := len(objs)
		err := d.do(ctx, func(c Conn) error {
			for _, h := range todo[i:end] {
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
			return nil, false, err
		}
		if emit != nil && len(objs) > start {
			if err := emit(objs[start:]); err != nil {
				return nil, false, err
			}
		}
	}
	return objs, full, nil
}
