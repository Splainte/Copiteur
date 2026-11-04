// Package core contient la partie commune aux deux backends (USB reel et
// faux telephone) : l'interface bas niveau Conn (une session MTP ouverte),
// et Device, qui serialise les transactions, met en cache les listings et
// traduit des chemins en handles MTP. La couche WebDAV ne parle qu'a Device.
package core

import (
	"errors"
	"io"
	"time"
)

// Erreurs normalisees. Les backends les enveloppent (errors.Is) pour que la
// couche HTTP puisse choisir le bon code de statut.
var (
	ErrNotFound     = errors.New("object not found")
	ErrExists       = errors.New("already exists")
	ErrConflict     = errors.New("parent folder missing")
	ErrIsDir        = errors.New("is a folder")
	ErrNotDir       = errors.New("not a folder")
	ErrForbidden    = errors.New("forbidden")
	ErrBadName      = errors.New("invalid file name")
	ErrNotSupported = errors.New("operation not supported by the device")
	ErrStoreFull    = errors.New("storage full")
	ErrTooLarge     = errors.New("object too large for this storage")
	ErrReadOnly     = errors.New("storage or object is read-only")
	ErrBusy         = errors.New("device busy")
	ErrNotReady     = errors.New("device not ready")
	// ErrGone : erreur d'E/S USB ou session cassee. La connexion est
	// inutilisable, le Device est ferme et les requetes repondent 503.
	ErrGone = errors.New("device disconnected")
	// ErrDesync : une transaction a ete interrompue en pleine phase de
	// donnees (upload coupe). La session doit etre resynchronisee
	// (Conn.Resync) avant toute autre transaction.
	ErrDesync = errors.New("MTP session out of sync")
	// ErrIncomplete : le corps de la requete PUT s'est arrete avant la
	// taille annoncee.
	ErrIncomplete = errors.New("upload body ended early")
	// ErrPrecondition : la destination existe et Overwrite: F.
	ErrPrecondition = errors.New("destination exists")
)

// RootParent est le handle "parent" des objets a la racine d'un stockage
// (GetObjectHandles / SendObjectInfo).
const RootParent uint32 = 0xFFFFFFFF

// Storage decrit un stockage MTP (memoire interne, carte SD...).
type Storage struct {
	ID          uint32
	Description string
	Total       uint64
	Free        uint64
}

// Object decrit un objet MTP (fichier ou dossier).
type Object struct {
	Handle    uint32
	StorageID uint32
	Name      string
	IsDir     bool
	Size      int64
	ModTime   time.Time // zero si inconnue
}

// Conn est une session MTP ouverte. Elle N'EST PAS sure pour un usage
// concurrent : Device prend son verrou avant chaque appel.
type Conn interface {
	// Storages renvoie les stockages exposes (vide = telephone verrouille
	// ou mode "recharge uniquement").
	Storages() ([]Storage, error)
	// Handles liste les handles des enfants directs de parent
	// (RootParent pour la racine du stockage).
	Handles(storageID, parent uint32) ([]uint32, error)
	// Info lit les metadonnees d'un objet (taille 64 bits reelle).
	Info(handle uint32) (Object, error)
	// PartialRead indique si ReadPartial est utilisable pour un fichier de
	// cette taille.
	PartialRead(size int64) bool
	// ReadPartial ecrit au plus n octets a partir de off dans w.
	ReadPartial(handle uint32, off int64, n uint32, w io.Writer) error
	// ReadAll ecrit tout l'objet dans w (une seule transaction GetObject).
	// w ne doit pas renvoyer d'erreur (sinon la transaction serait
	// interrompue au milieu) : l'appelant l'enveloppe.
	ReadAll(handle uint32, w io.Writer) error
	// CreateFolder cree un dossier et renvoie son handle.
	CreateFolder(storageID, parent uint32, name string) (uint32, error)
	// Send cree un fichier de taille size (SendObjectInfo) puis envoie
	// exactement size octets lus dans r (SendObject). Le handle renvoye est
	// non nul des que l'objet a ete cree, meme en cas d'erreur. Si la phase
	// de donnees n'a pas pu se terminer proprement, l'erreur enveloppe
	// ErrDesync.
	Send(storageID, parent uint32, name string, size int64, mtime time.Time, r io.Reader) (uint32, error)
	// Delete supprime un objet (un dossier : recursif si l'appareil le
	// permet).
	Delete(handle uint32) error
	// Rename renomme un objet sans le deplacer.
	Rename(handle uint32, name string) error
	// Move deplace un objet dans un autre dossier (meme nom).
	Move(handle, storageID, parent uint32) error
	// Copy copie un fichier dans un autre dossier (meme nom) et renvoie le
	// handle de la copie.
	Copy(handle, storageID, parent uint32) (uint32, error)
	// Resync remet la session dans un etat sain apres ErrDesync (USB :
	// reset + fermeture + reouverture de la session).
	Resync() error
	// Close ferme la session et libere l'interface USB.
	Close() error
}
