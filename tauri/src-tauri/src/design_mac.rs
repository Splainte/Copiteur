// ============================================================
//  Copiteur — BETA DESIGN : decor NATIF macOS des habillages A / B / C.
//
//  Le front (src/macChrome.tsx) decrit ce qu'il veut, on le construit ici :
//   - une vraie NSToolbar (capsules Liquid Glass, symboles SF, menu natif des
//     serveurs, champs de connexion de l'habillage C) ;
//   - du verre natif SOUS la webview, la ou la page est transparente (volet
//     lateral de A) : NSGlassEffectView sur macOS 26+, sinon le materiau
//     « barre laterale » classique (NSVisualEffectView) ;
//   - la pastille de transferts de B : du verre natif AU-DESSUS de la webview,
//     qui refracte donc vraiment les listes en dessous.
//  Les clics remontent au front par l'evenement `design://toolbar`.
//
//  Tout ce qui touche AppKit tourne sur le thread principal. Les vues sont
//  gardees dans un thread_local (thread principal uniquement) ; on ne garde
//  JAMAIS l'emprunt de cet etat pendant un appel AppKit qui peut rappeler le
//  delegue (setToolbar…), sinon double emprunt -> panique.
// ============================================================

use std::cell::RefCell;
use std::collections::HashMap;

use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, ProtocolObject, Sel};
use objc2::{define_class, msg_send, sel, ClassType, DefinedClass, MainThreadOnly};
use objc2_app_kit::{
    NSApplication, NSAutoresizingMaskOptions, NSClickGestureRecognizer, NSColor,
    NSControlStateValueOn, NSControlTextEditingDelegate, NSEventType, NSFocusRingType, NSFont,
    NSFontWeightBold, NSFontWeightSemibold, NSGlassEffectView, NSImage, NSImageView, NSItemBadge,
    NSLayoutAttribute, NSLayoutConstraint, NSLineBreakMode, NSMenu, NSMenuItem, NSMenuToolbarItem,
    NSProgressIndicator, NSProgressIndicatorStyle, NSSecureTextField, NSStackView, NSTextField,
    NSTextFieldDelegate, NSToolbar, NSToolbarDelegate, NSToolbarDisplayMode,
    NSToolbarFlexibleSpaceItemIdentifier, NSToolbarItem, NSToolbarItemStyle,
    NSToolbarSpaceItemIdentifier, NSUserInterfaceLayoutOrientation, NSView,
    NSVisualEffectBlendingMode, NSVisualEffectMaterial, NSVisualEffectState, NSVisualEffectView,
    NSWindow, NSWindowButton, NSWindowOrderingMode, NSWindowTitleVisibility, NSWindowToolbarStyle,
};
use objc2_foundation::{
    ns_string, MainThreadMarker, NSArray, NSEdgeInsets, NSNotification, NSObject,
    NSObjectProtocol, NSPoint, NSRect, NSSet, NSSize, NSString,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::design::{ChromeSpec, MenuEntry, Pill, Region, TbItem, ToolbarSpec};

// Prefixe de nos identifiants d'elements de barre (« cp.server »…).
const PREFIX: &str = "cp.";
// Separateur « element / entree » dans le representedObject des menus.
const SEP: char = '\u{1f}';

#[derive(Clone, Serialize)]
struct ToolbarEvent {
    id: String,
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    entry: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<String>,
}

// ---------- Etat (thread principal) ----------

struct PillViews {
    root: Retained<NSView>,
    title: Retained<NSTextField>,
    sub: Retained<NSTextField>,
    bar: Retained<NSProgressIndicator>,
    chevron: Retained<NSImageView>,
}

#[derive(Default)]
struct State {
    controller: Option<Retained<Controller>>,
    spec: Option<ToolbarSpec>,
    items: HashMap<String, Retained<NSToolbarItem>>,
    titles: HashMap<String, (Retained<NSTextField>, Retained<NSTextField>)>,
    fields: Vec<(String, Retained<NSTextField>)>,
    glass: Vec<Retained<NSView>>,
    pill: Option<PillViews>,
    vibrancy: Option<bool>,
    seq: u32,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
}

// ---------- Controleur Obj-C (delegue de la barre + cible des actions) ----------

pub struct Ivars {
    app: AppHandle,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "CopiteurDesignController"]
    #[ivars = Ivars]
    pub struct Controller;

    unsafe impl NSObjectProtocol for Controller {}

    unsafe impl NSToolbarDelegate for Controller {
        #[unsafe(method_id(toolbar:itemForItemIdentifier:willBeInsertedIntoToolbar:))]
        fn toolbar_item(
            &self,
            _toolbar: &NSToolbar,
            identifier: &NSString,
            _flag: bool,
        ) -> Option<Retained<NSToolbarItem>> {
            self.make_item(identifier)
        }

        #[unsafe(method_id(toolbarDefaultItemIdentifiers:))]
        fn default_identifiers(&self, _toolbar: &NSToolbar) -> Retained<NSArray<NSString>> {
            identifiers()
        }

        #[unsafe(method_id(toolbarAllowedItemIdentifiers:))]
        fn allowed_identifiers(&self, _toolbar: &NSToolbar) -> Retained<NSArray<NSString>> {
            identifiers()
        }
    }

    unsafe impl NSControlTextEditingDelegate for Controller {
        #[unsafe(method(controlTextDidChange:))]
        fn control_text_did_change(&self, notification: &NSNotification) {
            let sender = notification.object();
            self.field_changed(sender.as_deref());
        }
    }

    unsafe impl NSTextFieldDelegate for Controller {}

    impl Controller {
        #[unsafe(method(onButton:))]
        fn on_button(&self, sender: Option<&AnyObject>) {
            let Some(item) = sender.and_then(|s| s.downcast_ref::<NSToolbarItem>()) else {
                return;
            };
            let ident = item.itemIdentifier().to_string();
            if let Some(id) = ident.strip_prefix(PREFIX) {
                self.emit(id, "click", None, None);
            }
        }

        #[unsafe(method(onMenuEntry:))]
        fn on_menu_entry(&self, sender: Option<&AnyObject>) {
            let Some(mi) = sender.and_then(|s| s.downcast_ref::<NSMenuItem>()) else {
                return;
            };
            let Some(obj) = mi.representedObject() else { return };
            let Some(key) = obj.downcast_ref::<NSString>() else { return };
            let key = key.to_string();
            if let Some((id, entry)) = key.split_once(SEP) {
                self.emit(id, "menu", Some(entry.to_string()), None);
            }
        }

        // Action des champs : seulement sur Entree (pas en perdant le focus).
        #[unsafe(method(onFieldSubmit:))]
        fn on_field_submit(&self, sender: Option<&AnyObject>) {
            if !return_key_pressed(self.mtm()) {
                return;
            }
            if let Some(id) = field_id(sender) {
                self.emit(&id, "submit", None, None);
            }
        }

        #[unsafe(method(onPill:))]
        fn on_pill(&self, _sender: Option<&AnyObject>) {
            self.emit("pill", "click", None, None);
        }
    }
);

impl Controller {
    fn new(app: AppHandle, mtm: MainThreadMarker) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(Ivars { app });
        unsafe { msg_send![super(this), init] }
    }

    fn as_target(&self) -> &AnyObject {
        self.as_ref()
    }

    fn emit(&self, id: &str, kind: &'static str, entry: Option<String>, value: Option<String>) {
        let _ = self.ivars().app.emit(
            "design://toolbar",
            ToolbarEvent { id: id.to_string(), kind, entry, value },
        );
    }

    fn field_changed(&self, sender: Option<&AnyObject>) {
        let Some(sender) = sender else { return };
        let ptr = sender as *const AnyObject;
        let hit = STATE.with(|s| {
            s.borrow()
                .fields
                .iter()
                .find(|(_, f)| Retained::as_ptr(f).cast::<AnyObject>() == ptr)
                .map(|(id, f)| (id.clone(), f.stringValue().to_string()))
        });
        if let Some((id, value)) = hit {
            self.emit(&id, "change", None, Some(value));
        }
    }

    // Construit l'element demande par la barre, d'apres la description courante.
    fn make_item(&self, identifier: &NSString) -> Option<Retained<NSToolbarItem>> {
        let mtm = self.mtm();
        let ident = identifier.to_string();
        let id = ident.strip_prefix(PREFIX)?.to_string();
        let spec_item = STATE.with(|s| {
            s.borrow()
                .spec
                .as_ref()
                .and_then(|sp| sp.items.iter().find(|i| i.id() == Some(id.as_str())).cloned())
        })?;
        let item: Retained<NSToolbarItem> = match spec_item {
            TbItem::Menu { .. } => Retained::into_super(NSMenuToolbarItem::initWithItemIdentifier(
                NSMenuToolbarItem::alloc(mtm),
                identifier,
            )),
            _ => NSToolbarItem::initWithItemIdentifier(NSToolbarItem::alloc(mtm), identifier),
        };
        self.configure(&item, &spec_item, true);
        STATE.with(|s| {
            s.borrow_mut().items.insert(id, item.clone());
        });
        Some(item)
    }

    // Applique une description a un element (a la creation, puis a chaque mise
    // a jour envoyee par le front).
    fn configure(&self, item: &NSToolbarItem, spec: &TbItem, fresh: bool) {
        let mtm = self.mtm();
        match spec {
            TbItem::Title { id, text, sub, fill_to } => {
                if fresh {
                    let name = label(text, mtm);
                    name.setFont(Some(&NSFont::systemFontOfSize_weight(15.0, unsafe {
                        NSFontWeightBold
                    })));
                    let small = label(sub, mtm);
                    small.setFont(Some(&NSFont::systemFontOfSize(12.0)));
                    small.setTextColor(Some(&NSColor::secondaryLabelColor()));
                    small.setLineBreakMode(NSLineBreakMode::ByTruncatingTail);
                    small.setContentCompressionResistancePriority_forOrientation(
                        250.0,
                        objc2_app_kit::NSLayoutConstraintOrientation::Horizontal,
                    );
                    let stack = hstack(&[&name, &small], mtm);
                    stack.setSpacing(6.0);
                    stack.setAlignment(NSLayoutAttribute::FirstBaseline);
                    if *fill_to > 0.0 {
                        let w = self
                            .ivars()
                            .app
                            .get_webview_window("main")
                            .and_then(|w| ns_window(&w))
                            .map(|w| title_width(&w, *fill_to))
                            .unwrap_or(*fill_to - 92.0);
                        stack.widthAnchor().constraintEqualToConstant(w).setActive(true);
                    }
                    item.setView(Some(&stack));
                    item.setBordered(false);
                    STATE.with(|s| {
                        s.borrow_mut().titles.insert(id.clone(), (name, small));
                    });
                } else {
                    STATE.with(|s| {
                        if let Some((name, small)) = s.borrow().titles.get(id) {
                            name.setStringValue(&NSString::from_str(text));
                            small.setStringValue(&NSString::from_str(sub));
                        }
                    });
                }
                item.setLabel(&NSString::from_str(text));
            }
            TbItem::Button { label: text, symbol: sym, tip, prominent, enabled, badge, .. } => {
                let t = NSString::from_str(text);
                item.setLabel(&t);
                item.setToolTip(Some(&NSString::from_str(tip)));
                if *prominent {
                    item.setTitle(&t);
                } else {
                    item.setImage(symbol(sym, text).as_deref());
                }
                item.setBordered(true);
                if fresh {
                    unsafe {
                        item.setTarget(Some(self.as_target()));
                        item.setAction(Some(sel!(onButton:)));
                    }
                }
                if responds(item, sel!(setStyle:)) {
                    item.setStyle(if *prominent {
                        NSToolbarItemStyle::Prominent
                    } else {
                        NSToolbarItemStyle::Plain
                    });
                }
                item.setEnabled(*enabled);
                // Pastille (badge) : macOS 14+.
                if AnyClass::get(c"NSItemBadge").is_some() && responds(item, sel!(setBadge:)) {
                    if badge.is_empty() {
                        item.setBadge(None);
                    } else {
                        item.setBadge(Some(&NSItemBadge::badgeWithText(&NSString::from_str(badge))));
                    }
                }
            }
            TbItem::Menu { id, symbol: sym, title, tip, entries } => {
                let Some(m) = item.downcast_ref::<NSMenuToolbarItem>() else { return };
                let t = NSString::from_str(title);
                m.setTitle(&t);
                m.setLabel(&t);
                m.setToolTip(Some(&NSString::from_str(tip)));
                m.setImage(symbol(sym, title).as_deref());
                m.setShowsIndicator(true);
                m.setMenu(&self.build_menu(id, entries));
            }
            TbItem::Field { id, placeholder, value, secure, width } => {
                if fresh {
                    let field: Retained<NSTextField> = if *secure {
                        Retained::into_super(NSSecureTextField::new(mtm))
                    } else {
                        NSTextField::new(mtm)
                    };
                    field.setStringValue(&NSString::from_str(value));
                    field.setBordered(false);
                    field.setBezeled(false);
                    field.setDrawsBackground(false);
                    field.setFocusRingType(NSFocusRingType::None);
                    field.setUsesSingleLineMode(true);
                    field.setLineBreakMode(NSLineBreakMode::ByTruncatingTail);
                    field.setFont(Some(&NSFont::systemFontOfSize(13.0)));
                    unsafe {
                        field.setDelegate(Some(ProtocolObject::from_ref(self)));
                        field.setTarget(Some(self.as_target()));
                        field.setAction(Some(sel!(onFieldSubmit:)));
                    }
                    // Le verre de la barre entoure l'element : on decale le texte
                    // du bord de la capsule.
                    let holder = NSView::new(mtm);
                    holder.setTranslatesAutoresizingMaskIntoConstraints(false);
                    field.setTranslatesAutoresizingMaskIntoConstraints(false);
                    holder.addSubview(&field);
                    let c = [
                        holder.widthAnchor().constraintEqualToConstant(*width),
                        holder.heightAnchor().constraintEqualToConstant(28.0),
                        field.leadingAnchor().constraintEqualToAnchor_constant(&holder.leadingAnchor(), 10.0),
                        field.trailingAnchor().constraintEqualToAnchor_constant(&holder.trailingAnchor(), -8.0),
                        field.centerYAnchor().constraintEqualToAnchor(&holder.centerYAnchor()),
                    ];
                    NSLayoutConstraint::activateConstraints(&NSArray::from_retained_slice(&c));
                    item.setView(Some(&holder));
                    STATE.with(|s| s.borrow_mut().fields.push((id.clone(), field.clone())));
                    field.setPlaceholderString(Some(&NSString::from_str(placeholder)));
                } else {
                    let field = STATE.with(|s| {
                        s.borrow().fields.iter().find(|(i, _)| i == id).map(|(_, f)| f.clone())
                    });
                    if let Some(field) = field {
                        field.setPlaceholderString(Some(&NSString::from_str(placeholder)));
                        // Pas d'echo pendant la frappe : on ne reecrit que si la
                        // valeur vient d'ailleurs (serveur choisi dans le menu).
                        if field.currentEditor().is_none() && field.stringValue().to_string() != *value {
                            field.setStringValue(&NSString::from_str(value));
                        }
                    }
                }
                item.setLabel(&NSString::from_str(placeholder));
            }
            TbItem::Flex | TbItem::Space => {}
        }
    }

    fn build_menu(&self, item_id: &str, entries: &[MenuEntry]) -> Retained<NSMenu> {
        let mtm = self.mtm();
        let menu = NSMenu::new(mtm);
        menu.setAutoenablesItems(false);
        // Titres de section (macOS 14+) : message de CLASSE, on interroge donc la classe.
        let has_headers: bool =
            unsafe { msg_send![NSMenuItem::class(), respondsToSelector: sel!(sectionHeaderWithTitle:)] };
        for e in entries {
            if e.separator {
                menu.addItem(&NSMenuItem::separatorItem(mtm));
                continue;
            }
            let title = NSString::from_str(&e.title);
            if e.header {
                let h = if has_headers {
                    NSMenuItem::sectionHeaderWithTitle(&title, mtm)
                } else {
                    let h = unsafe {
                        NSMenuItem::initWithTitle_action_keyEquivalent(
                            NSMenuItem::alloc(mtm),
                            &title,
                            None,
                            ns_string!(""),
                        )
                    };
                    h.setEnabled(false);
                    h
                };
                menu.addItem(&h);
                continue;
            }
            let mi = unsafe {
                NSMenuItem::initWithTitle_action_keyEquivalent(
                    NSMenuItem::alloc(mtm),
                    &title,
                    Some(sel!(onMenuEntry:)),
                    ns_string!(""),
                )
            };
            let key = NSString::from_str(&format!("{item_id}{SEP}{}", e.id));
            let any: &AnyObject = &key;
            unsafe {
                mi.setTarget(Some(self.as_target()));
                mi.setRepresentedObject(Some(any));
            }
            mi.setEnabled(e.enabled.unwrap_or(true));
            if e.checked {
                mi.setState(NSControlStateValueOn);
            }
            if !e.symbol.is_empty() {
                mi.setImage(symbol(&e.symbol, &e.title).as_deref());
            }
            if !e.subtitle.is_empty() && responds(&mi, sel!(setSubtitle:)) {
                mi.setSubtitle(Some(&NSString::from_str(&e.subtitle)));
            }
            menu.addItem(&mi);
        }
        menu
    }
}

// ---------- Aides ----------

fn identifiers() -> Retained<NSArray<NSString>> {
    let flexible: &NSString = unsafe { NSToolbarFlexibleSpaceItemIdentifier };
    let space: &NSString = unsafe { NSToolbarSpaceItemIdentifier };
    let ids: Vec<Retained<NSString>> = STATE.with(|s| {
        s.borrow()
            .spec
            .as_ref()
            .map(|sp| {
                sp.items
                    .iter()
                    .map(|i| match i {
                        TbItem::Flex => NSString::from_str(&flexible.to_string()),
                        TbItem::Space => NSString::from_str(&space.to_string()),
                        other => NSString::from_str(&format!("{PREFIX}{}", other.id().unwrap_or(""))),
                    })
                    .collect()
            })
            .unwrap_or_default()
    });
    NSArray::from_retained_slice(&ids)
}

fn field_id(sender: Option<&AnyObject>) -> Option<String> {
    let ptr = sender? as *const AnyObject;
    STATE.with(|s| {
        s.borrow()
            .fields
            .iter()
            .find(|(_, f)| Retained::as_ptr(f).cast::<AnyObject>() == ptr)
            .map(|(id, _)| id.clone())
    })
}

fn responds(obj: &NSObject, selector: Sel) -> bool {
    obj.respondsToSelector(selector)
}

fn symbol(name: &str, description: &str) -> Option<Retained<NSImage>> {
    if name.is_empty() {
        return None;
    }
    NSImage::imageWithSystemSymbolName_accessibilityDescription(
        &NSString::from_str(name),
        Some(&NSString::from_str(description)),
    )
}

fn label(text: &str, mtm: MainThreadMarker) -> Retained<NSTextField> {
    NSTextField::labelWithString(&NSString::from_str(text), mtm)
}

fn hstack(views: &[&NSView], mtm: MainThreadMarker) -> Retained<NSStackView> {
    let stack = NSStackView::new(mtm);
    for v in views {
        stack.addArrangedSubview(v);
    }
    stack.setOrientation(NSUserInterfaceLayoutOrientation::Horizontal);
    stack.setSpacing(8.0);
    stack.setAlignment(NSLayoutAttribute::CenterY);
    stack
}

fn vstack(views: &[&NSView], spacing: f64, mtm: MainThreadMarker) -> Retained<NSStackView> {
    let stack = NSStackView::new(mtm);
    for v in views {
        stack.addArrangedSubview(v);
    }
    stack.setOrientation(NSUserInterfaceLayoutOrientation::Vertical);
    stack.setAlignment(NSLayoutAttribute::Leading);
    stack.setSpacing(spacing);
    stack
}

fn return_key_pressed(mtm: MainThreadMarker) -> bool {
    let app = NSApplication::sharedApplication(mtm);
    match app.currentEvent() {
        Some(ev) => ev.r#type() == NSEventType::KeyDown && matches!(ev.keyCode(), 36 | 76),
        None => false,
    }
}

fn ns_window(window: &tauri::WebviewWindow) -> Option<Retained<NSWindow>> {
    let ptr = window.ns_window().ok()?;
    unsafe { Retained::retain(ptr as *mut NSWindow) }
}

// Largeur du titre « Copiteur » pour que l'element suivant commence au ras du
// volet lateral (dont le bord droit est `fill_to`, en points depuis la gauche).
fn title_width(window: &NSWindow, fill_to: f64) -> f64 {
    let zoom_end = window
        .standardWindowButton(NSWindowButton::ZoomButton)
        .map(|b| {
            let r = b.convertRect_toView(b.bounds(), None);
            r.origin.x + r.size.width
        })
        .unwrap_or(72.0);
    (fill_to - zoom_end - 22.0).max(60.0)
}

// Rend la main au front une fois le travail fait sur le thread principal.
fn on_main<R: Send + 'static>(
    app: &AppHandle,
    f: impl FnOnce(MainThreadMarker, &AppHandle) -> R + Send + 'static,
) -> Option<R> {
    let (tx, rx) = std::sync::mpsc::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        if let Some(mtm) = MainThreadMarker::new() {
            let _ = tx.send(f(mtm, &handle));
        }
    })
    .ok()?;
    rx.recv().ok()
}

fn controller(app: &AppHandle, mtm: MainThreadMarker) -> Retained<Controller> {
    if let Some(c) = STATE.with(|s| s.borrow().controller.clone()) {
        return c;
    }
    let c = Controller::new(app.clone(), mtm);
    STATE.with(|s| s.borrow_mut().controller = Some(c.clone()));
    c
}

// Une vue de verre (macOS 26+) ou, a defaut, de materiau « barre laterale ».
fn glass_view(frame: NSRect, radius: f64, mtm: MainThreadMarker) -> Retained<NSView> {
    if has_glass() {
        let g = NSGlassEffectView::initWithFrame(NSGlassEffectView::alloc(mtm), frame);
        g.setCornerRadius(radius);
        return Retained::into_super(g);
    }
    let v = NSVisualEffectView::initWithFrame(NSVisualEffectView::alloc(mtm), frame);
    v.setMaterial(NSVisualEffectMaterial::Sidebar);
    v.setBlendingMode(NSVisualEffectBlendingMode::BehindWindow);
    v.setState(NSVisualEffectState::Active);
    v.setWantsLayer(true);
    unsafe {
        let layer: *mut AnyObject = msg_send![&*v, layer];
        if !layer.is_null() {
            let _: () = msg_send![layer, setCornerRadius: radius];
            let _: () = msg_send![layer, setMasksToBounds: true];
        }
    }
    Retained::into_super(v)
}

fn has_glass() -> bool {
    AnyClass::get(c"NSGlassEffectView").is_some()
}

// Rectangle « page » (origine en haut a gauche) -> repere de la vue hote.
fn to_view_rect(host: &NSView, x: f64, y: f64, w: f64, h: f64) -> NSRect {
    let b = host.bounds();
    let yy = if host.isFlipped() { y } else { b.size.height - y - h };
    NSRect::new(NSPoint::new(x, yy), NSSize::new(w, h))
}

// Ancrage pendant le redimensionnement en direct (le front recale ensuite au
// pixel pres) : quels bords suivent la fenetre.
fn mask_for(anchor: &str, flipped: bool) -> NSAutoresizingMaskOptions {
    let top_flex = if flipped {
        NSAutoresizingMaskOptions::ViewMinYMargin
    } else {
        NSAutoresizingMaskOptions::ViewMaxYMargin
    };
    let bottom_flex = if flipped {
        NSAutoresizingMaskOptions::ViewMaxYMargin
    } else {
        NSAutoresizingMaskOptions::ViewMinYMargin
    };
    match anchor {
        "top" => NSAutoresizingMaskOptions::ViewWidthSizable | bottom_flex,
        "bottom" => NSAutoresizingMaskOptions::ViewWidthSizable | top_flex,
        "bottom-center" => {
            NSAutoresizingMaskOptions::ViewMinXMargin | NSAutoresizingMaskOptions::ViewMaxXMargin | top_flex
        }
        "full" => NSAutoresizingMaskOptions::ViewWidthSizable | NSAutoresizingMaskOptions::ViewHeightSizable,
        // "left" : volet lateral (bord gauche, haut et bas fixes).
        _ => NSAutoresizingMaskOptions::ViewMaxXMargin | NSAutoresizingMaskOptions::ViewHeightSizable,
    }
}

fn clear_glass() {
    let old = STATE.with(|s| std::mem::take(&mut s.borrow_mut().glass));
    for v in old {
        v.removeFromSuperview();
    }
}

fn clear_pill() {
    if let Some(p) = STATE.with(|s| s.borrow_mut().pill.take()) {
        p.root.removeFromSuperview();
    }
}

fn set_vibrancy(window: &tauri::WebviewWindow, on: bool) {
    use window_vibrancy::{apply_vibrancy, clear_vibrancy, NSVisualEffectMaterial as M, NSVisualEffectState as S};
    if STATE.with(|s| s.borrow().vibrancy) == Some(on) {
        return;
    }
    let _ = clear_vibrancy(window);
    if on {
        let _ = apply_vibrancy(window, M::UnderWindowBackground, Some(S::Active), None);
    }
    STATE.with(|s| s.borrow_mut().vibrancy = Some(on));
}

// ---------- Fonctions appelees par les commandes (design.rs) ----------

pub fn apply(app: &AppHandle, spec: ChromeSpec) -> f64 {
    on_main(app, move |mtm, app| {
        let Some(webview_window) = app.get_webview_window("main") else {
            return 0.0;
        };
        let Some(window) = ns_window(&webview_window) else {
            return 0.0;
        };
        let ctrl = controller(app, mtm);

        // Fond : vibrancy plein cadre (Actuelle, Classique) ou rien (la page
        // peint elle-meme, le verre est pose a part).
        set_vibrancy(&webview_window, spec.vibrancy);
        clear_glass();
        clear_pill();

        // Barre d'outils : description memorisee AVANT de l'installer (le
        // delegue la lit pendant setToolbar), emprunt relache avant l'appel.
        let seq = STATE.with(|s| {
            let mut st = s.borrow_mut();
            st.items.clear();
            st.titles.clear();
            st.fields.clear();
            st.spec = spec.toolbar.clone();
            st.seq += 1;
            st.seq
        });
        match &spec.toolbar {
            None => {
                window.setToolbar(None);
            }
            Some(tb) => {
                let ident = NSString::from_str(&format!("{}.{seq}", tb.id));
                let toolbar = NSToolbar::initWithIdentifier(NSToolbar::alloc(mtm), &ident);
                toolbar.setDelegate(Some(ProtocolObject::from_ref(&*ctrl)));
                toolbar.setAllowsUserCustomization(false);
                toolbar.setDisplayMode(NSToolbarDisplayMode::IconOnly);
                if !tb.centered.is_empty() && responds(&toolbar, sel!(setCenteredItemIdentifiers:)) {
                    let ids: Vec<Retained<NSString>> = tb
                        .centered
                        .iter()
                        .map(|c| NSString::from_str(&format!("{PREFIX}{c}")))
                        .collect();
                    toolbar.setCenteredItemIdentifiers(&NSSet::from_retained_slice(&ids));
                }
                window.setToolbar(Some(&toolbar));
                window.setToolbarStyle(NSWindowToolbarStyle::Unified);
                window.setTitleVisibility(NSWindowTitleVisibility::Hidden);
            }
        }
        let h = window.frame().size.height - window.contentLayoutRect().size.height;
        if spec.toolbar.is_some() { h.max(0.0) } else { 0.0 }
    })
    .unwrap_or(0.0)
}

pub fn update_item(app: &AppHandle, item: TbItem) {
    on_main(app, move |_mtm, _app| {
        let Some(id) = item.id().map(str::to_string) else { return };
        // Garde la description a jour (un element recree par la barre, apres un
        // passage en debordement par exemple, repartira de la bonne valeur).
        let (ns_item, ctrl) = STATE.with(|s| {
            let mut st = s.borrow_mut();
            if let Some(sp) = st.spec.as_mut() {
                if let Some(slot) = sp.items.iter_mut().find(|i| i.id() == Some(id.as_str())) {
                    *slot = item.clone();
                }
            }
            (st.items.get(&id).cloned(), st.controller.clone())
        });
        if let (Some(ns_item), Some(ctrl)) = (ns_item, ctrl) {
            ctrl.configure(&ns_item, &item, false);
        }
    });
}

pub fn set_glass(app: &AppHandle, regions: Vec<Region>) {
    on_main(app, move |mtm, app| {
        let Some(window) = app.get_webview_window("main").and_then(|w| ns_window(&w)) else {
            return;
        };
        let Some(host) = window.contentView() else { return };
        let flipped = host.isFlipped();
        let existing = STATE.with(|s| s.borrow().glass.clone());
        // Meme nombre de zones : on se contente de recaler (redimensionnement).
        if existing.len() == regions.len() && !existing.is_empty() {
            for (v, r) in existing.iter().zip(regions.iter()) {
                v.setFrame(to_view_rect(&host, r.x, r.y, r.w, r.h));
            }
            return;
        }
        clear_glass();
        let mut views = Vec::new();
        for r in &regions {
            let v = glass_view(to_view_rect(&host, r.x, r.y, r.w, r.h), r.radius, mtm);
            v.setAutoresizingMask(mask_for(&r.anchor, flipped));
            // Tout au fond, sous la webview (la page y est transparente).
            host.addSubview_positioned_relativeTo(&v, NSWindowOrderingMode::Below, None);
            views.push(v);
        }
        STATE.with(|s| s.borrow_mut().glass = views);
    });
}

pub fn set_pill(app: &AppHandle, pill: Pill) {
    on_main(app, move |mtm, app| {
        if !pill.visible {
            clear_pill();
            return;
        }
        let Some(window) = app.get_webview_window("main").and_then(|w| ns_window(&w)) else {
            return;
        };
        let Some(host) = window.contentView() else { return };
        let ctrl = controller(app, mtm);
        const H: f64 = 52.0;

        let exists = STATE.with(|s| s.borrow().pill.is_some());
        if !exists {
            let frame = to_view_rect(&host, 0.0, 0.0, pill.width, H);
            let root = glass_view(frame, H / 2.0, mtm);

            let icon = match symbol("arrow.up.arrow.down.circle.fill", "Transferts") {
                Some(img) => NSImageView::imageViewWithImage(&img, mtm),
                None => NSImageView::new(mtm),
            };
            icon.setContentTintColor(Some(&NSColor::controlAccentColor()));
            let cfg = objc2_app_kit::NSImageSymbolConfiguration::configurationWithPointSize_weight(
                22.0,
                unsafe { NSFontWeightSemibold },
            );
            icon.setSymbolConfiguration(Some(&cfg));
            let title = label("", mtm);
            title.setFont(Some(&NSFont::systemFontOfSize_weight(13.0, unsafe { NSFontWeightSemibold })));
            let sub = label("", mtm);
            sub.setFont(Some(&NSFont::monospacedDigitSystemFontOfSize_weight(11.0, unsafe {
                objc2_app_kit::NSFontWeightRegular
            })));
            sub.setTextColor(Some(&NSColor::secondaryLabelColor()));
            sub.setLineBreakMode(NSLineBreakMode::ByTruncatingTail);
            sub.setContentCompressionResistancePriority_forOrientation(
                250.0,
                objc2_app_kit::NSLayoutConstraintOrientation::Horizontal,
            );
            let texts = vstack(&[&title, &sub], 1.0, mtm);
            texts.setContentCompressionResistancePriority_forOrientation(
                250.0,
                objc2_app_kit::NSLayoutConstraintOrientation::Horizontal,
            );
            let bar = NSProgressIndicator::new(mtm);
            bar.setStyle(NSProgressIndicatorStyle::Bar);
            bar.setIndeterminate(false);
            bar.setMinValue(0.0);
            bar.setMaxValue(100.0);
            bar.setControlSize(objc2_app_kit::NSControlSize::Small);
            bar.widthAnchor().constraintEqualToConstant(64.0).setActive(true);
            let chevron = match symbol("chevron.up", "Ouvrir") {
                Some(img) => NSImageView::imageViewWithImage(&img, mtm),
                None => NSImageView::new(mtm),
            };
            chevron.setContentTintColor(Some(&NSColor::secondaryLabelColor()));

            let row = hstack(&[&icon, &texts, &bar, &chevron], mtm);
            row.setSpacing(10.0);
            row.setEdgeInsets(NSEdgeInsets { top: 0.0, left: 12.0, bottom: 0.0, right: 16.0 });
            row.setFrame(NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(pill.width, H)));
            row.setAutoresizingMask(
                NSAutoresizingMaskOptions::ViewWidthSizable | NSAutoresizingMaskOptions::ViewHeightSizable,
            );
            // Ne demander la classe NSGlassEffectView que si elle existe (sinon
            // objc2 panique en la cherchant) : macOS 26+ uniquement.
            match has_glass().then(|| root.downcast_ref::<NSGlassEffectView>()).flatten() {
                Some(g) => g.setContentView(Some(&row)),
                None => root.addSubview(&row),
            }
            let click = unsafe {
                NSClickGestureRecognizer::initWithTarget_action(
                    NSClickGestureRecognizer::alloc(mtm),
                    Some(ctrl.as_target()),
                    Some(sel!(onPill:)),
                )
            };
            root.addGestureRecognizer(&click);
            root.setAutoresizingMask(mask_for("bottom-center", host.isFlipped()));
            // Au-dessus de la webview : le verre refracte les listes dessous.
            host.addSubview_positioned_relativeTo(&root, NSWindowOrderingMode::Above, None);
            STATE.with(|s| {
                s.borrow_mut().pill = Some(PillViews { root, title, sub, bar, chevron });
            });
        }

        STATE.with(|s| {
            let st = s.borrow();
            let Some(p) = st.pill.as_ref() else { return };
            let b = host.bounds();
            let x = ((b.size.width - pill.width) / 2.0).round();
            let y_top = b.size.height - pill.bottom - H;
            p.root.setFrame(to_view_rect(&host, x, y_top, pill.width, H));
            p.title.setStringValue(&NSString::from_str(&pill.title));
            p.sub.setStringValue(&NSString::from_str(&pill.sub));
            if pill.progress >= 0.0 {
                p.bar.setHidden(false);
                p.bar.setDoubleValue(pill.progress);
            } else {
                p.bar.setHidden(true);
            }
            p.chevron.setImage(
                symbol(if pill.open { "chevron.down" } else { "chevron.up" }, "").as_deref(),
            );
        });
    });
}
