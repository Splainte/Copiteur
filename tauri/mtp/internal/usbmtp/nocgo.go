//go:build !cgo

package usbmtp

import (
	"errors"

	"copiteur-mtp/internal/core"
)

// Manager n'existe pas sans cgo (libusb) : binaire "--fake" seulement.
type Manager struct{}

// NewManager echoue : ce binaire a ete compile sans le support USB.
func NewManager() (*Manager, error) {
	return nil, errors.New("built without USB support (CGO_ENABLED=0): only --fake is available")
}

func (*Manager) Devices() []*core.Device { return nil }
func (*Manager) Get(string) *core.Device { return nil }
func (*Manager) Retry(string) bool       { return false }
func (*Manager) Close()                  {}

// RunMainLoop : sans objet sans cgo, execute simplement fn.
func RunMainLoop(fn func()) { fn() }
