// ============================================================
//  Copiteur — BETA DESIGN : bascule d'habillage + pont vers le decor natif.
//
//  Plusieurs habillages coexistent dans la beta pour etre compares a chaud
//  (cf. src/design.ts) : sur macOS le choix se fait dans le menu « Design
//  (bêta) » de la barre de menus (construit ici, insere par lib.rs), sur
//  Windows par le menu Debug de la barre de titre (HTML, rien a faire ici).
//
//  Le decor NATIF propre a chaque habillage (barre d'outils, verre, pastille)
//  est decrit par le front et pose par design_mac.rs ; ailleurs ces commandes
//  ne font rien.
// ============================================================

use std::sync::Mutex;

use serde::Deserialize;
use tauri::menu::CheckMenuItem;
use tauri::{AppHandle, Manager, Wry};

/// Identifiant, nom francais, nom anglais (menu macOS).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
// Seconde serie (03/11/2026) : B « Îlots » retenu, trois facons de presenter
// les transferts (cf. src/design.ts).
// Troisieme serie : B1 retenu ; on compare trois rappels de progression.
pub const DESIGNS: [(&str, &str, &str); 2] = [
    ("actuelle", "Actuelle (1.2)", "Current (1.2)"),
    ("bas", "B1 · Îlot du bas", "B1 · Bottom island"),
];

/// Rappel de la progression quand la zone des transferts est cachee (plus
/// propose dans le menu depuis la serie 5 : pastille centrale retenue).
#[allow(dead_code)]
pub const RAPPELS: [(&str, &str, &str); 3] = [
    ("bouton", "Rappel : sur le bouton", "Reminder: on the button"),
    ("fil", "Rappel : fil sous la barre", "Reminder: line under the bar"),
    ("pastille", "Rappel : pastille centrale", "Reminder: center pill"),
];
pub const RAPPEL_PREFIX: &str = "rappel:";

/// Transferts simules (pour juger le rendu sans rien copier).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const SIMUS: [(&str, &str, &str); 3] = [
    ("lot", "Lancer des transferts simulés", "Start simulated transfers"),
    ("coupure", "Simuler une coupure réseau", "Simulate a network drop"),
    ("vider", "Effacer la simulation", "Clear the simulation"),
];
pub const SIMU_PREFIX: &str = "simu:";

pub const MENU_PREFIX: &str = "design:";

/// Habillage courant (annonce par le front) + entrees cochables du menu.
#[derive(Default)]
pub struct DesignState {
    pub current: Mutex<String>,
    pub items: Mutex<Vec<(String, CheckMenuItem<Wry>)>>,
    pub rappel: Mutex<String>,
    pub rappel_items: Mutex<Vec<(String, CheckMenuItem<Wry>)>>,
}

// ---- Description du decor (miroir de src/macChrome.tsx) ---------------------

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct ChromeSpec {
    pub design: String,
    pub vibrancy: bool,
    pub toolbar: Option<ToolbarSpec>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct ToolbarSpec {
    pub id: String,
    pub items: Vec<TbItem>,
    #[serde(default)]
    pub centered: Vec<String>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[allow(dead_code)]
pub enum TbItem {
    #[serde(rename_all = "camelCase")]
    Title {
        id: String,
        text: String,
        sub: String,
        fill_to: f64,
    },
    Flex,
    Space,
    #[serde(rename_all = "camelCase")]
    Button {
        id: String,
        symbol: String,
        label: String,
        tip: String,
        prominent: bool,
        enabled: bool,
        badge: String,
        selected: bool,
    },
    #[serde(rename_all = "camelCase")]
    Menu {
        id: String,
        symbol: String,
        title: String,
        tip: String,
        entries: Vec<MenuEntry>,
    },
    #[serde(rename_all = "camelCase")]
    Field {
        id: String,
        placeholder: String,
        value: String,
        secure: bool,
        width: f64,
    },
    #[serde(rename_all = "camelCase")]
    Segment {
        id: String,
        labels: Vec<String>,
        selected: i64,
    },
    #[serde(rename_all = "camelCase")]
    Progress {
        id: String,
        text: String,
        value: f64,
        visible: bool,
    },
}

impl TbItem {
    #[allow(dead_code)]
    pub fn id(&self) -> Option<&str> {
        match self {
            TbItem::Title { id, .. }
            | TbItem::Button { id, .. }
            | TbItem::Menu { id, .. }
            | TbItem::Field { id, .. }
            | TbItem::Segment { id, .. }
            | TbItem::Progress { id, .. } => Some(id),
            TbItem::Flex | TbItem::Space => None,
        }
    }
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
#[allow(dead_code)]
pub struct MenuEntry {
    pub id: String,
    pub title: String,
    pub subtitle: String,
    pub symbol: String,
    pub checked: bool,
    pub enabled: Option<bool>,
    pub separator: bool,
    pub header: bool,
}

#[derive(Deserialize, Clone, Debug)]
#[allow(dead_code)]
pub struct Region {
    pub id: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub radius: f64,
    pub anchor: String,
}

#[derive(Deserialize, Clone, Debug)]
#[allow(dead_code)]
pub struct Pill {
    pub visible: bool,
    pub title: String,
    pub sub: String,
    pub progress: f64,
    pub open: bool,
    pub width: f64,
    pub bottom: f64,
}

// ---- Menu « Design (bêta) » (macOS) --------------------------------------

/// Coche l'habillage courant dans le menu (et oublie les autres).
fn check_menu(app: &AppHandle, design: &str) {
    let state = app.state::<DesignState>();
    if let Ok(mut cur) = state.current.lock() {
        *cur = design.to_string();
    }
    if let Ok(items) = state.items.lock() {
        for (id, item) in items.iter() {
            let _ = item.set_checked(id == design);
        }
    };
}

/// Coche le rappel de progression choisi dans le menu.
#[tauri::command]
pub fn design_rappel(app: AppHandle, rappel: String) {
    let state = app.state::<DesignState>();
    if let Ok(mut cur) = state.rappel.lock() {
        *cur = rappel.clone();
    }
    if let Ok(items) = state.rappel_items.lock() {
        for (id, item) in items.iter() {
            let _ = item.set_checked(*id == rappel);
        }
    };
}

// ---- Commandes ----------------------------------------------------------

/// Pose le decor natif d'un habillage. Rend la hauteur de la barre d'outils
/// native (0 sans barre, ou hors macOS) : la page lui reserve cette place.
#[tauri::command]
pub async fn design_apply(app: AppHandle, spec: ChromeSpec) -> f64 {
    check_menu(&app, &spec.design);
    #[cfg(target_os = "macos")]
    return crate::design_mac::apply(&app, spec);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = spec;
        0.0
    }
}

/// Met a jour UN element de la barre d'outils (titre, menu, badge, champ…).
#[tauri::command]
pub async fn design_toolbar_item(app: AppHandle, item: TbItem) {
    #[cfg(target_os = "macos")]
    crate::design_mac::update_item(&app, item);
    #[cfg(not(target_os = "macos"))]
    let _ = (app, item);
}

/// Zones de verre natif SOUS la page (volet lateral de l'habillage A).
#[tauri::command]
pub async fn design_glass(app: AppHandle, regions: Vec<Region>) {
    #[cfg(target_os = "macos")]
    crate::design_mac::set_glass(&app, regions);
    #[cfg(not(target_os = "macos"))]
    let _ = (app, regions);
}

/// Pastille de transferts en verre natif AU-DESSUS de la page (habillage B).
#[tauri::command]
pub async fn design_pill(app: AppHandle, pill: Pill) {
    #[cfg(target_os = "macos")]
    crate::design_mac::set_pill(&app, pill);
    #[cfg(not(target_os = "macos"))]
    let _ = (app, pill);
}

// ---- Beta installee a cote de la version stable --------------------------

/// Premier lancement de la beta (identifiant `….beta`) : reprend les serveurs
/// memorises et les cles d'hote de Copiteur stable, pour tester les habillages
/// sur ses vrais serveurs sans tout ressaisir. Les mots de passe restent
/// chiffres : la cle est dans le trousseau, sous le meme nom pour les deux apps.
/// Rien n'est jamais ecrit du cote de la version stable.
pub fn import_from_stable(app: &AppHandle) {
    let ident = app.config().identifier.clone();
    let Some(stable) = ident.strip_suffix(".beta") else {
        return;
    };
    let Ok(dir) = app.path().app_config_dir() else {
        return;
    };
    let Some(parent) = dir.parent() else {
        return;
    };
    let from = parent.join(stable);
    if !from.is_dir() {
        return;
    }
    let _ = std::fs::create_dir_all(&dir);
    for name in ["serveurs.json", "known_hosts"] {
        let dst = dir.join(name);
        if dst.exists() {
            continue;
        }
        let src = from.join(name);
        if src.is_file() {
            let _ = std::fs::copy(&src, &dst);
        }
    }
}
