//go:build cgo && !darwin

package usbmtp

import "errors"

// iccSupported : pas d'Image Capture hors macOS.
const iccSupported = false

func iccDevices() ([]iccTarget, error) { return nil, nil }

func iccOpen(iccTarget) (ptpWire, error) {
	return nil, errors.New("macOS Image Capture is only available on macOS")
}

// RunMainLoop : sans objet hors macOS, execute simplement fn.
func RunMainLoop(fn func()) { fn() }
