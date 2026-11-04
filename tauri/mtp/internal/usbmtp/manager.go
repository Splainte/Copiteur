//go:build cgo

// Package usbmtp est le backend reel : telephones Android en USB via
// libusb, protocole MTP.
package usbmtp

import (
	"errors"
	"fmt"
	"log"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/ganeshrvel/go-mtpfs/mtp"
	"github.com/ganeshrvel/usb"

	"copiteur-mtp/internal/core"
)

// Rythme du gestionnaire.
var (
	PollInterval  = 1500 * time.Millisecond // enumeration USB (sans ouvrir)
	RetryInterval = 5 * time.Second         // nouvelle tentative busy/error
)

const vendorApple = 0x05ac

// busyHint accompagne l'etat "busy" (detail technique, l'interface affiche
// son propre texte).
const busyHint = "USB interface held by another program (Android File Transfer, OpenMTP, Image Capture/Photos, Smart Switch, another MTP tool)"

type entry struct {
	key  string
	c    *candidate // c.dev : reference tenue par l'entree
	dev  *core.Device
	conn *usbConn

	ignored bool // pas un appareil MTP
	adb     bool // telephone sans interface MTP (mode "recharge"), vu par son interface ADB
	// fallbackID : identifiant vid-pid-bus-adresse faute de n° de serie
	// (premiere ouverture ratee) ; remplace des que le n° est connu.
	fallbackID bool
	working    bool // une goroutine d'ouverture/rafraichissement tourne
	removed    bool
	nextTry    time.Time
}

// Manager surveille le bus USB et gere les sessions MTP.
type Manager struct {
	ctx *usb.Context

	mu      sync.Mutex
	entries map[string]*entry
	stop    chan struct{}
	done    chan struct{}
}

// NewManager initialise libusb et lance la surveillance.
func NewManager() (*Manager, error) {
	ctx := usb.NewContext()
	if ctx == nil {
		return nil, errors.New("libusb_init failed")
	}
	m := &Manager{ctx: ctx, entries: map[string]*entry{}, stop: make(chan struct{}), done: make(chan struct{})}
	go m.loop()
	return m, nil
}

func (m *Manager) loop() {
	defer close(m.done)
	t := time.NewTicker(PollInterval)
	defer t.Stop()
	for {
		m.scan()
		select {
		case <-m.stop:
			return
		case <-t.C:
		}
	}
}

// scan : enumeration sans ouverture, detection branchement/debranchement.
func (m *Manager) scan() {
	list, err := m.ctx.GetDeviceList()
	if err != nil {
		log.Printf("USB enumeration: %v", err)
		return
	}
	present := map[string]*candidate{}
	adb := map[string]bool{}
	for _, ud := range list {
		c := candidateFromDevice(ud)
		isADB := false
		if c != nil && !likelyMTPClass(c) {
			// 3 points d'acces mais pas une classe MTP/PTP (adaptateur
			// serie CH340/PL2303...) : on n'y touche pas.
			c = nil
		}
		if c == nil {
			// Telephone branche en mode "recharge uniquement" : pas
			// d'interface MTP. On ne le voit que s'il expose ADB.
			if c = adbCandidate(ud); c == nil {
				continue
			}
			isADB = true
		}
		if c.devDescr.IdVendor == vendorApple || c.devDescr.DeviceClass == 0x09 {
			continue
		}
		key := fmt.Sprintf("%03d-%03d-%04x-%04x", c.bus, c.addr, c.devDescr.IdVendor, c.devDescr.IdProduct)
		present[key] = c
		adb[key] = isADB
	}

	m.mu.Lock()
	// debranchements d'abord (un telephone rebranche change d'adresse).
	// Un telephone qui passe de "recharge" (ADB seul) a "Transfert de
	// fichiers" (ou l'inverse) sans changer de bus/adresse/vid/pid est
	// traite comme debranche puis rebranche, pour etre re-sonde.
	for key, e := range m.entries {
		if _, ok := present[key]; !ok || e.adb != adb[key] {
			m.removeLocked(e)
		}
	}
	now := time.Now()
	for key, c := range present {
		e := m.entries[key]
		if e == nil {
			c.dev = c.dev.Ref()
			e = &entry{key: key, c: c, adb: adb[key]}
			m.entries[key] = e
			if e.adb {
				m.startLocked(e, m.openADB)
			} else {
				m.startLocked(e, m.open)
			}
			continue
		}
		if e.ignored || e.adb || e.working || e.dev == nil && !now.After(e.nextTry) {
			continue
		}
		switch {
		case e.dev == nil:
			m.startLocked(e, m.open)
		case e.dev.State() == core.StateLocked:
			m.startLocked(e, m.refreshLocked)
		case (e.dev.State() == core.StateBusy || e.dev.State() == core.StateError) && now.After(e.nextTry):
			m.startLocked(e, m.open)
		}
	}
	m.mu.Unlock()
	if len(list) > 0 {
		list.Done()
	}
}

func (m *Manager) startLocked(e *entry, fn func(*entry)) {
	e.working = true
	go func() {
		fn(e)
		m.mu.Lock()
		e.working = false
		if e.removed {
			m.cleanupLocked(e)
		}
		m.mu.Unlock()
	}()
}

// removeLocked : appareil debranche.
func (m *Manager) removeLocked(e *entry) {
	delete(m.entries, e.key)
	e.removed = true
	if e.dev != nil {
		log.Printf("device %s unplugged", e.dev.ID())
	}
	if !e.working {
		m.cleanupLocked(e)
	}
}

// cleanupLocked ferme la session (en arriere-plan : une transaction en
// cours va echouer d'elle-meme avec LIBUSB_ERROR_NO_DEVICE) puis rend la
// reference libusb.
func (m *Manager) cleanupLocked(e *entry) {
	if e.c == nil {
		return
	}
	c := e.c
	e.c = nil
	dev := e.dev
	go func() {
		if dev != nil {
			dev.Close(core.StateError, "unplugged", 30*time.Second)
		}
		c.dev.Unref()
	}()
}

// refreshLocked : appareil verrouille, on re-interroge les stockages.
func (m *Manager) refreshLocked(e *entry) {
	if err := e.dev.RefreshStorages(true); err != nil {
		log.Printf("device %s: storage refresh: %v", e.dev.ID(), err)
	}
	if e.dev.State() == core.StateReady {
		log.Printf("device %s unlocked: %d storage(s)", e.dev.ID(), len(e.dev.Status().Storages))
	}
}

var idClean = regexp.MustCompile(`[^A-Za-z0-9_-]+`)

func sanitizeID(s string) string {
	return strings.Trim(idClean.ReplaceAllString(strings.TrimSpace(s), "-"), "-")
}

// assignID choisit l'identifiant stable : n° de serie USB, sinon
// vid-pid-bus-adresse ; suffixe si deux appareils ont le meme n° (cas des
// telephones bon marche "0123456789ABCDEF").
func (m *Manager) assignID(e *entry, serial string) string {
	id := sanitizeID(serial)
	if id == "" {
		id = fmt.Sprintf("%04x-%04x-%d-%d", e.c.devDescr.IdVendor, e.c.devDescr.IdProduct, e.c.bus, e.c.addr)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, o := range m.entries {
		if o != e && o.dev != nil && o.dev.ID() == id {
			return fmt.Sprintf("%s-b%da%d", id, e.c.bus, e.c.addr)
		}
	}
	return id
}

func isBusyErr(err error) bool {
	var ue usb.Error
	if errors.As(err, &ue) {
		// macOS : kIOReturnExclusiveAccess -> ACCESS ; Linux : EBUSY ;
		// NOT_FOUND = point d'acces sur une interface non reclamee.
		return ue == usb.ERROR_ACCESS || ue == usb.ERROR_BUSY || ue == usb.ERROR_NOT_FOUND
	}
	return errors.Is(err, mtp.RCError(mtp.RC_DeviceBusy))
}

func likelyMTPClass(c *candidate) bool {
	cl, sub := c.ifaceDescr.InterfaceClass, c.ifaceDescr.InterfaceSubClass
	return (cl == 0xFF && sub == 0xFF) || cl == 0x06
}

// open : ouverture complete d'un appareil (goroutine). Calquee sur
// mtp.SelectDevice + mtp.Device.Configure (ce que fait Kalam), mais sans
// jamais reinitialiser un appareil tenu par un autre programme. Seules les
// interfaces de classe MTP/PTP arrivent ici (filtre dans scan).
func (m *Manager) open(e *entry) {
	m.mu.Lock()
	c := e.c
	m.mu.Unlock()
	if c == nil {
		return
	}
	var manufacturer, product, usbSerial string
	// L'appareil n'est cree (visible) qu'une fois son identifiant connu :
	// n° de serie USB ; a defaut n° de serie MTP (DeviceInfo, apres la
	// session) ; a defaut (echec avant) vid-pid-bus-adresse.
	devFor := func(serial string) *core.Device {
		return m.ensureDevice(e, serial, product, manufacturer)
	}
	fail := func(s core.State, msg string) {
		m.mu.Lock()
		e.nextTry = time.Now().Add(RetryInterval)
		m.mu.Unlock()
		dev := devFor(usbSerial)
		dev.SetState(s, msg)
		log.Printf("device %s: %s: %s", dev.ID(), s, msg)
	}
	ignore := func() {
		m.mu.Lock()
		e.ignored = true
		m.mu.Unlock()
		m.dropDevice(e)
	}
	t := &transport{c: c, Timeout: timeoutOpen}

	if err := t.openHandle(); err != nil {
		// Impossible d'ouvrir (Linux : droits udev ; macOS : rare).
		st, msg := core.StateError, "cannot open USB device: "+err.Error()
		if isBusyErr(err) && !errors.Is(err, usb.ERROR_ACCESS) {
			st, msg = core.StateBusy, busyHint+": "+err.Error()
		}
		fail(st, msg)
		return
	}

	looksMTP, known, serr := t.interfaceLooksMTP()
	if known && !looksMTP {
		// ex. telephone en mode PTP, appareil photo : pas pour nous
		t.Close()
		ignore()
		return
	}
	if serr != nil {
		log.Printf("USB %s: interface string: %v", e.key, serr)
	}
	manufacturer = t.stringDescr(c.devDescr.Manufacturer)
	product = t.stringDescr(c.devDescr.Product)
	usbSerial = t.stringDescr(c.devDescr.SerialNumber)

	if usbSerial != "" {
		if dev := devFor(usbSerial); dev.State() != core.StateConnecting {
			dev.SetState(core.StateConnecting, "")
		}
	}

	if err := t.ensureConfig(); err != nil {
		log.Printf("USB %s: set configuration: %v", e.key, err)
	}
	if err := t.claim(); err != nil {
		t.Close()
		if isBusyErr(err) {
			fail(core.StateBusy, busyHint+": "+err.Error())
		} else {
			fail(core.StateError, "claim interface: "+err.Error())
		}
		return
	}

	if !known {
		// Pas de chaine d'interface : GetDeviceInfo hors session, comme
		// go-mtpfs, pour verifier l'extension MTP.
		var info rawDeviceInfo
		_ = t.GetDeviceInfo(&info)
		ext := strings.ToLower(info.MTPExtension)
		if !strings.Contains(ext, "microsoft") && !strings.Contains(ext, "android") {
			t.Close()
			ignore()
			return
		}
		if t.h == nil {
			fail(core.StateError, "GetDeviceInfo failed")
			return
		}
	}

	err := openSession(t)
	if err != nil && isBusyErr(err) {
		t.Close()
		fail(core.StateBusy, busyHint+": OpenSession: "+err.Error())
		return
	}
	if err != nil {
		// Comme mtp.Device.Configure : reset puis nouvel essai. On tient
		// l'interface, donc le reset ne perturbe aucun autre programme.
		log.Printf("USB %s: OpenSession failed (%v), resetting", e.key, err)
		if t.h != nil {
			_ = t.h.Reset()
		}
		t.Close()
		time.Sleep(time.Second)
		if err = t.openHandle(); err == nil {
			if err = t.claim(); err == nil {
				err = openSession(t)
			}
		}
		if err != nil {
			t.Close()
			if isBusyErr(err) {
				fail(core.StateBusy, busyHint+": "+err.Error())
			} else {
				fail(core.StateError, "OpenSession: "+err.Error())
			}
			return
		}
	}

	t.Timeout = timeoutNormal
	var info rawDeviceInfo
	if err := t.GetDeviceInfo(&info); err != nil {
		if t.h == nil {
			fail(core.StateError, "GetDeviceInfo: "+err.Error())
			return
		}
		log.Printf("USB %s: GetDeviceInfo: %v (continuing)", e.key, err)
	}
	serial := usbSerial
	if serial == "" {
		serial = strings.TrimSpace(info.SerialNumber)
	}
	m.mu.Lock()
	switchID := e.dev != nil && e.fallbackID && serial != ""
	m.mu.Unlock()
	if switchID {
		// identifiant provisoire (echec precedent) -> identifiant stable
		m.dropDevice(e)
	}
	dev := devFor(serial)
	name := strings.TrimSpace(info.Model)
	if name == "" {
		name = product
	}
	if name == "" {
		name = "Android"
	}
	man := strings.TrimSpace(info.Manufacturer)
	if man == "" {
		man = manufacturer
	}
	dev.SetIdentity(name, man)
	if dev.State() != core.StateConnecting {
		dev.SetState(core.StateConnecting, "")
	}

	conn := newConn(t, &info)
	storages, err := conn.Storages()
	if err != nil {
		conn.Close()
		fail(core.StateError, "storages: "+err.Error())
		return
	}
	m.mu.Lock()
	if e.removed {
		m.mu.Unlock()
		conn.Close()
		return
	}
	e.conn = conn
	m.mu.Unlock()
	dev.Attach(conn, storages)
	log.Printf("device %s (%s %s): %s, %d storage(s), partial64=%v move=%v copy=%v",
		dev.ID(), man, name, dev.State(), len(storages),
		conn.ops[mtp.OC_ANDROID_GET_PARTIAL_OBJECT64], conn.ops[mtp.OC_MoveObject], conn.ops[mtp.OC_CopyObject])
}

// adbCandidate reconnait un telephone Android sans interface MTP mais avec
// une interface ADB (classe 0xFF, sous-classe 0x42, protocole 0x01).
func adbCandidate(d *usb.Device) *candidate {
	dd, err := d.GetDeviceDescriptor()
	if err != nil {
		return nil
	}
	for i := byte(0); i < dd.NumConfigurations; i++ {
		cd, err := d.GetConfigDescriptor(i)
		if err != nil {
			return nil
		}
		for _, iface := range cd.Interfaces {
			for _, a := range iface.AltSetting {
				if a.InterfaceClass == 0xFF && a.InterfaceSubClass == 0x42 && a.InterfaceProtocol == 0x01 {
					return &candidate{dev: d, devDescr: *dd, ifaceDescr: a, bus: d.GetBusNumber(), addr: d.GetDeviceAddress()}
				}
			}
		}
	}
	return nil
}

// openADB : telephone visible mais transfert de fichiers desactive. On lit
// juste ses chaines (sans reclamer d'interface) pour l'afficher "locked".
func (m *Manager) openADB(e *entry) {
	m.mu.Lock()
	c := e.c
	m.mu.Unlock()
	if c == nil {
		return
	}
	t := &transport{c: c, Timeout: timeoutClose}
	var serial, product, manufacturer string
	if err := t.openHandle(); err == nil {
		manufacturer = t.stringDescr(c.devDescr.Manufacturer)
		product = t.stringDescr(c.devDescr.Product)
		serial = t.stringDescr(c.devDescr.SerialNumber)
		_ = t.h.Close()
		t.h = nil
	}
	dev := m.ensureDevice(e, serial, product, manufacturer)
	dev.SetState(core.StateLocked, "file transfer (MTP) is not enabled: unlock the phone and choose \"File transfer\" in the USB notification")
}

// ensureDevice cree (une fois) le core.Device visible de l'entree.
func (m *Manager) ensureDevice(e *entry, serial, product, manufacturer string) *core.Device {
	m.mu.Lock()
	dev := e.dev
	m.mu.Unlock()
	if dev != nil {
		return dev
	}
	id := m.assignID(e, serial)
	dev = core.NewDevice(id)
	if product == "" {
		product = "Android"
	}
	dev.SetIdentity(product, manufacturer)
	dev.OnGone = func(d *core.Device, err error) {
		log.Printf("device %s: %v", d.ID(), err)
		m.mu.Lock()
		e.conn = nil
		e.nextTry = time.Now().Add(RetryInterval)
		m.mu.Unlock()
	}
	m.mu.Lock()
	e.dev = dev
	e.fallbackID = strings.TrimSpace(serial) == ""
	m.mu.Unlock()
	log.Printf("device %s detected (%s)", id, e.key)
	return dev
}

func (m *Manager) dropDevice(e *entry) {
	m.mu.Lock()
	e.dev = nil
	m.mu.Unlock()
}

// Devices implemente server.Manager.
func (m *Manager) Devices() []*core.Device {
	m.mu.Lock()
	defer m.mu.Unlock()
	keys := make([]string, 0, len(m.entries))
	for k, e := range m.entries {
		if e.dev != nil && !e.ignored {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	out := make([]*core.Device, 0, len(keys))
	for _, k := range keys {
		out = append(out, m.entries[k].dev)
	}
	return out
}

func (m *Manager) find(id string) *entry {
	for _, e := range m.entries {
		if e.dev != nil && !e.ignored && e.dev.ID() == id {
			return e
		}
	}
	return nil
}

// Get implemente server.Manager.
func (m *Manager) Get(id string) *core.Device {
	m.mu.Lock()
	defer m.mu.Unlock()
	if e := m.find(id); e != nil {
		return e.dev
	}
	return nil
}

// Retry implemente server.Manager : ferme et rouvre maintenant.
func (m *Manager) Retry(id string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	e := m.find(id)
	if e == nil {
		return false
	}
	if e.working || e.adb {
		return true // une ouverture est deja en cours / rien a rouvrir
	}
	m.startLocked(e, func(e *entry) {
		e.dev.Close(core.StateConnecting, "", 30*time.Second)
		m.mu.Lock()
		e.conn = nil
		m.mu.Unlock()
		m.open(e)
	})
	return true
}

// Close implemente server.Manager : ferme les sessions et libere les
// interfaces.
func (m *Manager) Close() {
	close(m.stop)
	<-m.done
	m.mu.Lock()
	var wg sync.WaitGroup
	for _, e := range m.entries {
		if e.dev == nil {
			continue
		}
		wg.Add(1)
		go func(d *core.Device) {
			defer wg.Done()
			d.Close(core.StateError, "shutting down", 3*time.Second)
		}(e.dev)
	}
	m.mu.Unlock()
	wg.Wait()
}
