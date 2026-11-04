//go:build cgo && !darwin

package usbmtp

// releaseImageCapture : sans objet hors macOS (cf. imagecapture_darwin.go).
func releaseImageCapture() bool { return false }
