// ============================================================
//  Copiteur — edition d'un fichier distant (surveillance + renvoi)
// ============================================================
//
// Inspire de `CEditHandler` de FileZilla. Principe RETENU pour la fiabilite :
//   - POLLING (pas de watcher) : on relit periodiquement mtime + taille ;
//   - regle « change puis stable » : on ne signale un changement que s'il est
//     different de la reference ET identique au tick precedent — ce qui veut dire
//     que l'editeur externe a fini d'ecrire (sinon on renverrait un fichier a
//     moitie ecrit) ;
//   - on NE renvoie JAMAIS tout seul : le front demande confirmation. On ne peut
//     pas savoir de facon sure que l'ecriture est finie, donc l'humain tranche
//     (choix de conception de FileZilla, pour l'integrite des donnees) ;
//   - apres un renvoi, on CONTINUE de surveiller (un document est sauve souvent).

use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EditState {
    Watching,  // surveille, aucune modif en attente
    Changed,   // modif detectee, en attente de decision de l'utilisateur
    Uploading, // renvoi en cours (le polling l'ignore)
}

struct Edit {
    local: PathBuf,
    label: String,
    base: Option<(u128, u64)>, // empreinte de reference (mtime nanos, taille)
    last: Option<(u128, u64)>, // vue au tick precedent (regle « stable »)
    state: EditState,
}

#[derive(Default)]
pub struct Edits(Mutex<HashMap<u64, Edit>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditInfo {
    pub id: u64,
    pub label: String,
    pub state: EditState,
}

#[derive(Serialize, Clone)]
struct ChangedEvent {
    id: u64,
    label: String,
}

// Empreinte d'un fichier local : (mtime en nanosecondes, taille).
fn signature(path: &PathBuf) -> Option<(u128, u64)> {
    let meta = std::fs::metadata(path).ok()?;
    let mtime = meta
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_nanos();
    Some((mtime, meta.len()))
}

// Verdict d'un tick de surveillance, a partir des trois empreintes.
#[derive(PartialEq, Debug)]
enum Tick {
    Idle,          // identique a la reference : rien
    StillChanging, // different de la reference mais bouge encore
    Settled,       // different de la reference ET stable depuis le tick precedent
}

fn classify(
    base: Option<(u128, u64)>,
    last: Option<(u128, u64)>,
    cur: Option<(u128, u64)>,
) -> Tick {
    if cur == base {
        Tick::Idle
    } else if cur == last {
        Tick::Settled
    } else {
        Tick::StillChanging
    }
}

// Un passage de surveillance : signale (evenement) les fichiers modifies-et-stables.
pub fn check_all(app: &AppHandle) {
    let edits = app.state::<Edits>();
    let mut signals: Vec<ChangedEvent> = Vec::new();
    {
        let mut map = edits.0.lock().unwrap_or_else(|p| p.into_inner());
        for (id, e) in map.iter_mut() {
            if e.state != EditState::Watching {
                continue;
            }
            let cur = signature(&e.local);
            match classify(e.base, e.last, cur) {
                Tick::Idle => {
                    e.last = e.base;
                }
                Tick::StillChanging => {
                    e.last = cur; // on attend le prochain tick pour confirmer
                }
                Tick::Settled => {
                    e.state = EditState::Changed;
                    signals.push(ChangedEvent {
                        id: *id,
                        label: e.label.clone(),
                    });
                }
            }
        }
    }
    // Emission hors du verrou.
    for s in signals {
        let _ = app.emit("edit-changed", s);
    }
}

// ------------------------------------------------------------------
//  Commandes exposees au front
// ------------------------------------------------------------------

#[tauri::command]
pub fn edit_register(
    edits: State<Edits>,
    id: u64,
    local: String,
    label: String,
) {
    let path = PathBuf::from(local.replace('/', std::path::MAIN_SEPARATOR_STR));
    let sig = signature(&path);
    let mut map = edits.0.lock().unwrap_or_else(|p| p.into_inner());
    map.insert(
        id,
        Edit {
            local: path,
            label,
            base: sig,
            last: sig,
            state: EditState::Watching,
        },
    );
}

// Nouvelle reference sur l'etat courant du fichier + retour a la surveillance.
// Sert apres un renvoi reussi ET apres « Ignorer ».
#[tauri::command]
pub fn edit_reset(edits: State<Edits>, id: u64) {
    let mut map = edits.0.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(e) = map.get_mut(&id) {
        let sig = signature(&e.local);
        e.base = sig;
        e.last = sig;
        e.state = EditState::Watching;
    }
}

// true = renvoi en cours (le polling l'ignore) ; false = renvoi fini/echoue, on
// repasse en « modifie » (l'utilisateur pourra reessayer sans re-prompt).
#[tauri::command]
pub fn edit_set_uploading(edits: State<Edits>, id: u64, uploading: bool) {
    let mut map = edits.0.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(e) = map.get_mut(&id) {
        e.state = if uploading {
            EditState::Uploading
        } else {
            EditState::Changed
        };
    }
}

#[tauri::command]
pub fn edit_stop(edits: State<Edits>, id: u64) {
    let mut map = edits.0.lock().unwrap_or_else(|p| p.into_inner());
    map.remove(&id);
}

#[tauri::command]
pub fn edit_list(edits: State<Edits>) -> Vec<EditInfo> {
    let map = edits.0.lock().unwrap_or_else(|p| p.into_inner());
    map.iter()
        .map(|(id, e)| EditInfo {
            id: *id,
            label: e.label.clone(),
            state: e.state,
        })
        .collect()
}

// Passage immediat (au retour de focus sur la fenetre).
#[tauri::command]
pub fn edit_poll_now(app: AppHandle) {
    check_all(&app);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idle_quand_identique_a_la_reference() {
        let base = Some((100, 10));
        assert_eq!(classify(base, base, base), Tick::Idle);
    }

    #[test]
    fn premiere_modif_encore_en_cours_ne_signale_pas() {
        let base = Some((100, 10));
        // change (cur != base) mais last valait encore la reference => bouge encore.
        assert_eq!(classify(base, base, Some((200, 12))), Tick::StillChanging);
    }

    #[test]
    fn modif_stable_est_signalee() {
        let base = Some((100, 10));
        let cur = Some((200, 12));
        // au tick suivant, cur identique au precedent (last == cur) => stable.
        assert_eq!(classify(base, cur, cur), Tick::Settled);
    }

    #[test]
    fn taille_seule_qui_change_compte_comme_modif() {
        let base = Some((100, 10));
        let cur = Some((100, 11)); // meme mtime, taille differente
        assert_eq!(classify(base, cur, cur), Tick::Settled);
    }
}
