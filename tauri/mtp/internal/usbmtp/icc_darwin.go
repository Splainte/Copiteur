//go:build cgo && darwin

package usbmtp

// Liaison Go de la passerelle ImageCaptureCore (imagecapture_bridge_darwin.m,
// voir icc.go). Volontairement minimale : toute la logique est dans icc.go,
// testee hors macOS.

/*
#cgo CFLAGS: -x objective-c -fobjc-arc -fblocks -Wno-deprecated-declarations
#cgo LDFLAGS: -framework Foundation -framework ImageCaptureCore -framework IOKit
#include "imagecapture_bridge.h"
*/
import "C"

import (
	"encoding/json"
	"errors"
	"fmt"
	"unsafe"
)

// iccSupported : transport Image Capture disponible (macOS).
const iccSupported = true

func iccError(message *C.char) error {
	if message == nil {
		return nil
	}
	defer C.free(unsafe.Pointer(message))
	return fmt.Errorf("%s", C.GoString(message))
}

// iccDevices liste les interfaces MTP/PTP vues par IOKit (sans les ouvrir).
func iccDevices() ([]iccTarget, error) {
	var message *C.char
	data := C.omtp_ic_devices(&message)
	if err := iccError(message); err != nil {
		if data != nil {
			C.free(unsafe.Pointer(data))
		}
		return nil, err
	}
	if data == nil {
		return nil, nil
	}
	defer C.free(unsafe.Pointer(data))
	var targets []iccTarget
	err := json.Unmarshal([]byte(C.GoString(data)), &targets)
	return targets, err
}

// nativeWire : session cliente ImageCaptureCore.
type nativeWire struct{ handle unsafe.Pointer }

// iccOpen ouvre une session cliente (bloquant : decouverte ~6 s, au plus
// 120 s). Jamais depuis le thread principal (la passerelle le refuse).
func iccOpen(t iccTarget) (ptpWire, error) {
	var message *C.char
	h := C.omtp_ic_open(C.uint32_t(t.Vendor), C.uint32_t(t.Product), C.uint32_t(t.Location), &message)
	if err := iccError(message); err != nil {
		return nil, err
	}
	if h == nil {
		return nil, errors.New("missing session")
	}
	return &nativeWire{handle: h}, nil
}

func (w *nativeWire) command(command, out []byte) ([]byte, []byte, error) {
	if w.handle == nil {
		return nil, nil, errors.New("session closed")
	}
	// La passerelle copie command/out avant de rendre la main (aucune
	// memoire Go n'est conservee cote Objective-C).
	var payload unsafe.Pointer
	if len(out) > 0 {
		payload = unsafe.Pointer(&out[0])
	}
	r := C.omtp_ic_command(w.handle, unsafe.Pointer(&command[0]), C.size_t(len(command)), payload, C.size_t(len(out)))
	defer C.free(r.data)
	defer C.free(r.response)
	if err := iccError(r.error); err != nil {
		return nil, nil, err
	}
	return C.GoBytes(r.data, C.int(r.data_size)), C.GoBytes(r.response, C.int(r.response_size)), nil
}

func (w *nativeWire) close() error {
	if w.handle == nil {
		return nil
	}
	wait := 5.0
	if iccShutdown.Load() {
		wait = iccShutdownCloseWait.Seconds() // arret du programme : vite
	}
	err := iccError(C.omtp_ic_close_wait(w.handle, C.double(wait)))
	w.handle = nil
	return err
}

// RunMainLoop execute fn dans une goroutine et la boucle d'evenements de
// macOS sur le thread principal (ImageCaptureCore y livre ses rappels).
// main doit avoir appele runtime.LockOSThread dans un init. Rend la main
// quand fn est terminee.
func RunMainLoop(fn func()) {
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer C.omtp_ic_stop_loop()
		fn()
	}()
	C.omtp_ic_run_loop()
	<-done
}
