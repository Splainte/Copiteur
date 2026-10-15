// ============================================================
//  Copiteur — journal (log tournant pour diagnostic a distance)
// ============================================================
//
// Le besoin n'est pas « avoir des logs » mais POUVOIR REPONDRE quand quelqu'un
// ecrit « ca marche pas » : une trace horodatee des transferts, operations et
// connexions, plus un « rapport » copiable a coller dans un message.
//
// Regle absolue : JAMAIS de secret dans le fichier. Les messages sont construits
// cote app et n'incluent volontairement aucun mot de passe ; `redact` est une
// deuxieme barriere (defense en profondeur) qui masque ce qui ressemblerait a un
// secret si jamais il s'en glissait un.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

// Un fichier plafonne a ~1 Mo ; a la bascule, l'actuel devient `journal.1.log`
// et un neuf repart. On garde donc au plus ~2 Mo d'historique.
const MAX_BYTES: u64 = 1_000_000;

// Serialise les acces au journal : plusieurs evenements peuvent tomber en meme
// temps (plusieurs transferts), on ne veut pas d'ecritures entrelacees — ni
// d'une relecture qui tomberait au milieu d'une bascule de fichier.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Serialize, Deserialize, Clone)]
pub struct Entry {
    pub time: String,     // horodatage lisible, fabrique cote front (locale)
    pub level: String,    // "info" | "warn" | "error"
    pub category: String, // "transfert" | "operation" | "connexion" | "app"
    pub message: String,
}

fn dir(app: &AppHandle) -> PathBuf {
    let d = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| std::env::temp_dir());
    let _ = fs::create_dir_all(&d);
    d
}

fn current(app: &AppHandle) -> PathBuf {
    dir(app).join("journal.log")
}

fn rotated(app: &AppHandle) -> PathBuf {
    dir(app).join("journal.1.log")
}

// Masque les motifs qui ressemblent a un secret. Volontairement conservateur :
// une longue suite hexadecimale (le secret de l'API RC fait 32 hex) ou une paire
// clef=valeur sur un nom sensible. Les vrais messages n'en contiennent pas ; ceci
// n'est qu'un filet.
fn redact(s: &str) -> String {
    // 1) longues suites hexadecimales (>= 24 caracteres) -> «secret».
    // On itere sur des `char` (jamais des octets) : sinon un caractere multi-octet
    // comme « é » serait coupe en deux et le texte corrompu.
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i].is_ascii_hexdigit() {
            let start = i;
            while i < chars.len() && chars[i].is_ascii_hexdigit() {
                i += 1;
            }
            if i - start >= 24 {
                out.push_str("«secret»");
            } else {
                out.extend(&chars[start..i]);
            }
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    // 2) pass=... / password:... jusqu'au prochain espace.
    redact_kv(&out)
}

const MASK: &str = "«secret»";

fn redact_kv(s: &str) -> String {
    let mut result = s.to_string();
    for key in ["password=", "password:", "pass=", "pass:"] {
        loop {
            let lower = result.to_lowercase();
            let Some(rel) = lower.find(key) else { break };
            let at = rel + key.len();
            let end = result[at..]
                .find(char::is_whitespace)
                .map(|e| at + e)
                .unwrap_or(result.len());
            // Deja masque (ou valeur vide) : on s'arrete pour ne pas boucler.
            if end <= at || &result[at..end] == MASK {
                break;
            }
            result.replace_range(at..end, MASK);
        }
    }
    result
}

fn sanitize_line(e: &Entry) -> String {
    // Une entree = une ligne. On neutralise tabulations/retours dans les champs
    // pour que la relecture (split sur \t) reste fiable.
    let clean = |s: &str| redact(s).replace(['\t', '\n', '\r'], " ");
    format!(
        "{}\t{}\t{}\t{}",
        clean(&e.time),
        clean(&e.level),
        clean(&e.category),
        clean(&e.message)
    )
}

// Coeur testable : ne depend que des deux chemins (courant + precedent) et du
// plafond, pas d'un AppHandle.
fn append_to(cur: &std::path::Path, prev: &std::path::Path, cap: u64, e: &Entry) {
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|p| p.into_inner());

    // Bascule si le fichier courant depasse le plafond. La bascule PEUT echouer
    // (sous Windows : antivirus en train de scanner `journal.1.log`, fichier
    // ouvert dans un editeur qui pose un verrou exclusif). Si on ignorait
    // l'echec, on continuerait a ecrire a la suite dans le courant et le plafond
    // ne voudrait plus rien dire : le journal grossirait sans limite. On retente
    // donc apres avoir supprime le precedent, puis, en dernier recours, on
    // TRONQUE le courant : le plafond doit tenir, meme au prix de l'historique.
    if let Ok(meta) = fs::metadata(cur) {
        if meta.len() >= cap && fs::rename(cur, prev).is_err() {
            let _ = fs::remove_file(prev);
            if fs::rename(cur, prev).is_err() {
                let _ = fs::File::create(cur);
            }
        }
    }

    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(cur) {
        let _ = writeln!(f, "{}", sanitize_line(e));
    }
}

fn read_from(cur: &std::path::Path, prev: &std::path::Path, max: usize) -> Vec<Entry> {
    // Meme verrou que l'ecriture et le vidage : relire PENDANT une bascule
    // pourrait rendre des entrees dupliquees (lues dans le precedent puis dans le
    // courant) ou tronquees au debut.
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|p| p.into_inner());

    let mut text = String::new();
    if let Ok(p) = fs::read_to_string(prev) {
        text.push_str(&p);
    }
    if let Ok(c) = fs::read_to_string(cur) {
        text.push_str(&c);
    }
    let mut all = parse(&text);
    if all.len() > max {
        all.drain(0..all.len() - max);
    }
    all
}

fn parse(text: &str) -> Vec<Entry> {
    text.lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| {
            let mut it = l.splitn(4, '\t');
            Entry {
                time: it.next().unwrap_or("").to_string(),
                level: it.next().unwrap_or("info").to_string(),
                category: it.next().unwrap_or("").to_string(),
                message: it.next().unwrap_or("").to_string(),
            }
        })
        .collect()
}

// ------------------------------------------------------------------
//  Commandes exposees au front
// ------------------------------------------------------------------

#[tauri::command]
pub fn journal_log(app: AppHandle, entry: Entry) {
    append_to(&current(&app), &rotated(&app), MAX_BYTES, &entry);
}

// Rend les `max` dernieres entrees (precedent + courant concatenes), plus
// anciennes en premier.
#[tauri::command]
pub fn journal_read(app: AppHandle, max: usize) -> Vec<Entry> {
    read_from(&current(&app), &rotated(&app), max)
}

// Vide le journal : supprime le fichier courant ET le precedent (la bascule).
// On prend le meme verrou d'ecriture pour ne pas effacer sous les pieds d'un
// `append` concurrent. L'absence de fichier n'est pas une erreur (deja vide).
#[tauri::command]
pub fn journal_clear(app: AppHandle) {
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let _ = fs::remove_file(current(&app));
    let _ = fs::remove_file(rotated(&app));
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    pub os: String,
    pub arch: String,
    pub app_version: String,
    pub path: String,
}

// Contexte pour l'en-tete du rapport (aucun secret : OS, archi, versions, chemin
// du journal pour que l'utilisateur le retrouve).
#[tauri::command]
pub fn journal_info(app: AppHandle) -> Info {
    Info {
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        path: current(&app).to_string_lossy().to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redact_masque_le_secret_rc() {
        // 32 hex = le format du secret de l'API RC.
        let s = "secret RCLONE_RC_PASS=0123456789abcdef0123456789abcdef fin";
        let r = redact(s);
        assert!(!r.contains("0123456789abcdef0123456789abcdef"));
        assert!(r.contains("«secret»"));
    }

    #[test]
    fn redact_masque_password_kv() {
        let r = redact("connexion host=nas password=hunter2 ok");
        assert!(!r.contains("hunter2"), "mot de passe fuite : {r}");
        assert!(r.contains("«secret»"));
    }

    #[test]
    fn redact_laisse_le_texte_normal() {
        let s = "Terminé : rapport.pdf (2,4 Go)";
        assert_eq!(redact(s), s);
    }

    #[test]
    fn rotation_bascule_et_relit_dans_l_ordre() {
        let base = std::env::temp_dir();
        let uniq = format!(
            "copiteur-journal-test-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let cur = base.join(format!("{uniq}.log"));
        let prev = base.join(format!("{uniq}.1.log"));
        let _ = fs::remove_file(&cur);
        let _ = fs::remove_file(&prev);

        let mk = |n: u32| Entry {
            time: format!("2026-07-15 14:30:0{n}"),
            level: "info".into(),
            category: "transfert".into(),
            message: format!("msg{n}"),
        };
        // cap = 1 octet : chaque nouvelle ecriture (des que le courant est non
        // vide) provoque une bascule. On garde donc au plus 2 entrees.
        append_to(&cur, &prev, 1, &mk(1));
        append_to(&cur, &prev, 1, &mk(2));
        append_to(&cur, &prev, 1, &mk(3));

        assert!(prev.exists(), "le fichier precedent doit exister apres bascule");
        let got = read_from(&cur, &prev, 500);
        let msgs: Vec<_> = got.iter().map(|e| e.message.as_str()).collect();
        // precedent (msg2) avant courant (msg3), plus ancien en premier.
        assert_eq!(msgs, vec!["msg2", "msg3"]);

        let _ = fs::remove_file(&cur);
        let _ = fs::remove_file(&prev);
    }

    /// Si la bascule est impossible (ici : un DOSSIER a la place du fichier
    /// precedent — l'equivalent portable du fichier verrouille par un antivirus
    /// sous Windows), le plafond doit quand meme tenir : le courant est tronque
    /// plutot que de grossir indefiniment.
    #[test]
    fn rotation_impossible_le_plafond_tient_quand_meme() {
        let base = std::env::temp_dir();
        let uniq = format!(
            "copiteur-journal-norot-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let cur = base.join(format!("{uniq}.log"));
        let prev = base.join(format!("{uniq}.1.log"));
        let _ = fs::remove_file(&cur);
        fs::create_dir_all(&prev).unwrap();
        // Un dossier NON VIDE ne peut etre ni ecrase par un rename, ni supprime
        // par `remove_file` : la bascule est condamnee a echouer.
        fs::write(prev.join("occupe"), b"x").unwrap();

        let mk = |n: u32| Entry {
            time: "2026-07-29 10:00:00".into(),
            level: "info".into(),
            category: "app".into(),
            message: format!("msg{n}"),
        };
        for n in 0..20 {
            append_to(&cur, &prev, 1, &mk(n));
        }

        let got = read_from(&cur, &prev, 500);
        assert_eq!(
            got.len(),
            1,
            "le courant doit avoir ete tronque a chaque ecriture, pas grossir : {:?}",
            got.iter().map(|e| e.message.clone()).collect::<Vec<_>>()
        );
        assert_eq!(got[0].message, "msg19");

        let _ = fs::remove_file(&cur);
        let _ = fs::remove_dir_all(&prev);
    }

    #[test]
    fn parse_round_trip() {
        let e = Entry {
            time: "2026-07-15 14:30:00".into(),
            level: "info".into(),
            category: "transfert".into(),
            message: "Terminé : a\tb\nc".into(),
        };
        let line = sanitize_line(&e);
        let back = parse(&line);
        assert_eq!(back.len(), 1);
        // tabs/newlines du message neutralises en espaces.
        assert_eq!(back[0].message, "Terminé : a b c");
        assert_eq!(back[0].category, "transfert");
    }
}
