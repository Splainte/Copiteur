package core

import (
	"context"
	"fmt"
	"path"
	"strings"
	"time"
	"unicode/utf16"

	"golang.org/x/text/unicode/norm"
)

type nodeKind int

const (
	nodeVirtualRoot nodeKind = iota // racine listant plusieurs stockages
	nodeStorage                     // racine d'un stockage
	nodeObject                      // fichier ou dossier MTP
)

// Node est le resultat de la resolution d'un chemin.
type Node struct {
	Path   string // chemin nettoye relatif a la racine de l'appareil ("" = racine)
	kind   nodeKind
	st     Storage
	stName string
	Obj    Object
	parent dirKey // dossier contenant (nodeObject seulement)
}

// IsDir indique si le noeud est un dossier.
func (n Node) IsDir() bool { return n.kind != nodeObject || n.Obj.IsDir }

// IsRoot indique la racine de l'appareil.
func (n Node) IsRoot() bool { return n.Path == "" }

// Name renvoie le nom affiche.
func (n Node) Name() string {
	switch n.kind {
	case nodeObject:
		return n.Obj.Name
	case nodeStorage:
		if n.Path == "" {
			return ""
		}
		return n.stName
	}
	return ""
}

// Size renvoie la taille (0 pour un dossier).
func (n Node) Size() int64 {
	if n.kind == nodeObject && !n.Obj.IsDir {
		return n.Obj.Size
	}
	return 0
}

// ModTime renvoie la date de modification (zero si inconnue).
func (n Node) ModTime() time.Time {
	if n.kind == nodeObject {
		return n.Obj.ModTime
	}
	return time.Time{}
}

// IsObject indique un vrai objet MTP (ni racine ni stockage).
func (n Node) IsObject() bool { return n.kind == nodeObject }

// IsStorageRoot indique la racine d'un stockage presentee comme dossier
// (mode multi-stockages).
func (n Node) IsStorageRoot() bool { return n.kind == nodeStorage && n.Path != "" }

// key est la cle des enfants de ce dossier.
func (n Node) key() dirKey {
	if n.kind == nodeObject {
		return dirKey{storage: n.st.ID, parent: n.Obj.Handle}
	}
	return dirKey{storage: n.st.ID, parent: RootParent}
}

// CleanPath normalise un chemin WebDAV relatif a l'appareil : pas de "/"
// au debut ni a la fin, pas de "." ni "..".
//
// Les noms recus sont normalises en NFC : rclone sur macOS envoie les noms
// du disque local en NFD ("e" + accent combinant), alors qu'Android et le
// reste du monde ecrivent en NFC. Sans cela, "Été.jpg" serait cree en NFD
// sur le telephone et ne correspondrait a rien a la comparaison.
func CleanPath(p string) string {
	p = path.Clean("/" + norm.NFC.String(p))
	return strings.TrimPrefix(p, "/")
}

// SplitPath renvoie (dossier parent, nom).
func SplitPath(p string) (string, string) {
	p = CleanPath(p)
	i := strings.LastIndexByte(p, '/')
	if i < 0 {
		return "", p
	}
	return p[:i], p[i+1:]
}

// ValidName verifie qu'un nom est acceptable pour MTP (chaine MTP : 254
// unites UTF-16 au plus, sans "/").
//
// Limites : 253 unites UTF-16 (chaine MTP de 255 unites max, NUL compris,
// avec une marge comme go-mtpfs) et 255 octets en UTF-8 (limite des
// systemes de fichiers d'Android, ext4/f2fs).
func ValidName(name string) error {
	if name == "" || name == "." || name == ".." || strings.ContainsAny(name, "/\x00") {
		return fmt.Errorf("%w: %q", ErrBadName, name)
	}
	if len(utf16.Encode([]rune(name))) > 253 || len(name) > 255 {
		return fmt.Errorf("%w: name too long", ErrBadName)
	}
	return nil
}

// sameName compare deux noms comme le stockage Android : insensible a la
// casse, et a la forme de normalisation Unicode (NFC/NFD).
func sameName(a, b string) bool {
	return a == b || strings.EqualFold(norm.NFC.String(a), norm.NFC.String(b))
}

// StorageNames calcule les noms de dossier des stockages (mode
// multi-stockages) : description nettoyee, sans doublon.
func StorageNames(st []Storage) []string {
	names := make([]string, len(st))
	seen := map[string]int{}
	for i, s := range st {
		n := strings.TrimSpace(s.Description)
		n = strings.Map(func(r rune) rune {
			if r == '/' || r == '\\' || r < 0x20 {
				return '_'
			}
			return r
		}, n)
		if n == "" || n == "." || n == ".." {
			n = "Storage"
		}
		base := n
		for k := 2; ; k++ {
			if _, dup := seen[strings.ToLower(n)]; !dup {
				break
			}
			n = fmt.Sprintf("%s (%d)", base, k)
		}
		seen[strings.ToLower(n)] = i
		names[i] = n
	}
	return names
}

// findName cherche un enfant par nom : exact d'abord, puis sans tenir
// compte de la casse (le stockage Android est insensible a la casse).
func findName(objs []Object, name string) (Object, bool) {
	for _, o := range objs {
		if o.Name == name {
			return o, true
		}
	}
	for _, o := range objs {
		if sameName(o.Name, name) {
			return o, true
		}
	}
	return Object{}, false
}

// Resolve traduit un chemin en noeud.
func (d *Device) Resolve(ctx context.Context, p string) (Node, error) {
	if err := d.checkReady(); err != nil {
		return Node{}, err
	}
	p = CleanPath(p)
	st, _ := d.storageList()
	if len(st) == 0 {
		return Node{}, d.notReady()
	}
	var comps []string
	if p != "" {
		comps = strings.Split(p, "/")
	}
	var n Node
	if len(st) == 1 {
		n = Node{kind: nodeStorage, st: st[0]}
	} else {
		if len(comps) == 0 {
			return Node{kind: nodeVirtualRoot}, nil
		}
		names := StorageNames(st)
		idx := -1
		for i, nm := range names {
			if nm == comps[0] {
				idx = i
				break
			}
		}
		if idx < 0 {
			for i, nm := range names {
				if sameName(nm, comps[0]) {
					idx = i
					break
				}
			}
		}
		if idx < 0 {
			return Node{}, fmt.Errorf("%w: %s", ErrNotFound, comps[0])
		}
		n = Node{Path: names[idx], kind: nodeStorage, st: st[idx], stName: names[idx]}
		comps = comps[1:]
	}
	for _, c := range comps {
		if !n.IsDir() {
			return Node{}, fmt.Errorf("%w: %s", ErrNotFound, p)
		}
		objs, err := d.list(ctx, n.key())
		if err != nil {
			return Node{}, err
		}
		o, ok := findName(objs, c)
		if !ok {
			return Node{}, fmt.Errorf("%w: %s", ErrNotFound, p)
		}
		parent := n.key()
		n = Node{Path: joinPath(n.Path, o.Name), kind: nodeObject, st: n.st, stName: n.stName, Obj: o, parent: parent}
	}
	return n, nil
}

func joinPath(a, b string) string {
	if a == "" {
		return b
	}
	return a + "/" + b
}

// ReadDir renvoie les enfants d'un dossier.
func (d *Device) ReadDir(ctx context.Context, n Node) ([]Node, error) {
	if !n.IsDir() {
		return nil, ErrNotDir
	}
	if n.kind == nodeVirtualRoot {
		st, _ := d.storageList()
		names := StorageNames(st)
		out := make([]Node, len(st))
		for i, s := range st {
			out[i] = Node{Path: names[i], kind: nodeStorage, st: s, stName: names[i]}
		}
		return out, nil
	}
	objs, err := d.list(ctx, n.key())
	if err != nil {
		return nil, err
	}
	out := make([]Node, len(objs))
	for i, o := range objs {
		out[i] = Node{Path: joinPath(n.Path, o.Name), kind: nodeObject, st: n.st, stName: n.stName, Obj: o, parent: n.key()}
	}
	return out, nil
}

// ReadDirStream est ReadDir en flux : emit recoit les enfants par lots, au
// fur et a mesure de leur lecture sur l'appareil (le verrou est rendu entre
// deux lots). Une erreur d'emit interrompt la lecture.
func (d *Device) ReadDirStream(ctx context.Context, n Node, emit func([]Node) error) error {
	if !n.IsDir() {
		return ErrNotDir
	}
	if n.kind == nodeVirtualRoot {
		out, err := d.ReadDir(ctx, n)
		if err != nil {
			return err
		}
		return emit(out)
	}
	k := n.key()
	_, err := d.listEmit(ctx, k, func(objs []Object) error {
		out := make([]Node, len(objs))
		for i, o := range objs {
			out[i] = Node{Path: joinPath(n.Path, o.Name), kind: nodeObject, st: n.st, stName: n.stName, Obj: o, parent: k}
		}
		return emit(out)
	})
	return err
}

// Quota renvoie (libre, utilise) pour la racine de l'appareil ou d'un
// stockage. ok=false pour un dossier ordinaire.
func (d *Device) Quota(n Node) (free, used uint64, ok bool) {
	if n.kind == nodeObject {
		return 0, 0, false
	}
	st, at := d.storageList()
	if n.IsRoot() && time.Since(at) > 2*time.Second {
		_ = d.RefreshStorages(false)
		st, _ = d.storageList()
	}
	for _, s := range st {
		if n.kind == nodeStorage && n.Path != "" && s.ID != n.st.ID {
			continue
		}
		free += s.Free
		if s.Total > s.Free {
			used += s.Total - s.Free
		}
	}
	return free, used, true
}
