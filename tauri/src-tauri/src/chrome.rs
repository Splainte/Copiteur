// ============================================================
//  Copiteur — barre d'outils NATIVE macOS (pont avec le front).
//
//  Le front (src/macChrome.tsx) decrit la barre du haut ; chrome_mac.rs la
//  construit en vraie NSToolbar. Ailleurs (Windows, Linux) ces commandes ne
//  font rien : la barre de titre y est dessinee en HTML.
// ============================================================

use serde::Deserialize;
use tauri::AppHandle;

// ---- Description de la barre (miroir de src/macChrome.tsx) ------------------

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub struct ToolbarSpec {
    pub items: Vec<TbItem>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub enum TbItem {
    /// « Copiteur » + version, a droite des feux tricolores.
    Title { id: String, text: String, sub: String },
    Flex,
    Space,
    /// Bouton rond a symbole SF (journal, parametres).
    Button { id: String, symbol: String, label: String },
    /// Menu deroulant natif (serveurs).
    Menu {
        id: String,
        symbol: String,
        title: String,
        tip: String,
        entries: Vec<MenuEntry>,
    },
    /// Bouton rond qui s'etire en pilule de progression (vers la gauche).
    Morph {
        id: String,
        symbol: String,
        label: String,
        text: String,
        value: f64,
        expanded: bool,
        retry: bool,
    },
}

impl TbItem {
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub fn id(&self) -> Option<&str> {
        match self {
            TbItem::Title { id, .. }
            | TbItem::Button { id, .. }
            | TbItem::Menu { id, .. }
            | TbItem::Morph { id, .. } => Some(id),
            TbItem::Flex | TbItem::Space => None,
        }
    }
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
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

// ---- Commandes ----------------------------------------------------------

/// Pose la barre d'outils native. Rend la hauteur que la page doit reserver en
/// haut (0 hors macOS).
#[tauri::command]
pub async fn chrome_apply(app: AppHandle, toolbar: ToolbarSpec) -> f64 {
    #[cfg(target_os = "macos")]
    return crate::chrome_mac::apply(&app, toolbar);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, toolbar);
        0.0
    }
}

/// Met a jour UN element de la barre (titre du serveur, menu, bouton-pilule…).
#[tauri::command]
pub async fn chrome_toolbar_item(app: AppHandle, item: TbItem) {
    #[cfg(target_os = "macos")]
    crate::chrome_mac::update_item(&app, item);
    #[cfg(not(target_os = "macos"))]
    let _ = (app, item);
}
