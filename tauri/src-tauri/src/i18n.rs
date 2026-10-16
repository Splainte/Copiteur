// ============================================================
//  Copiteur — langue de l'interface cote Rust
// ============================================================
//
// Le front tient la langue (cf. src/i18n) et la transmet ici au demarrage puis
// a chaque changement. Cote Rust, peu de texte : menus macOS, noms des lecteurs
// et quelques messages d'erreur remontes tels quels a l'ecran.

use std::sync::atomic::{AtomicBool, Ordering};

static ENGLISH: AtomicBool = AtomicBool::new(false);

pub fn en() -> bool {
    ENGLISH.load(Ordering::Relaxed)
}

// Texte fixe dans la langue courante : `tr("Annuler", "Cancel")`. Pour un texte
// avec variables, `if i18n::en() { format!(…) } else { format!(…) }`.
pub fn tr(fr: &'static str, en_: &'static str) -> &'static str {
    if en() {
        en_
    } else {
        fr
    }
}

#[tauri::command]
pub fn set_language(app: tauri::AppHandle, lang: String) {
    let english = lang == "en";
    ENGLISH.store(english, Ordering::Relaxed);
    #[cfg(target_os = "macos")]
    {
        use tauri::Manager;
        // Menus reconstruits a chaque appel : le 1er arrive au demarrage, apres
        // un menu construit avec la langue par defaut.
        let _ = crate::build_menu(&app);
        // Langue des elements fournis par macOS (boites de dialogue Ouvrir,
        // demande d'acces « Réseau local »…) : lue au LANCEMENT, d'ou l'ecriture
        // dans les preferences de l'app pour la prochaine fois.
        let id = app.config().identifier.clone();
        std::thread::spawn(move || {
            let _ = std::process::Command::new("defaults")
                .args(["write", &id, "AppleLanguages", "-array", if english { "en" } else { "fr" }])
                .status();
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

// Langue choisie dans l'installeur Windows (« fr » / « en »), s'il y en a une.
// L'installeur NSIS de Tauri la range dans HKCU\Software\<editeur>\<produit>,
// valeur « Installer Language » (identifiant de langue Windows, en texte).
// L'editeur n'est pas renseigne dans tauri.conf.json : Tauri prend alors le
// 2e segment de l'identifiant (com.robin.copiteur -> robin).
#[tauri::command]
pub fn installer_language() -> Option<String> {
    #[cfg(windows)]
    {
        let id: u32 = installer_langid()?.trim().parse().ok()?;
        // Langue principale = 10 bits de poids faible (0x0C francais, 0x09 anglais),
        // quelle que soit la variante regionale.
        match id & 0x3ff {
            0x0c => Some("fr".into()),
            0x09 => Some("en".into()),
            _ => None,
        }
    }
    #[cfg(not(windows))]
    None
}

#[cfg(windows)]
fn installer_langid() -> Option<String> {
    #[link(name = "advapi32")]
    extern "system" {
        fn RegGetValueW(
            hkey: isize,
            subkey: *const u16,
            value: *const u16,
            flags: u32,
            ptype: *mut u32,
            pvdata: *mut u16,
            pcbdata: *mut u32,
        ) -> i32;
    }
    const HKEY_CURRENT_USER: isize = 0x8000_0001u32 as i32 as isize;
    const RRF_RT_REG_SZ: u32 = 0x0000_0002;

    let wide = |s: &str| -> Vec<u16> { s.encode_utf16().chain(std::iter::once(0)).collect() };
    let (subkey, value) = (wide("Software\\robin\\Copiteur"), wide("Installer Language"));
    let mut buf = [0u16; 32];
    let mut cb = (buf.len() * 2) as u32; // taille du tampon en OCTETS
    let r = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            subkey.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            buf.as_mut_ptr(),
            &mut cb,
        )
    };
    if r != 0 {
        return None;
    }
    let end = buf.iter().position(|&c| c == 0).unwrap_or(0);
    Some(String::from_utf16_lossy(&buf[..end]))
}
