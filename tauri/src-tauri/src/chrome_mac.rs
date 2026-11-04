// ============================================================
//  Copiteur — barre d'outils NATIVE macOS.
//
//  Le front (src/macChrome.tsx) decrit la barre, on la construit ici en vraie
//  NSToolbar : capsules Liquid Glass, symboles SF, menu natif des serveurs, et
//  le bouton Transferts — une capsule de verre a nous (NSGlassEffectView sur
//  macOS 26+, sinon materiau « barre laterale ») qui s'etire en pilule de
//  progression. Les clics remontent au front par l'evenement `chrome://toolbar`.
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
    NSAnimatablePropertyContainer, NSAnimationContext, NSClickGestureRecognizer, NSColor,
    NSControlStateValueOn, NSFont, NSFontWeightBold, NSGlassEffectView, NSImage, NSImageView,
    NSLayoutAttribute, NSLayoutConstraint, NSLineBreakMode, NSMenu, NSMenuItem, NSMenuToolbarItem,
    NSProgressIndicator, NSProgressIndicatorStyle, NSStackView, NSTextField, NSToolbar,
    NSToolbarDelegate, NSToolbarDisplayMode, NSToolbarFlexibleSpaceItemIdentifier, NSToolbarItem,
    NSToolbarItemStyle,
    NSToolbarSpaceItemIdentifier, NSUserInterfaceLayoutOrientation, NSView,
    NSVisualEffectBlendingMode, NSVisualEffectMaterial, NSVisualEffectState, NSVisualEffectView,
    NSWindow, NSWindowButton, NSWindowTitleVisibility, NSWindowToolbarStyle,
};
use objc2_foundation::{
    ns_string, MainThreadMarker, NSArray, NSObject, NSObjectProtocol, NSPoint, NSRect, NSSize,
    NSString,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::chrome::{MenuEntry, SidePill, TbItem, ToolbarSpec};

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
}

// ---------- Etat (thread principal) ----------

struct MorphViews {
    id: String,
    host: Retained<NSView>,
    // Largeur de l'hote : celle de la pilule deployee + la capsule laterale.
    host_width: Retained<NSLayoutConstraint>,
    // Capsule laterale (telephone) : verre, titre, et sa description courante.
    side: Retained<NSView>,
    side_title: Retained<NSTextField>,
    side_icon: Retained<NSImageView>,
    side_spec: Option<SidePill>,
    width: Retained<NSLayoutConstraint>,
    text: Retained<NSTextField>,
    bar: Retained<NSProgressIndicator>,
    extra: Retained<NSView>,
    expanded: bool,
    wide: f64,
}

#[derive(Default)]
struct State {
    controller: Option<Retained<Controller>>,
    spec: Option<ToolbarSpec>,
    items: HashMap<String, Retained<NSToolbarItem>>,
    titles: HashMap<String, (Retained<NSTextField>, Retained<NSTextField>)>,
    morph: Option<MorphViews>,
    seq: u32,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
}

// ---------- Hote du bouton-pilule : transparent aux clics hors de la capsule ----------

define_class!(
    // L'element de barre a la largeur MAXIMALE de la pilule (la barre ne se
    // re-agence pas pendant l'animation) ; seule la capsule, collee a droite,
    // s'etire. Le reste de l'hote laisse passer les clics (deplacement de la
    // fenetre par la barre).
    #[unsafe(super(NSView))]
    #[thread_kind = MainThreadOnly]
    #[name = "CopiteurPassThroughView"]
    struct PassThroughView;

    impl PassThroughView {
        #[unsafe(method(hitTest:))]
        fn hit_test(&self, point: NSPoint) -> *mut NSView {
            let hit: *mut NSView = unsafe { msg_send![super(self), hitTest: point] };
            if hit as *const NSView == self as *const Self as *const NSView {
                core::ptr::null_mut()
            } else {
                hit
            }
        }

        #[unsafe(method(mouseDownCanMoveWindow))]
        fn can_move(&self) -> bool {
            true
        }
    }
);

// ---------- Controleur Obj-C (delegue de la barre + cible des actions) ----------

pub struct Ivars {
    app: AppHandle,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "CopiteurChromeController"]
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

    impl Controller {
        #[unsafe(method(onButton:))]
        fn on_button(&self, sender: Option<&AnyObject>) {
            let Some(item) = sender.and_then(|s| s.downcast_ref::<NSToolbarItem>()) else {
                return;
            };
            let ident = item.itemIdentifier().to_string();
            if let Some(id) = ident.strip_prefix(PREFIX) {
                self.emit(id, "click", None);
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
                self.emit(id, "menu", Some(entry.to_string()));
            }
        }

        // Clic sur la capsule laterale : son menu natif, juste dessous.
        #[unsafe(method(onSide:))]
        fn on_side(&self, _sender: Option<&AnyObject>) {
            let st = STATE.with(|s| {
                s.borrow()
                    .morph
                    .as_ref()
                    .and_then(|m| m.side_spec.clone().map(|sp| (sp, m.side.clone())))
            });
            let Some((sp, view)) = st else { return };
            if sp.hidden || sp.entries.is_empty() {
                return;
            }
            let menu = self.build_menu(&sp.id, &sp.entries);
            // Vue non retournee : y = 0 est le BAS de la capsule.
            let _ = menu.popUpMenuPositioningItem_atLocation_inView(
                None,
                NSPoint::new(0.0, -6.0),
                Some(&view),
            );
        }

        #[unsafe(method(onMorph:))]
        fn on_morph(&self, _sender: Option<&AnyObject>) {
            let id = STATE.with(|s| s.borrow().morph.as_ref().map(|m| m.id.clone()));
            if let Some(id) = id {
                self.emit(&id, "click", None);
            }
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

    fn emit(&self, id: &str, kind: &'static str, entry: Option<String>) {
        let _ = self.ivars().app.emit(
            "chrome://toolbar",
            ToolbarEvent { id: id.to_string(), kind, entry },
        );
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
            TbItem::Title { id, text, sub } => {
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
            TbItem::Button { label: text, symbol: sym, .. } => {
                let t = NSString::from_str(text);
                item.setLabel(&t);
                item.setToolTip(Some(&t));
                item.setImage(symbol(sym, text).as_deref());
                item.setBordered(true);
                if fresh {
                    unsafe {
                        item.setTarget(Some(self.as_target()));
                        item.setAction(Some(sel!(onButton:)));
                    }
                }
                if responds(item, sel!(setStyle:)) {
                    item.setStyle(NSToolbarItemStyle::Plain);
                }
            }
            TbItem::Menu { id, symbol: sym, title, tip, entries, hidden } => {
                // Apparait / disparait selon l'etat (telephone branche ou non).
                // `hidden` n'existe qu'a partir de macOS 15.
                if responds(item, sel!(setHidden:)) {
                    item.setHidden(*hidden);
                }
                let Some(m) = item.downcast_ref::<NSMenuToolbarItem>() else { return };
                let t = NSString::from_str(title);
                m.setTitle(&t);
                m.setLabel(&t);
                m.setToolTip(Some(&NSString::from_str(tip)));
                m.setImage(symbol(sym, title).as_deref());
                m.setShowsIndicator(true);
                m.setMenu(&self.build_menu(id, entries));
            }
            TbItem::Morph { id, symbol: sym, label: lbl, text, value, expanded, retry, side } => {
                const H: f64 = 36.0;
                const MAX: f64 = 400.0;
                if fresh {
                    // Hote large et transparent, capsule de verre collee a droite.
                    let host: Retained<PassThroughView> = unsafe { msg_send![PassThroughView::alloc(mtm), init] };
                    let host: Retained<NSView> = Retained::into_super(host);
                    host.setTranslatesAutoresizingMaskIntoConstraints(false);
                    let glass = glass_view(NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(H, H)), H / 2.0, mtm);
                    glass.setTranslatesAutoresizingMaskIntoConstraints(false);
                    // macOS 27 : petit rebond du verre au clic.
                    if responds(&glass, sel!(setEffectIsInteractive:)) {
                        let _: () = unsafe { msg_send![&*glass, setEffectIsInteractive: true] };
                    }
                    // Contenu rogne a la capsule : icone a gauche, puis texte + jauge.
                    let clip = NSView::new(mtm);
                    clip.setWantsLayer(true);
                    clip.setTranslatesAutoresizingMaskIntoConstraints(false);
                    unsafe {
                        let layer: *mut AnyObject = msg_send![&*clip, layer];
                        if !layer.is_null() {
                            let _: () = msg_send![layer, setMasksToBounds: true];
                            let _: () = msg_send![layer, setCornerRadius: H / 2.0];
                        }
                    }
                    match has_glass().then(|| glass.downcast_ref::<NSGlassEffectView>()).flatten() {
                        Some(g) => g.setContentView(Some(&clip)),
                        None => glass.addSubview(&clip),
                    }
                    let icon = match symbol(sym, lbl) {
                        Some(img) => NSImageView::imageViewWithImage(&img, mtm),
                        None => NSImageView::new(mtm),
                    };
                    icon.setContentTintColor(Some(&NSColor::labelColor()));
                    icon.setTranslatesAutoresizingMaskIntoConstraints(false);
                    let text_label = label("", mtm);
                    text_label.setFont(Some(&NSFont::monospacedDigitSystemFontOfSize_weight(12.0, unsafe {
                        objc2_app_kit::NSFontWeightMedium
                    })));
                    text_label.setLineBreakMode(NSLineBreakMode::ByClipping);
                    let bar = NSProgressIndicator::new(mtm);
                    bar.setStyle(NSProgressIndicatorStyle::Bar);
                    bar.setIndeterminate(false);
                    bar.setMinValue(0.0);
                    bar.setMaxValue(100.0);
                    bar.setControlSize(objc2_app_kit::NSControlSize::Small);
                    bar.widthAnchor().constraintEqualToConstant(64.0).setActive(true);
                    let extra = hstack(&[&text_label, &bar], mtm);
                    extra.setSpacing(10.0);
                    extra.setTranslatesAutoresizingMaskIntoConstraints(false);
                    extra.setAlphaValue(0.0);
                    clip.addSubview(&icon);
                    clip.addSubview(&extra);
                    host.addSubview(&glass);
                    let width = glass.widthAnchor().constraintEqualToConstant(H);
                    // Capsule laterale (telephone branche), collee a GAUCHE de la
                    // pilule : son bord droit suit le bord gauche de la pilule,
                    // elle glisse donc avec elle pendant l'etirement anime.
                    let side_glass =
                        glass_view(NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(H, H)), H / 2.0, mtm);
                    side_glass.setTranslatesAutoresizingMaskIntoConstraints(false);
                    if responds(&side_glass, sel!(setEffectIsInteractive:)) {
                        let _: () = unsafe { msg_send![&*side_glass, setEffectIsInteractive: true] };
                    }
                    let side_content = NSView::new(mtm);
                    side_content.setTranslatesAutoresizingMaskIntoConstraints(false);
                    match has_glass().then(|| side_glass.downcast_ref::<NSGlassEffectView>()).flatten() {
                        Some(g) => g.setContentView(Some(&side_content)),
                        None => side_glass.addSubview(&side_content),
                    }
                    let side_icon = NSImageView::new(mtm);
                    side_icon.setContentTintColor(Some(&NSColor::labelColor()));
                    let side_title = label("", mtm);
                    side_title.setFont(Some(&NSFont::systemFontOfSize_weight(13.0, unsafe {
                        objc2_app_kit::NSFontWeightMedium
                    })));
                    side_title.setLineBreakMode(NSLineBreakMode::ByTruncatingTail);
                    side_title.widthAnchor().constraintLessThanOrEqualToConstant(200.0).setActive(true);
                    let chevron = match symbol("chevron.down", "") {
                        Some(img) => NSImageView::imageViewWithImage(&img, mtm),
                        None => NSImageView::new(mtm),
                    };
                    chevron.setContentTintColor(Some(&NSColor::secondaryLabelColor()));
                    chevron.setSymbolConfiguration(Some(
                        &objc2_app_kit::NSImageSymbolConfiguration::configurationWithPointSize_weight(
                            10.0,
                            unsafe { objc2_app_kit::NSFontWeightSemibold },
                        ),
                    ));
                    let side_stack = hstack(&[&side_icon, &side_title, &chevron], mtm);
                    side_stack.setSpacing(6.0);
                    side_stack.setTranslatesAutoresizingMaskIntoConstraints(false);
                    side_content.addSubview(&side_stack);
                    side_glass.setHidden(true);
                    host.addSubview(&side_glass);
                    let host_width = host.widthAnchor().constraintEqualToConstant(MAX);
                    let c = [
                        host_width.clone(),
                        host.heightAnchor().constraintEqualToConstant(H),
                        glass.trailingAnchor().constraintEqualToAnchor(&host.trailingAnchor()),
                        glass.centerYAnchor().constraintEqualToAnchor(&host.centerYAnchor()),
                        glass.heightAnchor().constraintEqualToConstant(H),
                        width.clone(),
                        clip.leadingAnchor().constraintEqualToAnchor(&glass.leadingAnchor()),
                        clip.trailingAnchor().constraintEqualToAnchor(&glass.trailingAnchor()),
                        clip.topAnchor().constraintEqualToAnchor(&glass.topAnchor()),
                        clip.bottomAnchor().constraintEqualToAnchor(&glass.bottomAnchor()),
                        icon.centerXAnchor().constraintEqualToAnchor_constant(&clip.leadingAnchor(), H / 2.0),
                        icon.centerYAnchor().constraintEqualToAnchor(&clip.centerYAnchor()),
                        extra.leadingAnchor().constraintEqualToAnchor_constant(&clip.leadingAnchor(), H - 2.0),
                        extra.centerYAnchor().constraintEqualToAnchor(&clip.centerYAnchor()),
                        side_glass.trailingAnchor().constraintEqualToAnchor_constant(&glass.leadingAnchor(), -8.0),
                        side_glass.centerYAnchor().constraintEqualToAnchor(&host.centerYAnchor()),
                        side_glass.heightAnchor().constraintEqualToConstant(H),
                        side_content.leadingAnchor().constraintEqualToAnchor(&side_glass.leadingAnchor()),
                        side_content.trailingAnchor().constraintEqualToAnchor(&side_glass.trailingAnchor()),
                        side_content.topAnchor().constraintEqualToAnchor(&side_glass.topAnchor()),
                        side_content.bottomAnchor().constraintEqualToAnchor(&side_glass.bottomAnchor()),
                        side_stack.leadingAnchor().constraintEqualToAnchor_constant(&side_content.leadingAnchor(), 14.0),
                        side_content.trailingAnchor().constraintEqualToAnchor_constant(&side_stack.trailingAnchor(), 12.0),
                        side_stack.centerYAnchor().constraintEqualToAnchor(&side_content.centerYAnchor()),
                    ];
                    NSLayoutConstraint::activateConstraints(&NSArray::from_retained_slice(&c));
                    let click = unsafe {
                        NSClickGestureRecognizer::initWithTarget_action(
                            NSClickGestureRecognizer::alloc(mtm),
                            Some(self.as_target()),
                            Some(sel!(onMorph:)),
                        )
                    };
                    glass.addGestureRecognizer(&click);
                    let side_click = unsafe {
                        NSClickGestureRecognizer::initWithTarget_action(
                            NSClickGestureRecognizer::alloc(mtm),
                            Some(self.as_target()),
                            Some(sel!(onSide:)),
                        )
                    };
                    side_glass.addGestureRecognizer(&side_click);
                    item.setView(Some(&host));
                    item.setBordered(false);
                    STATE.with(|s| {
                        s.borrow_mut().morph = Some(MorphViews {
                            id: id.clone(),
                            host,
                            host_width,
                            side: side_glass,
                            side_title,
                            side_icon,
                            side_spec: None,
                            width,
                            text: text_label,
                            bar,
                            extra: Retained::into_super(extra),
                            expanded: false,
                            wide: H,
                        })
                    });
                }
                item.setLabel(&NSString::from_str(lbl));
                item.setToolTip(Some(&NSString::from_str(lbl)));
                // Capsule laterale : contenu, visibilite, et largeur de l'hote
                // (l'hote garde la place de la pilule deployee + la capsule ; on
                // ne l'agrandit qu'a l'apparition / au changement de titre).
                let side_views = STATE.with(|s| {
                    let mut b = s.borrow_mut();
                    b.morph.as_mut().map(|m| {
                        m.side_spec = side.clone();
                        (m.side.clone(), m.side_title.clone(), m.side_icon.clone(), m.host_width.clone())
                    })
                });
                if let Some((side_view, side_title, side_icon, host_width)) = side_views {
                    let show = side.as_ref().is_some_and(|sp| !sp.hidden);
                    if let Some(sp) = side.as_ref().filter(|_| show) {
                        side_title.setStringValue(&NSString::from_str(&sp.title));
                        side_icon.setImage(symbol(&sp.symbol, &sp.title).as_deref());
                        side_view.setToolTip(Some(&NSString::from_str(&sp.tip)));
                    }
                    side_view.setHidden(!show);
                    let extra_w = if show { (side_view.fittingSize().width + 8.0).ceil() } else { 0.0 };
                    if (host_width.constant() - (MAX + extra_w)).abs() > 0.5 {
                        host_width.setConstant(MAX + extra_w);
                    }
                }
                // Mise a jour : texte, jauge, et etirement / retractation animes.
                let st = STATE.with(|s| {
                    let mut b = s.borrow_mut();
                    b.morph.as_mut().map(|m| {
                        let was = m.expanded;
                        m.expanded = *expanded;
                        (m.host.clone(), m.width.clone(), m.text.clone(), m.bar.clone(), m.extra.clone(), was, m.wide)
                    })
                });
                let Some((host, width, text_label, bar, extra, was, wide)) = st else { return };
                if *expanded {
                    text_label.setStringValue(&NSString::from_str(text));
                    let color = if *retry { NSColor::systemOrangeColor() } else { NSColor::labelColor() };
                    text_label.setTextColor(Some(&color));
                    bar.setDoubleValue(value.max(0.0));
                }
                // Largeur cible : le contenu + marges (ne retrecit pas pendant un
                // meme deploiement, sinon la pilule « respire » a chaque seconde).
                let need = (H - 2.0 + extra.fittingSize().width + 16.0).min(MAX).ceil();
                let target = if *expanded { if was { need.max(wide) } else { need } } else { H };
                STATE.with(|s| {
                    if let Some(m) = s.borrow_mut().morph.as_mut() {
                        m.wide = if *expanded { target } else { H };
                    }
                });
                if was != *expanded || (*expanded && (target - width.constant()).abs() > 0.5) {
                    let dur = if was != *expanded { 0.38 } else { 0.2 };
                    NSAnimationContext::beginGrouping();
                    let ctx = NSAnimationContext::currentContext();
                    ctx.setDuration(dur);
                    ctx.setAllowsImplicitAnimation(true);
                    width.animator().setConstant(target);
                    host.layoutSubtreeIfNeeded();
                    if was != *expanded {
                        extra.animator().setAlphaValue(if *expanded { 1.0 } else { 0.0 });
                    }
                    NSAnimationContext::endGrouping();
                }
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

fn ns_window(window: &tauri::WebviewWindow) -> Option<Retained<NSWindow>> {
    let ptr = window.ns_window().ok()?;
    unsafe { Retained::retain(ptr as *mut NSWindow) }
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

// ---------- Fonctions appelees par les commandes (chrome.rs) ----------

pub fn apply(app: &AppHandle, spec: ToolbarSpec) -> f64 {
    on_main(app, move |mtm, app| {
        let Some(webview_window) = app.get_webview_window("main") else {
            return 0.0;
        };
        let Some(window) = ns_window(&webview_window) else {
            return 0.0;
        };
        let ctrl = controller(app, mtm);

        // Le materiau pose au demarrage (cf. lib.rs) ne sert qu'a ne pas montrer
        // une fenetre vide le temps que la page charge : desormais la page peint
        // elle-meme son fond (cf. chrome.css).
        let _ = window_vibrancy::clear_vibrancy(&webview_window);

        // Description memorisee AVANT d'installer la barre (le delegue la lit
        // pendant setToolbar), emprunt relache avant l'appel.
        let seq = STATE.with(|s| {
            let mut st = s.borrow_mut();
            st.items.clear();
            st.titles.clear();
            st.morph = None;
            st.spec = Some(spec);
            st.seq += 1;
            st.seq
        });
        // Identifiant neuf a chaque pose (rechargement de la page) : des barres
        // de meme identifiant partagent leur configuration.
        let ident = NSString::from_str(&format!("copiteur.toolbar.{seq}"));
        let toolbar = NSToolbar::initWithIdentifier(NSToolbar::alloc(mtm), &ident);
        toolbar.setDelegate(Some(ProtocolObject::from_ref(&*ctrl)));
        toolbar.setAllowsUserCustomization(false);
        toolbar.setDisplayMode(NSToolbarDisplayMode::IconOnly);
        window.setToolbar(Some(&toolbar));
        window.setToolbarStyle(NSWindowToolbarStyle::Unified);
        window.setTitleVisibility(NSWindowTitleVisibility::Hidden);

        // La hauteur declaree de la barre ne tombe pas sur l'axe visuel des
        // boutons : on prend le centre du feu rouge (aligne par macOS sur l'axe
        // des boutons de la barre) et on rend le double, pour que les boutons
        // soient pile au milieu entre le haut de la fenetre et les panneaux.
        window.layoutIfNeeded();
        let h = window.frame().size.height - window.contentLayoutRect().size.height;
        let center = window.standardWindowButton(NSWindowButton::CloseButton).and_then(|b| {
            let r = b.convertRect_toView(b.bounds(), None);
            let top = window.frame().size.height - (r.origin.y + r.size.height / 2.0);
            (r.size.height > 0.0).then_some(top)
        });
        match center {
            Some(c) if c > 10.0 && c < 60.0 => (c * 2.0).round(),
            _ => h.max(0.0),
        }
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
