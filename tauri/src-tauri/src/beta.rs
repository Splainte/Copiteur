// ============================================================
//  Copiteur — version beta (« Copiteur Beta »)
//
//  La beta est une application DISTINCTE de la version normale (identifiant
//  `com.robin.copiteur.beta`, canal de mise a jour a part) : on peut avoir les
//  deux installees. Son dossier de configuration est donc vide au premier
//  lancement — on y recopie les serveurs memorises et les cles d'hote deja
//  acceptees de la version normale, pour ne pas tout ressaisir. Les mots de
//  passe, eux, sont chiffres avec une cle du trousseau commune aux deux.
//
//  Sans effet dans la version normale (identifiant sans « .beta »).
// ============================================================

use tauri::{AppHandle, Manager};

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
    // Jamais d'ecrasement : la beta garde ce qu'elle a deja.
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
