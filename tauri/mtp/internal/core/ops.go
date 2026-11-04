package core

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"sync"
	"time"
)

var bufPool = sync.Pool{New: func() any { return new(bytes.Buffer) }}

// ReadRange envoie length octets du fichier n a partir de off dans w.
// Lecture par blocs (ChunkSize) avec un verrou repris a chaque bloc ; si
// l'appareil ne sait pas lire partiellement ce fichier, une seule
// transaction GetObject (verrou tenu tout du long).
func (d *Device) ReadRange(ctx context.Context, n Node, off, length int64, w io.Writer) error {
	if n.kind != nodeObject || n.Obj.IsDir {
		return ErrIsDir
	}
	if length <= 0 {
		return nil
	}
	h := n.Obj.Handle
	partial := false
	if err := d.do(func(c Conn) error { partial = c.PartialRead(n.Obj.Size); return nil }); err != nil {
		return err
	}
	if !partial {
		ww := &windowWriter{w: w, skip: off, remain: length}
		if err := d.do(func(c Conn) error { return c.ReadAll(h, ww) }); err != nil {
			return err
		}
		if ww.err != nil {
			return ww.err
		}
		if ww.remain > 0 {
			return io.ErrUnexpectedEOF
		}
		return nil
	}
	buf := bufPool.Get().(*bytes.Buffer)
	defer bufPool.Put(buf)
	chunk := int64(max(d.ChunkSize, 4096))
	for length > 0 {
		if err := ctx.Err(); err != nil {
			return err
		}
		want := min(chunk, length)
		buf.Reset()
		err := d.do(func(c Conn) error { return c.ReadPartial(h, off, uint32(want), buf) })
		if err != nil {
			return err
		}
		b := buf.Bytes()
		if len(b) == 0 {
			return io.ErrUnexpectedEOF
		}
		if int64(len(b)) > want {
			b = b[:want]
		}
		if _, err := w.Write(b); err != nil {
			return err // client parti : on s'arrete apres ce bloc
		}
		off += int64(len(b))
		length -= int64(len(b))
	}
	return nil
}

// windowWriter ne garde que [skip, skip+remain) du flux et n'echoue jamais :
// une transaction GetObject doit aller au bout meme si le client est parti.
type windowWriter struct {
	w      io.Writer
	skip   int64
	remain int64
	err    error
}

func (ww *windowWriter) Write(p []byte) (int, error) {
	n := len(p)
	if ww.skip > 0 {
		k := min(ww.skip, int64(len(p)))
		ww.skip -= k
		p = p[k:]
	}
	if ww.err == nil && ww.remain > 0 && len(p) > 0 {
		k := min(ww.remain, int64(len(p)))
		if _, err := ww.w.Write(p[:k]); err != nil {
			ww.err = err
		}
		ww.remain -= k
	}
	return n, nil
}

// padReader lit exactement size octets. Si le corps s'arrete avant et que
// le reste a envoyer est <= maxPad, il complete avec des zeros pour que la
// transaction SendObject se termine normalement (l'objet est supprime
// ensuite) ; sinon il renvoie une erreur et la session devra etre
// resynchronisee.
type padReader struct {
	r      io.Reader
	size   int64
	read   int64 // octets fournis (corps + bourrage)
	got    int64 // octets reellement recus du corps
	maxPad int64
	short  bool  // le corps s'est arrete trop tot
	cause  error // erreur de lecture du corps
	pad    bool
}

var errAbortUpload = errors.New("upload aborted: request body ended early")

func (p *padReader) Read(b []byte) (int, error) {
	if p.read >= p.size {
		return 0, io.EOF
	}
	if int64(len(b)) > p.size-p.read {
		b = b[:p.size-p.read]
	}
	if p.pad {
		clear(b)
		p.read += int64(len(b))
		return len(b), nil
	}
	n, err := p.r.Read(b)
	p.read += int64(n)
	p.got += int64(n)
	if err != nil && p.read < p.size {
		p.short = true
		p.cause = err
		if err == io.EOF {
			p.cause = io.ErrUnexpectedEOF
		}
		if p.size-p.read <= p.maxPad {
			p.pad = true
			if n == 0 {
				return p.Read(b)
			}
			return n, nil
		}
		return n, errAbortUpload
	}
	return n, nil
}

// parentFor resout le dossier qui doit contenir un nouvel element.
func (d *Device) parentFor(ctx context.Context, p string) (Node, string, error) {
	parentPath, name := SplitPath(p)
	if err := ValidName(name); err != nil {
		return Node{}, "", err
	}
	pn, err := d.Resolve(ctx, parentPath)
	if errors.Is(err, ErrNotFound) {
		return Node{}, "", fmt.Errorf("%w: %s", ErrConflict, parentPath)
	}
	if err != nil {
		return Node{}, "", err
	}
	if !pn.IsDir() {
		return Node{}, "", fmt.Errorf("%w: %s", ErrConflict, parentPath)
	}
	if pn.kind == nodeVirtualRoot {
		return Node{}, "", fmt.Errorf("%w: cannot create files next to the storages", ErrForbidden)
	}
	return pn, name, nil
}

// Put cree ou remplace le fichier p avec size octets lus dans body.
// created = true si le fichier n'existait pas.
func (d *Device) Put(ctx context.Context, p string, size int64, mtime time.Time, body io.Reader) (created bool, err error) {
	pn, name, err := d.parentFor(ctx, p)
	if err != nil {
		return false, err
	}
	objs, err := d.list(ctx, pn.key())
	if err != nil {
		return false, err
	}
	existing, exists := findName(objs, name)
	if exists && existing.IsDir {
		return false, fmt.Errorf("%w: %s", ErrIsDir, p)
	}
	key := pn.key()
	defer d.invalidate(key)
	dst := joinPath(pn.Path, name)

	created, cleanup, err := d.putLocked(key, name, existing, exists, size, mtime, body)
	if cleanup {
		// Nettoyage par CHEMIN, verrou rendu, cache vide : apres un
		// Resync les handles de l'ancienne session ne sont plus fiables.
		if cerr := d.deleteFileByPath(context.WithoutCancel(ctx), dst); cerr != nil {
			log.Printf("WARNING: could not delete the incomplete file %q: %v (it may remain on the phone)", dst, cerr)
			return false, fmt.Errorf("%w (and the incomplete file could not be deleted: %v)", err, cerr)
		}
	}
	return created, err
}

// putLocked fait l'envoi sous le verrou. cleanup = un fichier incomplet a
// peut-etre ete laisse a l'emplacement de destination et doit etre
// supprime par chemin (apres Resync).
func (d *Device) putLocked(key dirKey, name string, existing Object, exists bool, size int64, mtime time.Time, body io.Reader) (created, cleanup bool, err error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if exists {
		// MTP ne sait pas ecraser : on supprime d'abord.
		//
		// (Envoyer sous un nom temporaire puis renommer protegerait
		// l'original si l'envoi echoue, mais rclone supprime de toute
		// facon le fichier de destination apres un PUT rate
		// (Object.Update -> Remove), et un renommage MTP de plus par
		// fichier coute cher sur les gros dossiers : comportement garde.)
		err := d.doLocked(func(c Conn) error { return c.Delete(existing.Handle) })
		if err != nil && !errors.Is(err, ErrNotFound) {
			return false, false, err
		}
		d.invalidate(key)
	}
	pr := &padReader{r: body, size: size, maxPad: d.MaxPad}
	var h uint32
	err = d.doLocked(func(c Conn) error {
		var err error
		h, err = c.Send(key.storage, key.parent, name, size, mtime, pr)
		return err
	})
	if err == nil && !pr.short {
		return !exists, false, nil
	}
	if errors.Is(err, ErrGone) || errors.Is(err, ErrNotReady) {
		return false, false, err
	}
	if err == nil {
		// Transaction terminee avec du bourrage : l'objet a la bonne taille
		// mais finit par des zeros. Il ne doit JAMAIS rester : on insiste,
		// puis on se rabat sur Resync + suppression par chemin.
		log.Printf("upload of %q interrupted after %d/%d bytes (padded with zeros), deleting partial object", name, pr.got, size)
		incomplete := fmt.Errorf("%w: %v", ErrIncomplete, pr.cause)
		var derr error
		for range 2 {
			derr = d.doLocked(func(c Conn) error { return c.Delete(h) })
			if derr == nil || errors.Is(derr, ErrNotFound) {
				return false, false, incomplete
			}
			if errors.Is(derr, ErrGone) {
				log.Printf("WARNING: device gone, the zero-padded file %q may remain on the phone", name)
				return false, false, incomplete
			}
		}
		log.Printf("could not delete zero-padded object %q: %v; resyncing", name, derr)
		if rerr := d.resyncLocked(); rerr != nil {
			return false, false, fmt.Errorf("%w (zero-padded file may remain: %v)", incomplete, rerr)
		}
		return false, true, incomplete
	}
	if errors.Is(err, ErrDesync) || pr.short {
		log.Printf("upload of %q interrupted (%v), resyncing the MTP session", name, err)
		if rerr := d.resyncLocked(); rerr != nil {
			return false, false, err
		}
		// Android supprime en general lui-meme le fichier partiel ; on
		// verifie quand meme (par chemin, une fois le verrou rendu).
		if pr.short {
			err = fmt.Errorf("%w: %v", ErrIncomplete, pr.cause)
		}
		return false, true, err
	}
	// erreur "propre" (refus de SendObjectInfo, stockage plein pendant
	// l'ecriture...) : la session est saine, le handle valide.
	if h != 0 {
		_ = d.doLocked(func(c Conn) error { return c.Delete(h) })
	}
	return false, false, err
}

// resyncLocked : Resync de la session puis invalidation COMPLETE du cache
// (la nouvelle session peut renumeroter les handles : garder d'anciens
// listings ferait lire ou supprimer un autre objet). Appele avec mu tenu.
func (d *Device) resyncLocked() error {
	rerr := d.doLocked(func(c Conn) error { return c.Resync() })
	d.invalidateAll()
	if rerr != nil && !errors.Is(rerr, ErrGone) && !errors.Is(rerr, ErrNotReady) {
		d.goneLocked(fmt.Errorf("%w: resync failed: %v", ErrGone, rerr))
	}
	return rerr
}

// deleteFileByPath supprime le FICHIER p s'il existe (resolution fraiche
// par chemin ; jamais un dossier). Sans verrou.
func (d *Device) deleteFileByPath(ctx context.Context, p string) error {
	var err error
	for range 2 {
		var n Node
		n, err = d.Resolve(ctx, p)
		if errors.Is(err, ErrNotFound) {
			return nil
		}
		if err != nil {
			continue
		}
		if n.kind != nodeObject || n.Obj.IsDir {
			return nil
		}
		log.Printf("deleting incomplete file %q", p)
		err = d.do(func(c Conn) error { return c.Delete(n.Obj.Handle) })
		d.invalidate(n.parent)
		if err == nil || errors.Is(err, ErrNotFound) {
			return nil
		}
	}
	return err
}

// Delete supprime un fichier ou un dossier (recursif).
func (d *Device) Delete(ctx context.Context, p string) error {
	n, err := d.Resolve(ctx, p)
	if err != nil {
		return err
	}
	if n.kind != nodeObject {
		return fmt.Errorf("%w: cannot delete a storage root", ErrForbidden)
	}
	err = d.deleteObj(ctx, n.Obj)
	if n.Obj.IsDir {
		d.invalidateAll()
	} else {
		d.invalidate(n.parent)
	}
	return err
}

func (d *Device) deleteObj(ctx context.Context, o Object) error {
	err := d.do(func(c Conn) error { return c.Delete(o.Handle) })
	if err == nil || errors.Is(err, ErrNotFound) {
		return nil
	}
	if !o.IsDir || errors.Is(err, ErrGone) || errors.Is(err, ErrNotReady) || errors.Is(err, ErrReadOnly) {
		return err
	}
	// Repli : suppression manuelle du contenu puis du dossier.
	log.Printf("DeleteObject on folder %q failed (%v), deleting recursively", o.Name, err)
	children, ferr := d.fetch(ctx, dirKey{storage: o.StorageID, parent: o.Handle}, nil, nil)
	if ferr != nil {
		return ferr
	}
	for _, ch := range children {
		if err := d.deleteObj(ctx, ch); err != nil {
			return err
		}
	}
	err = d.do(func(c Conn) error { return c.Delete(o.Handle) })
	if errors.Is(err, ErrNotFound) {
		return nil
	}
	return err
}

// Mkdir cree un dossier.
func (d *Device) Mkdir(ctx context.Context, p string) error {
	if _, err := d.Resolve(ctx, p); err == nil {
		// existe deja (y compris la racine ou un stockage) : 405
		return fmt.Errorf("%w: %s", ErrExists, p)
	}
	pn, name, err := d.parentFor(ctx, p)
	if err != nil {
		return err
	}
	objs, err := d.list(ctx, pn.key())
	if err != nil {
		return err
	}
	if _, ok := findName(objs, name); ok {
		return fmt.Errorf("%w: %s", ErrExists, p)
	}
	key := pn.key()
	defer d.invalidate(key)
	return d.do(func(c Conn) error {
		_, err := c.CreateFolder(key.storage, key.parent, name)
		return err
	})
}

// prepareDest resout la destination d'un MOVE/COPY et supprime l'element
// existant si overwrite. Renvoie le dossier parent, le nom et si la
// destination existait.
func (d *Device) prepareDest(ctx context.Context, src Node, dst string, overwrite bool) (Node, string, bool, error) {
	pn, name, err := d.parentFor(ctx, dst)
	if err != nil {
		return Node{}, "", false, err
	}
	objs, err := d.list(ctx, pn.key())
	if err != nil {
		return Node{}, "", false, err
	}
	existing, exists := findName(objs, name)
	if exists && existing.Handle == src.Obj.Handle {
		// meme objet (changement de casse seulement) : pas un ecrasement
		return pn, name, false, nil
	}
	if exists {
		if !overwrite {
			return Node{}, "", true, fmt.Errorf("%w: %s", ErrPrecondition, dst)
		}
		if err := d.deleteObj(ctx, existing); err != nil {
			return Node{}, "", true, err
		}
		if existing.IsDir {
			d.invalidateAll()
		} else {
			d.invalidate(pn.key())
		}
	}
	return pn, name, exists, nil
}

func isInside(child, parent string) bool {
	return parent == "" || child == parent || (len(child) > len(parent) && child[:len(parent)] == parent && child[len(parent)] == '/')
}

// Move deplace/renomme src vers dst.
func (d *Device) Move(ctx context.Context, src, dst string, overwrite bool) (existed bool, err error) {
	sn, err := d.Resolve(ctx, src)
	if err != nil {
		return false, err
	}
	if sn.kind != nodeObject {
		return false, fmt.Errorf("%w: cannot move a storage root", ErrForbidden)
	}
	dst = CleanPath(dst)
	if dst == sn.Path {
		return false, fmt.Errorf("%w: source and destination are the same", ErrForbidden)
	}
	if sn.Obj.IsDir && isInside(dst, sn.Path) && !samePathFold(dst, sn.Path) {
		return false, fmt.Errorf("%w: cannot move a folder into itself", ErrForbidden)
	}
	pn, name, existed, err := d.prepareDest(ctx, sn, dst, overwrite)
	if err != nil {
		return existed, err
	}
	dk := pn.key()
	o := sn.Obj
	defer func() {
		if o.IsDir {
			d.invalidateAll()
			return
		}
		// fichier : seuls les deux dossiers changent ; l'objet est oublie
		// (son nom a pu changer, il sera relu)
		d.forget(sn.parent, o.Handle)
		d.forget(dk, o.Handle)
	}()
	if dk == sn.parent {
		if o.Name == name {
			return existed, nil
		}
		err := d.do(func(c Conn) error { return c.Rename(o.Handle, name) })
		if errors.Is(err, ErrNotSupported) && !o.IsDir {
			return existed, d.copyThenDelete(ctx, o, dk, name, dst)
		}
		return existed, err
	}
	return existed, d.moveObj(ctx, o, sn.parent, dk, name, dst)
}

func samePathFold(a, b string) bool {
	return len(a) == len(b) && bytes.EqualFold([]byte(a), []byte(b))
}

// moveObj deplace o (dans le dossier from) vers le dossier to sous le nom
// name, avec repli copie+suppression.
func (d *Device) moveObj(ctx context.Context, o Object, from, to dirKey, name, dstPath string) error {
	// MoveObject garde le nom : s'il est deja pris dans la destination, on
	// renomme d'abord la source avec un nom temporaire.
	destObjs, err := d.list(ctx, to)
	if err != nil {
		return err
	}
	moveName := o.Name
	if _, clash := findName(destObjs, o.Name); clash && o.Name != name {
		tmp := fmt.Sprintf(".copiteur-move-%d", time.Now().UnixNano())
		if err := d.do(func(c Conn) error { return c.Rename(o.Handle, tmp) }); err != nil {
			return err
		}
		d.forget(from, o.Handle)
		moveName = tmp
	}
	err = d.do(func(c Conn) error { return c.Move(o.Handle, to.storage, to.parent) })
	if errors.Is(err, ErrNotSupported) {
		if o.IsDir {
			return d.moveDirManually(ctx, o, to, name, dstPath)
		}
		return d.copyThenDelete(ctx, o, to, name, dstPath)
	}
	if err != nil {
		return err
	}
	if moveName != name {
		return d.do(func(c Conn) error { return c.Rename(o.Handle, name) })
	}
	return nil
}

// moveDirManually : repli quand MoveObject n'existe pas pour un dossier.
func (d *Device) moveDirManually(ctx context.Context, o Object, to dirKey, name, dstPath string) error {
	var nh uint32
	err := d.do(func(c Conn) error {
		var err error
		nh, err = c.CreateFolder(to.storage, to.parent, name)
		return err
	})
	if err != nil {
		return err
	}
	from := dirKey{storage: o.StorageID, parent: o.Handle}
	children, err := d.fetch(ctx, from, nil, nil)
	if err != nil {
		return err
	}
	nk := dirKey{storage: to.storage, parent: nh}
	for _, ch := range children {
		if ch.IsDir {
			err = d.moveDirManually(ctx, ch, nk, ch.Name, dstPath+"/"+ch.Name)
		} else {
			err = d.copyThenDelete(ctx, ch, nk, ch.Name, dstPath+"/"+ch.Name)
		}
		if err != nil {
			return err
		}
	}
	return d.deleteObj(ctx, o)
}

// copyThenDelete : repli de MOVE pour un fichier.
func (d *Device) copyThenDelete(ctx context.Context, o Object, to dirKey, name, dstPath string) error {
	if err := d.copyFile(ctx, o, to, name, dstPath); err != nil {
		return err
	}
	return d.deleteObj(ctx, o)
}

// Copy copie le fichier src vers dst.
func (d *Device) Copy(ctx context.Context, src, dst string, overwrite bool) (existed bool, err error) {
	sn, err := d.Resolve(ctx, src)
	if err != nil {
		return false, err
	}
	if sn.kind != nodeObject {
		return false, fmt.Errorf("%w: cannot copy a storage root", ErrForbidden)
	}
	if sn.Obj.IsDir {
		return false, fmt.Errorf("%w: COPY of a folder", ErrNotSupported)
	}
	dst = CleanPath(dst)
	if dst == sn.Path {
		return false, fmt.Errorf("%w: source and destination are the same", ErrForbidden)
	}
	pn, name, existed, err := d.prepareDest(ctx, sn, dst, overwrite)
	if err != nil {
		return existed, err
	}
	if _, same := findNameSameHandle(ctx, d, pn, name, sn.Obj.Handle); same {
		// copie sur soi-meme a la casse pres
		return existed, fmt.Errorf("%w: source and destination are the same", ErrForbidden)
	}
	defer d.invalidate(pn.key())
	return existed, d.copyFile(ctx, sn.Obj, pn.key(), name, dst)
}

func findNameSameHandle(ctx context.Context, d *Device, pn Node, name string, h uint32) (Object, bool) {
	objs, err := d.list(ctx, pn.key())
	if err != nil {
		return Object{}, false
	}
	o, ok := findName(objs, name)
	return o, ok && o.Handle == h
}

// copyFile copie un fichier dans le dossier to sous le nom name :
// CopyObject (+ renommage) si possible, sinon lecture vers un fichier
// temporaire puis envoi. dstPath (chemin de la destination) sert au
// nettoyage si l'envoi est interrompu.
func (d *Device) copyFile(ctx context.Context, o Object, to dirKey, name, dstPath string) error {
	destObjs, err := d.list(ctx, to)
	if err != nil {
		return err
	}
	_, clash := findName(destObjs, o.Name)
	if !clash || o.Name == name {
		var nh uint32
		err := d.do(func(c Conn) error {
			var err error
			nh, err = c.Copy(o.Handle, to.storage, to.parent)
			return err
		})
		d.invalidate(to)
		if err == nil {
			if o.Name == name {
				return nil
			}
			err = d.do(func(c Conn) error { return c.Rename(nh, name) })
			d.forget(to, nh)
			if err == nil {
				return nil
			}
			_ = d.do(func(c Conn) error { return c.Delete(nh) })
			if errors.Is(err, ErrGone) {
				return err
			}
		} else if errors.Is(err, ErrGone) || errors.Is(err, ErrStoreFull) || errors.Is(err, ErrReadOnly) {
			return err
		}
		log.Printf("CopyObject unavailable for %q (%v), copying through a temporary file", o.Name, err)
	}
	return d.streamCopy(ctx, o, to, name, dstPath)
}

func (d *Device) streamCopy(ctx context.Context, o Object, to dirKey, name, dstPath string) error {
	tmp, err := os.CreateTemp("", "copiteur-mtp-copy-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()
	n := Node{kind: nodeObject, Obj: o}
	if err := d.ReadRange(ctx, n, 0, o.Size, tmp); err != nil {
		return err
	}
	if _, err := tmp.Seek(0, io.SeekStart); err != nil {
		return err
	}
	defer d.invalidate(to)
	cleanup, err := func() (bool, error) {
		d.mu.Lock()
		defer d.mu.Unlock()
		var h uint32
		err := d.doLocked(func(c Conn) error {
			var err error
			h, err = c.Send(to.storage, to.parent, name, o.Size, o.ModTime, tmp)
			return err
		})
		if errors.Is(err, ErrDesync) {
			return d.resyncLocked() == nil, err
		}
		if err != nil && h != 0 && !errors.Is(err, ErrGone) {
			_ = d.doLocked(func(c Conn) error { return c.Delete(h) })
		}
		return false, err
	}()
	if cleanup {
		if cerr := d.deleteFileByPath(context.WithoutCancel(ctx), dstPath); cerr != nil {
			log.Printf("WARNING: could not delete the incomplete file %q: %v", dstPath, cerr)
		}
	}
	return err
}
