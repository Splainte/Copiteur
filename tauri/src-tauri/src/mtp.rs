// ============================================================
//  Copiteur — telephones Android branches en USB (macOS)
//
//  Le dialogue avec le telephone (protocole MTP, par libusb) est confie a un
//  programme separe, `copiteur-mtp` (sources dans tauri/mtp/), lance et arrete
//  par l'app comme rclone. Il presente chaque telephone comme un petit serveur
//  WebDAV LOCAL (127.0.0.1 uniquement, protege par un jeton tire au hasard) :
//  pour rclone, un telephone devient donc un remote comme un autre (« tel1: »)
//  et toute la mecanique de copie existante s'applique — telephone <-> Mac,
//  telephone <-> serveur, progression, annulation, reprises.
//
//  Ici :
//    - lancement / relance du programme, lecture de son port ;
//    - `phones_list` : etat des telephones + pose de leur remote rclone ;
//    - `phone_retry` : rouvrir un telephone (apres l'avoir deverrouille, ou
//      ferme le programme qui le gardait).
//
//  Windows n'embarque pas ce programme (l'Explorateur gere deja les
//  telephones) : tout y repond « pas de telephone ».
// ============================================================

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Manager, State};

use crate::rclone::{self, Rclone};

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// Un telephone tel que le decrit `copiteur-mtp` (GET /api/devices).
#[derive(Deserialize, Clone, Debug)]
struct Device {
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    manufacturer: String,
    #[serde(default)]
    state: String,
    #[serde(default)]
    error: String,
    #[serde(default)]
    storages: Vec<Storage>,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct Storage {
    #[serde(default)]
    name: String,
    #[serde(default)]
    total: u64,
    #[serde(default)]
    free: u64,
}

/// Ce que recoit le front (cf. `Phone` dans files.ts).
#[derive(Serialize, Clone, Debug)]
pub struct Phone {
    id: String,
    name: String,
    manufacturer: String,
    state: String,
    error: String,
    storages: Vec<Storage>,
    /// Remote rclone pret a l'emploi (« tel1: »), vide tant que le telephone
    /// n'est pas pret.
    remote: String,
}

/// Process enfant + de quoi le garder en vie.
struct Proc {
    child: Child,
    /// Entree standard du programme, gardee OUVERTE : il s'arrete de lui-meme
    /// quand elle se ferme — donc aussi si l'app meurt brutalement (pas de
    /// process orphelin qui garderait le telephone).
    _stdin: ChildStdin,
}

pub struct Mtp {
    proc: Mutex<Option<Proc>>,
    /// Base de l'API (« http://127.0.0.1:port »), connue quand le programme a
    /// annonce son port (lu sur un fil a part : le lancement ne bloque rien).
    base: Arc<Mutex<String>>,
    /// Jeton d'acces, tire au hasard pour toute la session.
    token: String,
    bin: Mutex<Option<PathBuf>>,
    /// Developpement uniquement : simuler un telephone sur un dossier.
    fake: Mutex<Option<String>>,
    /// Numero de remote attribue a chaque telephone (id USB -> N de « telN ») :
    /// stable pendant la session, donc un telephone debranche puis rebranche
    /// garde son remote, et les copies en reprise le retrouvent.
    ids: Mutex<HashMap<String, u32>>,
    /// Remotes deja poses dans rclone : remote -> (url, vie du daemon rclone).
    configured: Mutex<HashMap<String, (String, u64)>>,
    /// Dernier lancement et nombre d'echecs d'affilee : les relances s'espacent
    /// (5 s, 10 s, 20 s… jusqu'a 5 min) pour un programme qui meurt aussitot.
    last_spawn: Mutex<Option<Instant>>,
    failures: Mutex<u32>,
    stopping: AtomicBool,
    http: reqwest::Client,
}

impl Default for Mtp {
    fn default() -> Self {
        // Simulation reservee aux builds de developpement : une version livree
        // ignore cette variable.
        let fake = if cfg!(debug_assertions) {
            std::env::var("COPITEUR_MTP_FAKE").ok().filter(|v| !v.is_empty())
        } else {
            None
        };
        Mtp {
            proc: Mutex::new(None),
            base: Arc::new(Mutex::new(String::new())),
            token: random_token(),
            bin: Mutex::new(None),
            fake: Mutex::new(fake),
            ids: Mutex::new(HashMap::new()),
            configured: Mutex::new(HashMap::new()),
            last_spawn: Mutex::new(None),
            failures: Mutex::new(0),
            stopping: AtomicBool::new(false),
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(4))
                .build()
                .unwrap_or_default(),
        }
    }
}

impl Drop for Mtp {
    fn drop(&mut self) {
        self.kill();
    }
}

fn random_token() -> String {
    let mut buf = [0u8; 32];
    getrandom::fill(&mut buf).expect("entropie systeme indisponible");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

impl Mtp {
    /// Fermeture de l'app (ou installation d'une mise a jour) : on arrete le
    /// programme et on interdit sa relance.
    pub fn shutdown(&self) {
        self.stopping.store(true, Ordering::Relaxed);
        self.kill();
    }
    pub fn resume(&self) {
        self.stopping.store(false, Ordering::Relaxed);
    }
    fn kill(&self) {
        // L'adresse et les remotes de ce programme ne valent plus rien.
        lock(&self.base).clear();
        lock(&self.configured).clear();
        // Pris hors du verrou : l'attente ci-dessous ne bloque personne.
        let taken = lock(&self.proc).take();
        if let Some(mut p) = taken {
            // Fermer son entree standard suffit a l'arreter proprement (sessions
            // MTP refermees) ; on le tue s'il traine.
            drop(p._stdin);
            for _ in 0..300 {
                match p.child.try_wait() {
                    Ok(None) => std::thread::sleep(Duration::from_millis(10)),
                    _ => return,
                }
            }
            let _ = p.child.kill();
            let _ = p.child.wait();
        }
    }

    /// Le moteur est-il disponible sur cette machine ?
    fn supported(&self) -> bool {
        lock(&self.fake).is_some() || (cfg!(target_os = "macos") && lock(&self.bin).as_ref().is_some_and(|b| b.exists()))
    }

    /// Lance le programme s'il ne tourne pas (ou plus). Les relances sont
    /// espacees : un programme qui meurt aussitot ne doit pas etre relance en
    /// boucle toutes les 2 s.
    fn ensure_running(&self) {
        if self.stopping.load(Ordering::Relaxed) {
            return;
        }
        let mut guard = lock(&self.proc);
        if let Some(p) = guard.as_mut() {
            if matches!(p.child.try_wait(), Ok(None)) {
                return;
            }
            // Mort : on oublie son port et les remotes qui pointaient dessus.
            // Mort sans avoir jamais annonce son port = echec de lancement.
            if lock(&self.base).is_empty() {
                *lock(&self.failures) += 1;
            } else {
                *lock(&self.failures) = 0;
            }
            *guard = None;
            lock(&self.base).clear();
            lock(&self.configured).clear();
        }
        {
            let mut last = lock(&self.last_spawn);
            let fails = (*lock(&self.failures)).min(6);
            let wait = Duration::from_secs((5u64 << fails).min(300));
            if last.is_some_and(|t| t.elapsed() < wait) {
                return;
            }
            *last = Some(Instant::now());
        }
        let Some(bin) = lock(&self.bin).clone() else { return };
        let mut cmd = Command::new(&bin);
        cmd.arg("--port").arg("0");
        if let Some(dir) = lock(&self.fake).as_ref() {
            cmd.arg("--fake").arg(dir);
        }
        // Le jeton passe par l'ENVIRONNEMENT, jamais en argument (lisible par
        // tous via `ps`).
        cmd.env("COPITEUR_MTP_TOKEN", &self.token)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // Journal du programme sur la sortie d'erreur de l'app (comme
            // rclone) : indispensable pour diagnostiquer un souci USB.
            .stderr(Stdio::inherit());
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                eprintln!("Copiteur: copiteur-mtp ({}) : {e}", bin.display());
                return;
            }
        };
        let (Some(stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
            let _ = child.kill();
            return;
        };
        // Premiere ligne = {"port":N}. Lue sur un fil a part, puis le reste de
        // la sortie est draine (le programme n'est pas cense en produire).
        let base = self.base.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();
            // La ligne du port parmi les toutes premieres (tolere un eventuel
            // message parasite avant elle).
            for _ in 0..20 {
                line.clear();
                if !reader.read_line(&mut line).is_ok_and(|n| n > 0) {
                    break;
                }
                let port = serde_json::from_str::<serde_json::Value>(line.trim())
                    .ok()
                    .and_then(|v| v.get("port").and_then(|p| p.as_u64()))
                    .filter(|p| *p > 0 && *p < 65536);
                if let Some(port) = port {
                    *lock(&base) = format!("http://127.0.0.1:{port}");
                    break;
                }
            }
            let mut sink = String::new();
            while reader.read_line(&mut sink).is_ok_and(|n| n > 0) {
                sink.clear();
            }
        });
        *guard = Some(Proc { child, _stdin: stdin });
    }

    fn remote_for(&self, id: &str) -> String {
        let mut ids = lock(&self.ids);
        let n = match ids.get(id) {
            Some(n) => *n,
            None => {
                let n = ids.len() as u32 + 1;
                ids.insert(id.to_string(), n);
                n
            }
        };
        format!("tel{n}")
    }
}

/// Localise le programme : sidecar a cote de l'app, puis (developpement) le
/// binaire prepare dans src-tauri/binaries/.
fn resolve_bin(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(p) = std::env::var("COPITEUR_MTP_BIN") {
        if cfg!(debug_assertions) && !p.is_empty() {
            return Some(PathBuf::from(p));
        }
    }
    let triple = tauri::utils::platform::target_triple().unwrap_or_default();
    let sidecar = format!("copiteur-mtp-{triple}");
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Ok(res) = app.path().resource_dir() {
        dirs.push(res);
    }
    if let Ok(cur) = std::env::current_exe() {
        if let Some(p) = cur.parent() {
            dirs.push(p.to_path_buf());
        }
    }
    for d in &dirs {
        for name in [sidecar.as_str(), "copiteur-mtp"] {
            let cand = d.join(name);
            if cand.exists() {
                return Some(cand);
            }
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries").join(&sidecar);
    dev.exists().then_some(dev)
}

/// Memorise le chemin du programme. Il n'est lance qu'au premier besoin (le
/// front demande la liste des telephones des le demarrage, sous macOS).
pub fn start(app: &AppHandle) {
    let state = app.state::<Mtp>();
    *lock(&state.bin) = resolve_bin(app);
}

/// Un id de telephone utilisable tel quel dans une URL (contrat du programme).
fn safe_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

#[tauri::command]
pub fn phones_supported(state: State<'_, Mtp>) -> bool {
    state.supported()
}

/// Liste des telephones branches. Pose au passage (ou repose, si rclone ou le
/// programme ont ete relances) le remote rclone de chaque telephone pret.
#[tauri::command]
pub async fn phones_list(
    app: AppHandle,
    state: State<'_, Mtp>,
    rc: State<'_, Rclone>,
) -> Result<Vec<Phone>, String> {
    if !state.supported() {
        return Ok(Vec::new());
    }
    state.ensure_running();
    let base = lock(&state.base).clone();
    if base.is_empty() {
        // Programme en cours de demarrage : rien a montrer pour l'instant.
        return Ok(Vec::new());
    }
    let resp = state
        .http
        .get(format!("{base}/api/devices"))
        .bearer_auth(&state.token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("copiteur-mtp : HTTP {}", resp.status()));
    }
    let devices: Vec<Device> = resp.json().await.map_err(|e| e.to_string())?;

    let mut out = Vec::with_capacity(devices.len());
    for d in devices {
        if !safe_id(&d.id) {
            continue;
        }
        let remote = state.remote_for(&d.id);
        let mut ready = String::new();
        if d.state == "ready" {
            let url = format!("{base}/dav/{}", d.id);
            let gen = rclone::generation(&rc);
            let known = lock(&state.configured).get(&remote).cloned();
            if known.is_some_and(|(u, g)| u == url && g == gen) {
                ready = format!("{remote}:");
            } else {
                let params = json!({
                    "name": remote,
                    "type": "webdav",
                    "parameters": {
                        "url": url,
                        "vendor": "other",
                        "bearer_token": state.token,
                    },
                });
                // (`config/create` vide aussi le cache rclone de CE remote : une
                // adresse qui change n'y laisse pas d'ancienne connexion.)
                if let Ok((_, g)) = rclone::call_internal(&app, &rc, "config/create", &params).await {
                    lock(&state.configured).insert(remote.clone(), (url, g));
                    ready = format!("{remote}:");
                }
            }
        }
        out.push(Phone {
            name: if d.name.trim().is_empty() { "Android".into() } else { d.name },
            id: d.id,
            manufacturer: d.manufacturer,
            state: if d.state.is_empty() { "connecting".into() } else { d.state },
            error: d.error,
            storages: d.storages,
            remote: ready,
        });
    }
    Ok(out)
}

/// Rouvre un telephone (deverrouille depuis, ou libere par l'autre programme).
#[tauri::command]
pub async fn phone_retry(state: State<'_, Mtp>, id: String) -> Result<(), String> {
    if !state.supported() || !safe_id(&id) {
        return Ok(());
    }
    let base = lock(&state.base).clone();
    if base.is_empty() {
        return Ok(());
    }
    state
        .http
        .post(format!("{base}/api/devices/{id}/retry"))
        .bearer_auth(&state.token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn un_id_de_telephone_douteux_est_ecarte() {
        assert!(safe_id("R5CT1234ABC"));
        assert!(safe_id("18d1-4ee1-1-7"));
        assert!(!safe_id(""));
        assert!(!safe_id("../api"));
        assert!(!safe_id("a/b"));
        assert!(!safe_id("a b"));
        assert!(!safe_id(&"x".repeat(200)));
    }

    /// Contrat de bout en bout avec le vrai programme (en mode simule) : port
    /// annonce, jeton exige, telephone liste, contenu lisible par rclone en
    /// WebDAV, arret propre. Saute si les binaires ne sont pas prepares
    /// (`node scripts/build-mtp.mjs --fake-only`, `npm run prepare-bins`).
    #[tokio::test]
    async fn le_moteur_simule_repond_a_rclone() {
        let triple = tauri::utils::platform::target_triple().unwrap_or_default();
        let bins = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries");
        let mtp_bin = bins.join(format!("copiteur-mtp-{triple}"));
        let rclone_bin = bins.join(format!("rclone-{triple}"));
        if !mtp_bin.exists() || !rclone_bin.exists() {
            eprintln!("binaires absents : test saute");
            return;
        }
        let dir = std::env::temp_dir().join(format!("copiteur-mtp-test-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("DCIM")).unwrap();
        std::fs::write(dir.join("DCIM").join("photo.jpg"), b"bonjour").unwrap();

        let m = Mtp::default();
        *lock(&m.fake) = Some(dir.to_string_lossy().into_owned());
        *lock(&m.bin) = Some(mtp_bin);
        assert!(m.supported());
        m.ensure_running();
        let mut base = String::new();
        for _ in 0..100 {
            base = lock(&m.base).clone();
            if !base.is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(base.starts_with("http://127.0.0.1:"), "port jamais annonce");

        // Sans jeton : refuse.
        let r = m.http.get(format!("{base}/api/devices")).send().await.unwrap();
        assert_eq!(r.status(), reqwest::StatusCode::UNAUTHORIZED);
        // Avec : le telephone simule est pret.
        let devs: Vec<Device> = m
            .http
            .get(format!("{base}/api/devices"))
            .bearer_auth(&m.token)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let d = devs.iter().find(|d| d.state == "ready").expect("telephone simule pret");
        assert!(safe_id(&d.id));

        // rclone le lit comme le fera l'app (webdav, vendor other, jeton).
        let out = std::process::Command::new(&rclone_bin)
            .args(["lsjson", "-R", "--config", "", "--webdav-vendor", "other"])
            .arg("--webdav-url")
            .arg(format!("{base}/dav/{}", d.id))
            .arg("--webdav-bearer-token")
            .arg(&m.token)
            .arg(":webdav:")
            .output()
            .unwrap();
        let txt = String::from_utf8_lossy(&out.stdout);
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        assert!(txt.contains("DCIM/photo.jpg"), "{txt}");

        m.shutdown();
        assert!(lock(&m.proc).is_none());
        assert!(lock(&m.base).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn chaque_telephone_garde_son_remote() {
        let m = Mtp::default();
        assert_eq!(m.remote_for("A"), "tel1");
        assert_eq!(m.remote_for("B"), "tel2");
        assert_eq!(m.remote_for("A"), "tel1");
        assert!(crate::rclone::is_phone_remote("tel1"));
    }
}
