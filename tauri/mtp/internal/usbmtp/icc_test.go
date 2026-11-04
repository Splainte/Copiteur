//go:build cgo

package usbmtp

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/ganeshrvel/go-mtpfs/mtp"

	"copiteur-mtp/internal/core"
)

// --- fausse passerelle : un telephone MTP en memoire ----------------------

type fakeObj struct {
	parent  uint32
	name    string
	dir     bool
	data    []byte
	editing bool
}

type fakeCall struct {
	code   uint16
	params []uint32
	outLen int
}

type fakeICC struct {
	t          *testing.T
	ops        []uint16
	objs       map[uint32]*fakeObj
	next       uint32
	pending    uint32 // handle en attente de SendObject
	pendingLen uint32
	calls      []fakeCall
	wireErr    map[uint16]error  // erreur de passerelle (ex. delai depasse)
	rcErr      map[uint16]uint16 // code retour MTP
	badResp    map[uint16]bool   // reponse mal formee
	overCount  bool              // SendPartial annonce plus qu'envoye
	closed     bool
}

var allOps = []uint16{
	mtp.OC_GetDeviceInfo, mtp.OC_GetStorageIDs, mtp.OC_GetStorageInfo, mtp.OC_GetObjectHandles,
	mtp.OC_GetObjectInfo, mtp.OC_GetObject, mtp.OC_DeleteObject, mtp.OC_SendObjectInfo, mtp.OC_SendObject,
	mtp.OC_MoveObject, mtp.OC_CopyObject, mtp.OC_GetPartialObject, mtp.OC_MTP_GetObjectPropsSupported,
	mtp.OC_MTP_GetObjectPropValue, mtp.OC_MTP_SetObjectPropValue, mtp.OC_ANDROID_GET_PARTIAL_OBJECT64,
	ocAndroidSendPartial, ocAndroidTruncate, ocAndroidBeginEdit, ocAndroidEndEdit,
}

func newFakeICC(t *testing.T, ops []uint16) *fakeICC {
	return &fakeICC{t: t, ops: ops, objs: map[uint32]*fakeObj{}, next: 100,
		wireErr: map[uint16]error{}, rcErr: map[uint16]uint16{}, badResp: map[uint16]bool{}}
}

func without(ops []uint16, drop ...uint16) []uint16 {
	var out []uint16
	for _, o := range ops {
		keep := true
		for _, d := range drop {
			keep = keep && o != d
		}
		if keep {
			out = append(out, o)
		}
	}
	return out
}

func resp(rc uint16, params ...uint32) []byte {
	b := make([]byte, 12+4*len(params))
	binary.LittleEndian.PutUint32(b, uint32(len(b)))
	binary.LittleEndian.PutUint16(b[4:], 3)
	binary.LittleEndian.PutUint16(b[6:], rc)
	for i, p := range params {
		binary.LittleEndian.PutUint32(b[12+4*i:], p)
	}
	return b
}

func encode(t *testing.T, v any) []byte {
	var b bytes.Buffer
	if err := mtp.Encode(&b, v); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func (f *fakeICC) count(code uint16) int {
	n := 0
	for _, c := range f.calls {
		if c.code == code {
			n++
		}
	}
	return n
}

func (f *fakeICC) add(parent uint32, name string, dir bool, data []byte) uint32 {
	h := f.next
	f.next++
	f.objs[h] = &fakeObj{parent: parent, name: name, dir: dir, data: data}
	return h
}

func (f *fakeICC) close() error { f.closed = true; return nil }

func (f *fakeICC) command(cmd, out []byte) ([]byte, []byte, error) {
	t := f.t
	// verifications de cadrage, comme la passerelle et le telephone
	if len(cmd) < 12 || len(cmd) > 32 || int(binary.LittleEndian.Uint32(cmd)) != len(cmd) || (len(cmd)-12)%4 != 0 {
		t.Fatalf("bad command framing %x", cmd)
	}
	if typ := binary.LittleEndian.Uint16(cmd[4:]); typ != 1 {
		t.Fatalf("container type %d", typ)
	}
	if tid := binary.LittleEndian.Uint32(cmd[8:]); tid != 0 {
		t.Fatalf("transaction ID %d (the daemon assigns it)", tid)
	}
	if len(out) > iccMaxPayload {
		return nil, nil, errors.New("Invalid ImageCaptureCore command or calling thread")
	}
	code := binary.LittleEndian.Uint16(cmd[6:])
	var p []uint32
	for i := 12; i < len(cmd); i += 4 {
		p = append(p, binary.LittleEndian.Uint32(cmd[i:]))
	}
	f.calls = append(f.calls, fakeCall{code: code, params: p, outLen: len(out)})
	if err := f.wireErr[code]; err != nil {
		return nil, nil, err
	}
	if f.badResp[code] {
		return nil, []byte{1, 2, 3}, nil
	}
	if rc := f.rcErr[code]; rc != 0 {
		return nil, resp(rc), nil
	}
	if f.pending != 0 && code != mtp.OC_SendObject {
		t.Fatalf("command 0x%04x while SendObject pending", code)
	}
	supported := false
	for _, o := range f.ops {
		supported = supported || o == code
	}
	if !supported {
		return nil, resp(mtp.RC_OperationNotSupported), nil
	}
	obj := func(i int) *fakeObj { return f.objs[p[i]] }
	switch code {
	case mtp.OC_GetDeviceInfo:
		return encode(t, &mtp.DeviceInfo{StandardVersion: 100, MTPVendorExtensionID: 6, MTPVersion: 100,
			MTPExtension: "microsoft.com: 1.0; android.com: 1.0;", OperationsSupported: f.ops,
			EventsSupported: []uint16{}, DevicePropertiesSupported: []uint16{}, CaptureFormats: []uint16{},
			PlaybackFormats: []uint16{}, Manufacturer: "Google", Model: "Pixel 9 Pro XL", DeviceVersion: "1",
			SerialNumber: "SER"}), resp(mtp.RC_OK), nil
	case mtp.OC_GetStorageIDs:
		return encode(t, &mtp.Uint32Array{Values: []uint32{0x10001, 0x20000}}), resp(mtp.RC_OK), nil
	case mtp.OC_GetStorageInfo:
		return encode(t, &mtp.StorageInfo{StorageType: 3, FilesystemType: 2, MaxCapability: 1 << 40,
			FreeSpaceInBytes: 1 << 39, StorageDescription: "Espace de stockage interne partagé"}), resp(mtp.RC_OK), nil
	case mtp.OC_GetObjectHandles:
		parent := p[2]
		if parent == 0xFFFFFFFF {
			parent = 0
		}
		var hs []uint32
		for h, o := range f.objs {
			if o.parent == parent {
				hs = append(hs, h)
			}
		}
		return encode(t, &mtp.Uint32Array{Values: hs}), resp(mtp.RC_OK), nil
	case mtp.OC_GetObjectInfo:
		o := obj(0)
		if o == nil {
			return nil, resp(mtp.RC_InvalidObjectHandle), nil
		}
		format := uint16(mtp.OFC_Undefined)
		if o.dir {
			format = mtp.OFC_Association
		}
		return encode(t, &mtp.ObjectInfo{StorageID: 0x10001, ObjectFormat: format,
			CompressedSize: uint32(min(len(o.data), 0xFFFFFFFF)), ParentObject: o.parent, Filename: o.name,
			ModificationDate: time.Now()}), resp(mtp.RC_OK), nil
	case mtp.OC_MTP_GetObjectPropValue:
		o := obj(0)
		if o == nil {
			return nil, resp(mtp.RC_InvalidObjectHandle), nil
		}
		b := make([]byte, 8)
		binary.LittleEndian.PutUint64(b, uint64(len(o.data)))
		return b, resp(mtp.RC_OK), nil
	case mtp.OC_SendObjectInfo:
		var oi rawObjectInfo
		if err := oi.Decode(bytes.NewReader(out)); err != nil {
			t.Fatalf("SendObjectInfo payload: %v", err)
		}
		parent := p[1]
		if parent == 0xFFFFFFFF {
			parent = 0
		}
		for _, o := range f.objs {
			if o.parent == parent && o.name == oi.Filename {
				return nil, resp(mtp.RC_GeneralError), nil
			}
		}
		h := f.add(parent, oi.Filename, oi.ObjectFormat == mtp.OFC_Association, nil)
		if oi.ObjectFormat != mtp.OFC_Association {
			f.pending, f.pendingLen = h, oi.CompressedSize
		}
		return nil, resp(mtp.RC_OK, p[0], parent, h), nil
	case mtp.OC_SendObject:
		if f.pending == 0 {
			return nil, resp(mtp.RC_NoValidObjectInfo), nil
		}
		h := f.pending
		f.pending = 0
		if uint32(len(out)) != f.pendingLen {
			t.Fatalf("SendObject %d bytes, announced %d", len(out), f.pendingLen)
		}
		f.objs[h].data = append([]byte(nil), out...)
		return nil, resp(mtp.RC_OK), nil
	case ocAndroidBeginEdit:
		obj(0).editing = true
		return nil, resp(mtp.RC_OK), nil
	case ocAndroidEndEdit:
		obj(0).editing = false
		return nil, resp(mtp.RC_OK), nil
	case ocAndroidTruncate:
		o := obj(0)
		if !o.editing {
			t.Fatal("truncate outside an edit")
		}
		o.data = o.data[:p[1]]
		return nil, resp(mtp.RC_OK), nil
	case ocAndroidSendPartial:
		o := obj(0)
		if !o.editing {
			t.Fatal("SendPartialObject outside an edit")
		}
		off := int(uint64(p[1]) | uint64(p[2])<<32)
		if int(p[3]) != len(out) || off != len(o.data) {
			t.Fatalf("SendPartialObject off=%d n=%d out=%d (size %d)", off, p[3], len(out), len(o.data))
		}
		o.data = append(o.data, out...)
		n := p[3]
		if f.overCount {
			n++
		}
		return nil, resp(mtp.RC_OK, n), nil
	case mtp.OC_ANDROID_GET_PARTIAL_OBJECT64, mtp.OC_GetPartialObject:
		o := obj(0)
		off, n := uint64(p[1]), uint64(p[2])
		if code == mtp.OC_ANDROID_GET_PARTIAL_OBJECT64 {
			off, n = uint64(p[1])|uint64(p[2])<<32, uint64(p[3])
		}
		if n > iccMaxPayload {
			return nil, nil, errors.New("ImageCaptureCore response exceeded the buffer limit")
		}
		end := min(off+n, uint64(len(o.data)))
		d := o.data[min(off, end):end]
		return append([]byte(nil), d...), resp(mtp.RC_OK, uint32(len(d))), nil
	case mtp.OC_GetObject:
		o := obj(0)
		if len(o.data) > iccMaxPayload {
			return nil, nil, errors.New("ImageCaptureCore response exceeded the buffer limit")
		}
		return append([]byte(nil), o.data...), resp(mtp.RC_OK), nil
	case mtp.OC_DeleteObject:
		if obj(0) == nil {
			return nil, resp(mtp.RC_InvalidObjectHandle), nil
		}
		delete(f.objs, p[0])
		return nil, resp(mtp.RC_OK), nil
	case mtp.OC_MTP_SetObjectPropValue:
		var s mtpString
		if err := s.Decode(bytes.NewReader(out)); err != nil {
			t.Fatal(err)
		}
		obj(0).name = s.Value
		return nil, resp(mtp.RC_OK), nil
	case mtp.OC_MoveObject:
		obj(0).parent = p[2]
		return nil, resp(mtp.RC_OK), nil
	case mtp.OC_CopyObject:
		o := obj(0)
		h := f.add(p[2], o.name, false, append([]byte(nil), o.data...))
		return nil, resp(mtp.RC_OK, h), nil
	}
	return nil, resp(mtp.RC_OperationNotSupported), nil
}

// --- outils -----------------------------------------------------------------

func randData(n int) []byte {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return b
}

// iccDevice : core.Device branche sur la fausse passerelle.
func iccDevice(t *testing.T, f *fakeICC) (*core.Device, *iccConn) {
	t.Helper()
	released := false
	c, _, err := newICCConn(f, func() { released = true })
	if err != nil {
		t.Fatal(err)
	}
	st, err := c.Storages()
	if err != nil || len(st) != 1 {
		t.Fatalf("storages %v %v (0x20000 must be skipped)", st, err)
	}
	d := core.NewDevice("icc")
	d.Attach(c, st)
	t.Cleanup(func() {
		d.Close(core.StateError, "end", time.Second)
		if !released || !f.closed {
			t.Error("ICC session not closed/released")
		}
	})
	return d, c
}

type failAfter struct {
	r io.Reader
	n int
}

func (f *failAfter) Read(p []byte) (int, error) {
	if f.n <= 0 {
		return 0, io.ErrUnexpectedEOF
	}
	if len(p) > f.n {
		p = p[:f.n]
	}
	k, err := f.r.Read(p)
	f.n -= k
	return k, err
}

// --- tests ------------------------------------------------------------------

func TestICCFraming(t *testing.T) {
	b, err := commandBytes(0x95C1, []uint32{7, 1, 2, 3})
	if err != nil {
		t.Fatal(err)
	}
	want := []byte{28, 0, 0, 0, 1, 0, 0xC1, 0x95, 0, 0, 0, 0, 7, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0}
	if !bytes.Equal(b, want) {
		t.Fatalf("got %x", b)
	}
	if _, err := commandBytes(1, make([]uint32, 6)); err == nil {
		t.Fatal("6 params accepted")
	}
	code, p, err := parseResponse(resp(0x2001, 5, 6))
	if err != nil || code != 0x2001 || len(p) != 2 || p[1] != 6 {
		t.Fatalf("parse: %x %v %v", code, p, err)
	}
	for _, bad := range [][]byte{nil, {1, 2, 3}, resp(0x1001), append(resp(0x2001), 0), resp(0x2001, 1, 2, 3, 4, 5, 6)} {
		if _, _, err := parseResponse(bad); err == nil {
			t.Errorf("accepted %x", bad)
		}
	}
	short := resp(0x2001)
	binary.LittleEndian.PutUint32(short, 16)
	if _, _, err := parseResponse(short); err == nil {
		t.Error("length mismatch accepted")
	}
}

func TestICCOpenRefusesNonMTP(t *testing.T) {
	f := newFakeICC(t, without(allOps, mtp.OC_MTP_GetObjectPropsSupported))
	released := false
	if _, _, err := newICCConn(f, func() { released = true }); !errors.Is(err, errNotMTP) || !strings.Contains(err.Error(), "File transfer") {
		t.Fatalf("err %v", err)
	}
	if !f.closed || !released {
		t.Fatal("not closed/released after refusal")
	}
}

func TestICCSessionCommandsForbidden(t *testing.T) {
	f := newFakeICC(t, allOps)
	c, _, err := newICCConn(f, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, code := range []uint16{mtp.OC_OpenSession, mtp.OC_CloseSession, mtp.OC_ResetDevice} {
		if _, _, err := c.run(code, nil, nil); err == nil {
			t.Errorf("0x%04x allowed", code)
		}
	}
	if f.count(mtp.OC_OpenSession)+f.count(mtp.OC_CloseSession)+f.count(mtp.OC_ResetDevice) != 0 {
		t.Fatal("session command sent")
	}
	if err := c.Resync(); err != nil {
		t.Fatal(err)
	}
}

func TestICCListAndChunkedGet(t *testing.T) {
	for _, mode := range []string{"partial64", "partial32", "whole"} {
		t.Run(mode, func(t *testing.T) {
			ops := allOps
			switch mode {
			case "partial32":
				ops = without(ops, mtp.OC_ANDROID_GET_PARTIAL_OBJECT64)
			case "whole":
				ops = without(ops, mtp.OC_ANDROID_GET_PARTIAL_OBJECT64, mtp.OC_GetPartialObject)
			}
			f := newFakeICC(t, ops)
			dcim := f.add(0, "DCIM", true, nil)
			big := randData(20<<20 + 5)
			small := randData(1 << 20)
			f.add(dcim, "big.mp4", false, big)
			f.add(dcim, "small.jpg", false, small)
			d, _ := iccDevice(t, f)
			ctx := context.Background()
			for name, data := range map[string][]byte{"DCIM/big.mp4": big, "DCIM/small.jpg": small} {
				n, err := d.Resolve(ctx, name)
				if err != nil {
					t.Fatal(err)
				}
				var out bytes.Buffer
				err = d.ReadRange(ctx, n, 0, n.Size(), &out)
				if mode == "whole" && len(data) > iccMaxPayload {
					if !errors.Is(err, core.ErrNotSupported) {
						t.Fatalf("%s: %v", name, err)
					}
					continue
				}
				if err != nil || !bytes.Equal(out.Bytes(), data) {
					t.Fatalf("%s: %v (%d bytes)", name, err, out.Len())
				}
				// plage au milieu, a cheval sur deux blocs
				out.Reset()
				if err := d.ReadRange(ctx, n, int64(len(data))/2-10, 20, &out); err != nil || !bytes.Equal(out.Bytes(), data[len(data)/2-10:len(data)/2+10]) {
					t.Fatalf("%s range: %v", name, err)
				}
			}
			for _, c := range f.calls {
				if c.code == mtp.OC_ANDROID_GET_PARTIAL_OBJECT64 && c.params[3] > iccChunk {
					t.Fatalf("partial read of %d bytes", c.params[3])
				}
			}
		})
	}
}

func TestICCUploads(t *testing.T) {
	f := newFakeICC(t, allOps)
	d, _ := iccDevice(t, f)
	ctx := context.Background()
	for _, size := range []int{0, 1024, iccChunk, iccChunk + 1, 20<<20 + 3} {
		data := randData(size)
		f.calls = nil
		name := "f" + strings.Repeat("x", size%7)
		if _, err := d.Put(ctx, name, int64(size), time.Now(), bytes.NewReader(data)); err != nil {
			t.Fatalf("size %d: %v", size, err)
		}
		n, err := d.Resolve(ctx, name)
		if err != nil {
			t.Fatal(err)
		}
		if f.objs[n.Obj.Handle] == nil || !bytes.Equal(f.objs[n.Obj.Handle].data, data) || n.Size() != int64(size) {
			t.Fatalf("size %d: content mismatch", size)
		}
		// sequence : SendObjectInfo annonce le premier bloc seulement
		var info, send, begin, partial, trunc, end int
		for _, c := range f.calls {
			switch c.code {
			case mtp.OC_SendObjectInfo:
				info++
			case mtp.OC_SendObject:
				send++
				want := min(size, iccChunk)
				if size == 0 {
					want = 1
				}
				if c.outLen != want {
					t.Fatalf("size %d: SendObject %d bytes", size, c.outLen)
				}
			case ocAndroidBeginEdit:
				begin++
			case ocAndroidSendPartial:
				partial++
				if c.outLen > iccChunk {
					t.Fatalf("SendPartial %d bytes", c.outLen)
				}
			case ocAndroidTruncate:
				trunc++
			case ocAndroidEndEdit:
				end++
			}
		}
		edit := size == 0 || size > iccChunk
		if info != 1 || send != 1 || (begin == 1) != edit || (end == 1) != edit || (trunc == 1) != (size == 0) {
			t.Fatalf("size %d: calls info=%d send=%d begin=%d partial=%d trunc=%d end=%d", size, info, send, begin, partial, trunc, end)
		}
	}
	// remplacement d'un gros fichier
	data := randData(9 << 20)
	if created, err := d.Put(ctx, "f", int64(len(data)), time.Now(), bytes.NewReader(data)); err != nil || created {
		t.Fatalf("overwrite: %v %v", created, err)
	}
}

func TestICCNoEditOps(t *testing.T) {
	f := newFakeICC(t, without(allOps, ocAndroidBeginEdit, ocAndroidSendPartial, ocAndroidTruncate, ocAndroidEndEdit))
	d, _ := iccDevice(t, f)
	ctx := context.Background()
	if _, err := d.Put(ctx, "big", iccChunk+1, time.Now(), bytes.NewReader(randData(iccChunk+1))); !errors.Is(err, core.ErrTooLarge) {
		t.Fatalf("big: %v", err)
	}
	if _, err := d.Put(ctx, "empty", 0, time.Now(), bytes.NewReader(nil)); !errors.Is(err, core.ErrNotSupported) {
		t.Fatalf("empty: %v", err)
	}
	if f.count(mtp.OC_SendObjectInfo) != 0 {
		t.Fatal("object created before refusing")
	}
	if _, err := d.Put(ctx, "ok", iccChunk, time.Now(), bytes.NewReader(randData(iccChunk))); err != nil {
		t.Fatalf("8 MiB: %v", err)
	}
}

// Delai depasse / erreur de passerelle : resultat inconnu -> session perdue,
// jamais de nouvel essai, appareil en erreur (503).
func TestICCWireErrorIsFatal(t *testing.T) {
	f := newFakeICC(t, allOps)
	d, c := iccDevice(t, f)
	gone := make(chan struct{}, 1)
	d.OnGone = func(*core.Device, error) { gone <- struct{}{} }
	f.wireErr[ocAndroidSendPartial] = errors.New("ImageCaptureCore command timed out; its outcome is unknown")
	_, err := d.Put(context.Background(), "x", 20<<20, time.Now(), bytes.NewReader(randData(20<<20)))
	if !errors.Is(err, core.ErrGone) {
		t.Fatalf("err %v", err)
	}
	if n := f.count(ocAndroidSendPartial); n != 1 {
		t.Fatalf("SendPartialObject sent %d times", n)
	}
	select {
	case <-gone:
	case <-time.After(time.Second):
		t.Fatal("device not marked gone")
	}
	if d.State() != core.StateError {
		t.Fatalf("state %s", d.State())
	}
	before := len(f.calls)
	if _, err := c.Handles(0x10001, 0xFFFFFFFF); !errors.Is(err, core.ErrGone) {
		t.Fatalf("after loss: %v", err)
	}
	if len(f.calls) != before {
		t.Fatal("command sent on a lost session")
	}
}

func TestICCMalformedResponseIsFatal(t *testing.T) {
	f := newFakeICC(t, allOps)
	c, _, err := newICCConn(f, nil)
	if err != nil {
		t.Fatal(err)
	}
	f.badResp[mtp.OC_GetObjectHandles] = true
	if _, err := c.Handles(0x10001, 0xFFFFFFFF); !errors.Is(err, core.ErrGone) {
		t.Fatalf("err %v", err)
	}
	if _, err := c.Storages(); !errors.Is(err, core.ErrGone) {
		t.Fatalf("after: %v", err)
	}
}

// Envoi interrompu (client parti) : edition refermee, objet supprime,
// session intacte, appareil toujours pret.
func TestICCInterruptedUpload(t *testing.T) {
	for _, at := range []int{1 << 20, 10 << 20} { // dans le 1er bloc / pendant l'edition
		f := newFakeICC(t, allOps)
		d, _ := iccDevice(t, f)
		d.MaxPad = 0 // pas de bourrage cote core : on teste la connexion
		const size = 30 << 20
		_, err := d.Put(context.Background(), "cut.mp4", size, time.Now(), &failAfter{r: bytes.NewReader(randData(size)), n: at})
		if !errors.Is(err, core.ErrIncomplete) {
			t.Fatalf("at %d: %v", at, err)
		}
		for _, o := range f.objs {
			if o.name == "cut.mp4" {
				t.Fatalf("at %d: partial object left", at)
			}
		}
		if f.count(ocAndroidBeginEdit) != f.count(ocAndroidEndEdit) {
			t.Fatalf("at %d: edit left open", at)
		}
		if d.State() != core.StateReady {
			t.Fatalf("at %d: state %s", at, d.State())
		}
		if _, err := d.Put(context.Background(), "after", 3, time.Now(), bytes.NewReader([]byte("abc"))); err != nil {
			t.Fatalf("at %d: after: %v", at, err)
		}
	}
}

func TestICCErrors(t *testing.T) {
	f := newFakeICC(t, allOps)
	d, c := iccDevice(t, f)
	ctx := context.Background()
	f.rcErr[mtp.OC_SendObjectInfo] = mtp.RC_StoreFull
	if _, err := d.Put(ctx, "a", 10, time.Now(), bytes.NewReader(randData(10))); !errors.Is(err, core.ErrStoreFull) {
		t.Fatalf("store full: %v", err)
	}
	f.rcErr[mtp.OC_SendObjectInfo] = mtp.RC_MTP_Object_Too_Large
	if _, err := d.Put(ctx, "b", 10, time.Now(), bytes.NewReader(randData(10))); !errors.Is(err, core.ErrTooLarge) {
		t.Fatalf("too large: %v", err)
	}
	f.rcErr[mtp.OC_SendObjectInfo] = mtp.RC_GeneralError
	if _, err := d.Put(ctx, "c:d", 10, time.Now(), bytes.NewReader(randData(10))); !errors.Is(err, core.ErrBadName) {
		t.Fatalf("bad name: %v", err)
	}
	if _, err := d.Put(ctx, "normal", 10, time.Now(), bytes.NewReader(randData(10))); err == nil || errors.Is(err, core.ErrBadName) || errors.Is(err, core.ErrGone) {
		t.Fatalf("transient GeneralError must stay a plain (retryable) error: %v", err)
	}
	delete(f.rcErr, mtp.OC_SendObjectInfo)
	// erreur MTP pendant l'edition : objet supprime, session saine
	f.rcErr[ocAndroidSendPartial] = mtp.RC_StoreFull
	if _, err := d.Put(ctx, "e", 9<<20, time.Now(), bytes.NewReader(randData(9<<20))); !errors.Is(err, core.ErrStoreFull) {
		t.Fatalf("store full during edit: %v", err)
	}
	delete(f.rcErr, ocAndroidSendPartial)
	for _, o := range f.objs {
		if o.name == "e" {
			t.Fatal("object left after failed edit")
		}
	}
	if f.count(ocAndroidBeginEdit) != f.count(ocAndroidEndEdit) {
		t.Fatal("edit left open")
	}
	// compte d'octets absurde : session perdue
	f.overCount = true
	if _, err := c.Send(0x10001, 0xFFFFFFFF, "g", 9<<20, time.Now(), bytes.NewReader(randData(9<<20))); !errors.Is(err, core.ErrGone) {
		t.Fatalf("over-count: %v", err)
	}
}

func TestMatchICCTarget(t *testing.T) {
	targets := []iccTarget{
		{Vendor: 0x18d1, Product: 0x4ee1, Serial: "AAA", AppleOwned: true},
		{Vendor: 0x18d1, Product: 0x4ee1, Serial: "BBB"},
		{Vendor: 0x04e8, Product: 0x6860, Serial: ""},
	}
	if tg, err := matchICCTarget(targets, "BBB", 0x18d1, 0x4ee1); err != nil || tg.Serial != "BBB" {
		t.Fatalf("by serial: %v %v", tg, err)
	}
	if tg, err := matchICCTarget(targets, "", 0x04e8, 0x6860); err != nil || tg.Vendor != 0x04e8 {
		t.Fatalf("by ids: %v %v", tg, err)
	}
	if _, err := matchICCTarget(targets, "", 0x18d1, 0x4ee1); err == nil {
		t.Fatal("ambiguous match accepted")
	}
	if _, err := matchICCTarget(targets, "ZZZ", 0x1234, 0x1); err == nil {
		t.Fatal("no match accepted")
	}
}

func TestICCBackoff(t *testing.T) {
	want := []time.Duration{5 * time.Second, 10 * time.Second, 20 * time.Second, 40 * time.Second, 80 * time.Second, 2 * time.Minute, 2 * time.Minute}
	for i, w := range want {
		if got := iccBackoff(i); got != w {
			t.Errorf("iccBackoff(%d) = %v, want %v", i, got, w)
		}
	}
	if iccBackoff(1000) != 2*time.Minute {
		t.Error("no cap")
	}
}
