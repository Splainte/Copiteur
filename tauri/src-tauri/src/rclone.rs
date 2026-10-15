// ============================================================
//  Copiteur — pilotage de rclone via son API RC locale (`rclone rcd`)
//
//  Au demarrage on lance rclone en mode daemon RC, lie a 127.0.0.1 sur un port
//  libre, PROTEGE PAR UN SECRET tire au hasard a chaque lancement. L'app lui
//  parle ensuite en HTTP JSON (pas de parsing de sortie texte) : listage
//  local/distant, copies multi-thread, stats temps reel, annulation.
//
//  Pourquoi une auth alors qu'on est sur la loopback : cette API peut TOUT faire
//  (lire n'importe quel fichier, copier, supprimer recursivement via
//  operations/purge, lire la config). Sans secret, n'importe quel programme
//  tournant sous la meme session pouvait la piloter tant que Copiteur etait
//  ouvert — et une page web ouverte dans le navigateur pouvait lui envoyer des
//  requetes "simples" (form-data), qui partent SANS pre-verification CORS : la
//  reponse est bloquee, mais l'effet de bord, lui, a lieu.
//
//  Reglages de transfert prouves (cf. README) a appliquer cote appels de copie :
//    --multi-thread-streams 16 --multi-thread-chunk-size 128M --sftp-concurrency 128
// ============================================================

use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::Mutex;

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

/// Identifiants de l'API RC, tires au hasard a chaque demarrage de l'app.
#[derive(Clone, Default)]
struct Auth {
    user: String,
    pass: String,
}

/// Etat partage du daemon rclone : process enfant + base URL + secret de l'API.
pub struct Rclone {
    child: Mutex<Option<Child>>,
    base: Mutex<String>,
    auth: Mutex<Auth>,
    http: reqwest::Client,
    /// Binaire rclone, memorise au premier demarrage : sans lui on ne saurait
    /// pas RELANCER le daemon s'il meurt (port pris au vol, crash, process tue
    /// de l'exterieur).
    paths: Mutex<Option<PathBuf>>,
    /// Derniere erreur de lancement, pour dire POURQUOI le moteur est absent au
    /// lieu d'un laconique « rclone n'est pas démarré » impossible a diagnostiquer.
    error: Mutex<String>,
    /// L'app se ferme : interdit toute relance, sinon un appel en vol au moment de
    /// la sortie ressusciterait un daemon qui resterait orphelin.
    stopping: std::sync::atomic::AtomicBool,
}

impl Default for Rclone {
    fn default() -> Self {
        Rclone {
            child: Mutex::new(None),
            base: Mutex::new(String::new()),
            auth: Mutex::new(Auth::default()),
            http: reqwest::Client::new(),
            paths: Mutex::new(None),
            error: Mutex::new(String::new()),
            stopping: std::sync::atomic::AtomicBool::new(false),
        }
    }
}

/// Prend un verrou en ignorant l'empoisonnement : un panic ailleurs ne doit pas
/// rendre le pilotage de rclone definitivement inutilisable.
fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// Secret de session : 32 octets d'entropie systeme, en hexa.
/// Si l'OS ne sait plus fournir d'alea, c'est que la machine est cassee : on
/// prefere refuser de demarrer plutot que d'ouvrir l'API sans protection.
fn random_secret() -> String {
    let mut buf = [0u8; 32];
    getrandom::fill(&mut buf).expect("entropie systeme indisponible");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

impl Drop for Rclone {
    fn drop(&mut self) {
        self.kill();
    }
}

impl Rclone {
    /// Fermeture de l'app : on tue le daemon et on interdit toute relance. Sans ce
    /// verrou, un appel RC encore en vol pendant la sortie relancerait un daemon
    /// que plus personne ne fermerait — un process orphelin a chaque fermeture.
    pub fn shutdown(&self) {
        self.stopping
            .store(true, std::sync::atomic::Ordering::Relaxed);
        self.kill();
    }

    /// Tue le daemon (idempotent).
    ///
    /// L'attente est BORNEE (~200 ms) : on veut recuperer le process pour ne pas
    /// laisser de zombie quand il meurt tout de suite, mais un `wait()` bloquant
    /// figerait l'UI sans jamais se fermer si rclone tardait a mourir. Passe ce
    /// delai, l'OS finira le menage a la sortie du processus parent.
    pub fn kill(&self) {
        let mut guard = lock(&self.child);
        if let Some(mut c) = guard.take() {
            let _ = c.kill();
            for _ in 0..20 {
                match c.try_wait() {
                    Ok(None) => std::thread::sleep(std::time::Duration::from_millis(10)),
                    _ => break,
                }
            }
        }
    }
}

/// Localise le binaire rclone : sidecar bundle (resource dir / dossier exe avec
/// suffixe de triple), puis PATH systeme en ultime repli.
fn resolve_rclone(app: &AppHandle) -> PathBuf {
    let exe = if cfg!(windows) { "rclone.exe" } else { "rclone" };

    // 1. Sidecar Tauri : <base>/rclone-<triple>[.exe], a cote de l'exe / dans les resources.
    let triple = tauri::utils::platform::target_triple().unwrap_or_default();
    let sidecar_name = if cfg!(windows) {
        format!("rclone-{triple}.exe")
    } else {
        format!("rclone-{triple}")
    };
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Ok(res) = app.path().resource_dir() {
        dirs.push(res.clone());
    }
    if let Ok(cur) = std::env::current_exe() {
        if let Some(p) = cur.parent() {
            dirs.push(p.to_path_buf());
        }
    }
    for d in &dirs {
        let cand = d.join(&sidecar_name);
        if cand.exists() {
            return cand;
        }
        let plain = d.join(exe);
        if plain.exists() {
            return plain;
        }
    }

    // 2. Dev : binaire prepare par scripts/prepare-bins.mjs.
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(&sidecar_name);
    if dev.exists() {
        return dev;
    }

    // 3. Developpement uniquement : nom court (resolu par l'OS via PATH). En
    //    version livree, jamais : un `rclone` quelconque trouve dans le PATH
    //    (vieux, ou depose la par un tiers) piloterait les transferts. Sans
    //    sidecar, on echoue en nommant le binaire attendu.
    if cfg!(debug_assertions) {
        PathBuf::from(exe)
    } else {
        dirs.first()
            .map(|d| d.join(&sidecar_name))
            .unwrap_or_else(|| PathBuf::from(sidecar_name))
    }
}

/// La config rclone vit desormais en MEMOIRE (`--config ""`) : le remote du
/// serveur courant, mot de passe compris, n'est plus jamais ecrit sur le disque.
/// Les versions precedentes l'ecrivaient dans `rclone.conf` (mot de passe
/// « obscurci », c.-a-d. reversible par n'importe qui) : on efface ce reliquat.
fn forget_legacy_config(app: &AppHandle) {
    if let Ok(dir) = app.path().app_config_dir() {
        let _ = std::fs::remove_file(dir.join("rclone.conf"));
    }
}

/// Reserve un port TCP libre sur la loopback en GARDANT le listener ouvert.
///
/// Le listener doit rester vivant jusqu'au dernier moment avant le lancement de
/// rclone : si on le lachait ici (ce que faisait la version precedente), le port
/// redeviendrait libre pendant toute la preparation de la commande et un autre
/// process pourrait se l'approprier entre-temps — rclone echouerait alors au
/// demarrage et toute l'app resterait bloquee sur « rclone injoignable ».
fn reserve_port() -> (Option<TcpListener>, u16) {
    match TcpListener::bind("127.0.0.1:0") {
        Ok(l) => match l.local_addr() {
            Ok(a) => (Some(l), a.port()),
            Err(_) => (None, 5572),
        },
        Err(_) => (None, 5572),
    }
}

/// Choisit un port TCP libre (le listener est relache tout de suite : reserve aux
/// tests, qui lancent leur propre daemon).
#[cfg(test)]
fn free_port() -> u16 {
    reserve_port().1
}

/// Construit la commande du daemon RC. Utilisee par `start` ET par les tests :
/// si l'authentification disparaissait d'ici, les tests le verraient.
fn rcd_command(bin: &Path, addr: &str, auth: &Auth) -> Command {
    let mut cmd = Command::new(bin);
    // `--config ""` = config en memoire : rien n'est ecrit sur le disque.
    cmd.arg("rcd")
        .arg("--rc-addr")
        .arg(addr)
        .arg("--config")
        .arg("");

    // Le secret passe par l'ENVIRONNEMENT (rclone lit RCLONE_RC_USER/PASS),
    // JAMAIS en argument : la ligne de commande d'un process est lisible par
    // tout le monde (`ps`, Gestionnaire des taches), ce qui reviendrait a
    // publier le mot de passe qu'on vient de tirer.
    cmd.env("RCLONE_RC_USER", &auth.user)
        .env("RCLONE_RC_PASS", &auth.pass);

    // Windows : pas de fenetre console qui flashe (piege herite de Robloader).
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    cmd
}

/// Lance (ou relance) `rclone rcd` en arriere-plan et memorise la base URL de
/// l'API. Un nouveau port et un nouveau secret sont tires a chaque lancement.
fn spawn_daemon(state: &Rclone) -> Result<(), String> {
    if state.stopping.load(std::sync::atomic::Ordering::Relaxed) {
        return Err("Copiteur est en train de se fermer".into());
    }
    let Some(bin) = lock(&state.paths).clone() else {
        return Err("rclone n'a pas été initialisé".into());
    };

    let (listener, port) = reserve_port();
    let addr = format!("127.0.0.1:{port}");
    let auth = Auth {
        user: "copiteur".into(),
        pass: random_secret(),
    };
    let mut cmd = rcd_command(&bin, &addr, &auth);

    // Le port n'est relache qu'ici, juste avant le spawn : la fenetre pendant
    // laquelle un autre process pourrait le prendre est reduite au minimum.
    drop(listener);

    match cmd.spawn() {
        Ok(child) => {
            *lock(&state.base) = format!("http://{addr}");
            *lock(&state.auth) = auth;
            *lock(&state.child) = Some(child);
            lock(&state.error).clear();
            Ok(())
        }
        Err(e) => {
            // Le front ne doit pas avoir a deviner : on garde la cause pour la
            // remonter telle quelle au premier appel (et donc au journal).
            let msg = format!("impossible de lancer rclone ({}) : {e}", bin.display());
            eprintln!("Copiteur: {msg}");
            lock(&state.base).clear();
            *lock(&state.error) = msg.clone();
            Err(msg)
        }
    }
}

/// Relance le daemon s'il n'existe pas ou s'il est mort (port vole au demarrage,
/// crash, process tue depuis le gestionnaire des taches). Entierement synchrone
/// et quasi gratuit dans le cas normal : un `try_wait` sur un process vivant.
/// Rend `true` quand une relance a eu lieu.
fn ensure_alive(state: &Rclone) -> Result<bool, String> {
    let dead = {
        let mut guard = lock(&state.child);
        match guard.as_mut() {
            None => true,
            // `try_wait` recolte le code de sortie au passage : pas de zombie.
            Some(c) => !matches!(c.try_wait(), Ok(None)),
        }
    };
    if dead {
        spawn_daemon(state)?;
    }
    Ok(dead)
}

/// Memorise les chemins puis lance le daemon RC. Appele une fois au setup.
/// Un echec n'est pas fatal : il est conserve dans l'etat et remonte au front
/// des le premier appel, et `ensure_alive` retentera.
pub fn start(app: &AppHandle) {
    let state = app.state::<Rclone>();
    forget_legacy_config(app);
    *lock(&state.paths) = Some(resolve_rclone(app));
    let _ = spawn_daemon(&state);
}

/// Envoie une requete authentifiee a l'API RC.
/// Reessaie brievement le temps que le daemon finisse de demarrer.
async fn rc_post(
    http: &reqwest::Client,
    base: &str,
    auth: &Auth,
    method: &str,
    params: &Value,
) -> Result<Value, String> {
    let url = format!("{base}/{method}");

    let mut last = String::new();
    for attempt in 0..30 {
        match http
            .post(&url)
            .basic_auth(&auth.user, Some(&auth.pass))
            .json(params)
            .send()
            .await
        {
            Ok(resp) => {
                let status = resp.status();
                if status == reqwest::StatusCode::UNAUTHORIZED {
                    // Ne devrait jamais arriver : l'app detient le secret. Si ca
                    // arrive, autant le dire clairement plutot que "erreur inconnue".
                    return Err("rclone a refusé l'authentification".into());
                }
                let body: Value = resp.json().await.unwrap_or(Value::Null);
                if status.is_success() {
                    return Ok(body);
                }
                // rclone renvoie {"error": "..."} avec un code != 2xx.
                let msg = body
                    .get("error")
                    .and_then(|e| e.as_str())
                    .unwrap_or("erreur inconnue");
                return Err(msg.to_string());
            }
            Err(e) => {
                last = e.to_string();
                // Connexion refusee = daemon pas encore pret : on patiente.
                if attempt < 29 {
                    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
                }
            }
        }
    }
    Err(format!("rclone injoignable : {last}"))
}

// ------------------------------------------------------------------
//  Liste blanche de l'API RC
// ------------------------------------------------------------------
//
// L'API RC de rclone peut bien plus que ce dont l'app a besoin : `core/command`
// lance n'importe quelle commande rclone, et le backend SFTP a une option `ssh`
// qui EXECUTE un programme externe — via `config/create`, `options/set` ou une
// chaine de connexion a la volee (":sftp,ssh=...:" passee en `fs`). Le front ne
// devrait jamais envoyer ca, mais si une faille d'affichage permettait un jour
// d'injecter du code dans l'interface, ce passe-plat en ferait une execution
// de programme sur le poste. On ne laisse donc passer que ce dont l'app se sert,
// sous la forme ou elle s'en sert.

/// Nom du remote du serveur courant (cf. `REMOTE` dans `files.ts`).
const REMOTE_NAME: &str = "serveur";

/// Methodes RC utilisees par le front. Tout le reste est refuse.
const ALLOWED_METHODS: &[&str] = &[
    "config/create",
    "core/stats",
    "core/version",
    "fs/cache/clear",
    "job/status",
    "job/stop",
    "operations/copyfile",
    "operations/deletefile",
    "operations/list",
    "operations/mkdir",
    "operations/movefile",
    "operations/purge",
    "operations/size",
    "operations/stat",
    "options/set",
    "sync/move",
];

/// Parametres SFTP que le front a le droit de poser sur le remote. Surtout pas
/// `ssh` (programme externe), `key_file`/`known_hosts_file` (chemins
/// arbitraires), `md5sum_command`/`sha1sum_command` (commandes distantes).
const ALLOWED_SFTP_PARAMS: &[&str] =
    &["host", "user", "pass", "port", "concurrency", "disable_hashcheck"];

/// Un `fs` acceptable : le remote du serveur (`serveur:...`) ou un chemin local
/// SANS syntaxe de remote. rclone interprete `xxx:` (avant le premier
/// separateur) comme un remote et `:backend,opt=...:` comme un remote cree a
/// la volee, avec des options arbitraires — c'est ce qu'il faut barrer. Seule
/// exception : la lettre de lecteur Windows (`C:`), que rclone traite en local.
fn is_safe_fs(fs: &str) -> bool {
    if let Some(rest) = fs.strip_prefix(REMOTE_NAME) {
        return rest.starts_with(':');
    }
    let head = fs.split(['/', '\\']).next().unwrap_or("");
    if !head.contains(':') {
        return true;
    }
    let b = head.as_bytes();
    b.len() == 2 && b[0].is_ascii_alphabetic() && b[1] == b':'
}

/// Verifie qu'un appel RC est l'un de ceux que l'app emet. Rend la raison du
/// refus, journalisee cote front comme n'importe quelle erreur rclone.
fn check_call(method: &str, params: &Value) -> Result<(), String> {
    if !ALLOWED_METHODS.contains(&method) {
        return Err(format!("appel rclone refusé : {method}"));
    }
    if let Some(obj) = params.as_object() {
        for key in ["fs", "srcFs", "dstFs"] {
            if let Some(v) = obj.get(key) {
                let ok = v.as_str().is_some_and(is_safe_fs);
                if !ok {
                    return Err(format!("appel rclone refusé : {key} non autorisé"));
                }
            }
        }
    }
    match method {
        "config/create" => {
            let name = params.get("name").and_then(Value::as_str);
            let kind = params.get("type").and_then(Value::as_str);
            if name != Some(REMOTE_NAME) || kind != Some("sftp") {
                return Err("appel rclone refusé : remote non autorisé".into());
            }
            let Some(p) = params.get("parameters").and_then(Value::as_object) else {
                return Err("appel rclone refusé : paramètres manquants".into());
            };
            if let Some(bad) = p.keys().find(|k| !ALLOWED_SFTP_PARAMS.contains(&k.as_str())) {
                return Err(format!("appel rclone refusé : paramètre « {bad} »"));
            }
        }
        // Le front ne regle que le bloc `main` (transferts) — jamais les options
        // d'un backend (ex. `sftp.ssh`) ni celles du serveur RC lui-meme.
        "options/set" => {
            let only_main = params
                .as_object()
                .is_some_and(|o| o.keys().all(|k| k == "main"));
            if !only_main {
                return Err("appel rclone refusé : options non autorisées".into());
            }
        }
        _ => {}
    }
    Ok(())
}

/// Passe-plat vers l'API RC de rclone, restreint par `check_call`.
/// `method` = chemin RC (ex. "core/version", "operations/list").
/// `params` = corps JSON de la requete.
#[tauri::command]
pub async fn rc_call(
    app: AppHandle,
    state: State<'_, Rclone>,
    method: String,
    params: Value,
) -> Result<Value, String> {
    check_call(&method, &params)?;
    // On relache les verrous avant d'attendre le reseau (ils ne sont pas Send).
    let (base, auth, http, err, relance) = {
        // Le daemon a pu mourir depuis le demarrage : on le relance au besoin.
        let started = ensure_alive(&state);
        let base = lock(&state.base).clone();
        let auth = lock(&state.auth).clone();
        let relance = matches!(started, Ok(true));
        let err = started.err().unwrap_or_else(|| lock(&state.error).clone());
        (base, auth, state.http.clone(), err, relance)
    };
    // Un daemon neuf repart avec les reglages par defaut : la config globale de
    // transfert (`options/set`, dont l'ecriture directe) vit en MEMOIRE dans
    // rclone, pas dans son fichier de config. Le front doit la repousser, sinon
    // les copies suivantes reprendraient silencieusement les reglages par defaut.
    if relance {
        let _ = app.emit("copiteur://rclone-relance", ());
    }
    if base.is_empty() {
        return Err(if err.is_empty() {
            "rclone n'est pas démarré".into()
        } else {
            err
        });
    }
    rc_post(&http, &base, &auth, &method, &params).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Stdio;

    fn rclone_bin() -> PathBuf {
        let triple = tauri::utils::platform::target_triple().unwrap_or_default();
        let exe = if cfg!(windows) {
            format!("rclone-{triple}.exe")
        } else {
            format!("rclone-{triple}")
        };
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(exe)
    }

    /// L'API RC de rclone peut lire, copier et SUPPRIMER n'importe quoi sur la
    /// machine. Elle ne doit repondre QU'AVEC le secret tire au demarrage —
    /// sinon n'importe quel programme local (ou une page web via une requete
    /// "simple", non soumise a la pre-verification CORS) pourrait la piloter.
    #[tokio::test]
    async fn l_api_rc_exige_le_secret() {
        let bin = rclone_bin();
        assert!(
            bin.exists(),
            "binaire rclone absent ({bin:?}) : lancer `node scripts/prepare-bins.mjs`"
        );

        let port = free_port();
        let addr = format!("127.0.0.1:{port}");
        let base = format!("http://{addr}");
        let auth = Auth {
            user: "copiteur".into(),
            pass: random_secret(),
        };
        // On lance le daemon avec la commande CONSTRUITE PAR L'APP : si
        // l'authentification en disparaissait, ce test tomberait.
        let mut child = rcd_command(&bin, &addr, &auth)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("rclone n'a pas demarre");

        let http = reqwest::Client::new();
        let empty = serde_json::json!({});

        // 1. Avec le secret : l'app doit pouvoir piloter son daemon.
        //    (rc_post retente le temps que le daemon soit pret.)
        let ok = rc_post(&http, &base, &auth, "core/version", &empty).await;
        assert!(
            ok.as_ref().is_ok_and(|v| v.get("version").is_some()),
            "l'app doit pouvoir parler a son propre daemon : {ok:?}"
        );

        // 2. Sans secret : refuse. C'est le scenario "autre programme local".
        let anon = http
            .post(format!("{base}/core/version"))
            .json(&empty)
            .send()
            .await
            .expect("requete anonyme");
        assert_eq!(
            anon.status(),
            reqwest::StatusCode::UNAUTHORIZED,
            "une requete SANS secret doit etre refusee"
        );

        // 3. Meme une suppression recursive doit rebondir sur l'authentification.
        let purge = http
            .post(format!("{base}/operations/purge"))
            .json(&serde_json::json!({ "fs": "/", "remote": "" }))
            .send()
            .await
            .expect("purge anonyme");
        assert_eq!(
            purge.status(),
            reqwest::StatusCode::UNAUTHORIZED,
            "operations/purge sans secret doit etre refuse"
        );

        // 4. Mauvais secret : refuse aussi.
        let bad = Auth {
            user: "copiteur".into(),
            pass: "pas-le-bon-secret".into(),
        };
        assert!(
            rc_post(&http, &base, &bad, "core/version", &empty)
                .await
                .is_err(),
            "un mauvais secret doit etre refuse"
        );

        let _ = child.kill();
        let _ = child.wait();
    }

    /// Si le daemon meurt (crash, port vole au demarrage, process tue a la main),
    /// l'app ne doit pas rester definitivement muette : le prochain appel le
    /// relance sur un nouveau port.
    #[tokio::test]
    async fn le_daemon_est_relance_s_il_meurt() {
        let bin = rclone_bin();
        assert!(
            bin.exists(),
            "binaire rclone absent ({bin:?}) : lancer `node scripts/prepare-bins.mjs`"
        );
        let st = Rclone::default();
        *lock(&st.paths) = Some(bin);
        spawn_daemon(&st).expect("premier lancement");
        let premiere = lock(&st.base).clone();
        assert!(!premiere.is_empty());

        // Mort du daemon.
        st.kill();
        ensure_alive(&st).expect("relance apres la mort du daemon");
        let seconde = lock(&st.base).clone();
        assert_ne!(premiere, seconde, "la relance doit prendre un nouveau port");

        // Et le nouveau daemon repond bien, avec son nouveau secret.
        let auth = lock(&st.auth).clone();
        let ok = rc_post(&st.http, &seconde, &auth, "core/version", &serde_json::json!({})).await;
        assert!(ok.is_ok(), "le daemon relance doit repondre : {ok:?}");

        st.kill();
    }

    /// Un binaire introuvable ne doit pas etre etouffe : la cause est conservee
    /// pour etre affichee/journalisee cote UI.
    #[test]
    fn l_echec_de_lancement_est_conserve() {
        let st = Rclone::default();
        *lock(&st.paths) = Some(PathBuf::from("rclone-qui-n-existe-pas-copiteur"));
        let err = spawn_daemon(&st).expect_err("un binaire absent doit echouer");
        assert!(err.contains("rclone-qui-n-existe-pas-copiteur"), "{err}");
        assert_eq!(*lock(&st.error), err, "la cause doit rester dans l'etat");
        assert!(lock(&st.base).is_empty());
    }

    /// A la fermeture, un appel encore en vol ne doit PAS ressusciter le daemon :
    /// il resterait orphelin, personne n'etant plus la pour le tuer.
    #[test]
    fn la_fermeture_interdit_toute_relance() {
        let st = Rclone::default();
        *lock(&st.paths) = Some(rclone_bin());
        st.shutdown();
        assert!(ensure_alive(&st).is_err(), "aucune relance apres shutdown");
        assert!(lock(&st.child).is_none());
    }

    /// Deux lancements ne doivent jamais reutiliser le meme secret.
    #[test]
    fn le_secret_est_tire_au_hasard() {
        let (a, b) = (random_secret(), random_secret());
        assert_eq!(a.len(), 64, "32 octets en hexa");
        assert_ne!(a, b);
    }

    /// Le secret doit vivre dans l'ENVIRONNEMENT du daemon, jamais dans sa ligne
    /// de commande : `ps` (Linux/macOS) et le Gestionnaire des taches (Windows)
    /// exposent la ligne de commande de n'importe quel process a l'utilisateur.
    /// L'y mettre reviendrait a publier le mot de passe qu'on vient de tirer.
    #[test]
    fn le_secret_ne_passe_jamais_par_la_ligne_de_commande() {
        let auth = Auth {
            user: "copiteur".into(),
            pass: random_secret(),
        };
        let cmd = rcd_command(Path::new("rclone"), "127.0.0.1:5572", &auth);

        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert!(
            !args.iter().any(|a| a.contains(&auth.pass)),
            "le secret ne doit pas apparaitre dans les arguments : {args:?}"
        );
        assert!(
            !args.iter().any(|a| a == "--rc-no-auth"),
            "l'API RC ne doit jamais etre ouverte sans authentification"
        );

        let has_secret_in_env = cmd.get_envs().any(|(k, v)| {
            k == "RCLONE_RC_PASS" && v.is_some_and(|v| v.to_string_lossy() == auth.pass)
        });
        assert!(
            has_secret_in_env,
            "le secret doit etre transmis par l'environnement"
        );
    }

    /// Ce que l'app emet vraiment doit passer.
    #[test]
    fn la_liste_blanche_laisse_passer_les_appels_de_l_app() {
        use serde_json::json;
        let ok = [
            ("core/version", json!({})),
            ("operations/list", json!({ "fs": "serveur:", "remote": "a/b" })),
            ("operations/list", json!({ "fs": "serveur:/share/x", "remote": "" })),
            ("operations/list", json!({ "fs": "/home/alice/Rushs", "remote": "" })),
            ("operations/list", json!({ "fs": "C:\\Users\\alice", "remote": "" })),
            ("operations/list", json!({ "fs": "\\\\nas\\partage", "remote": "" })),
            ("operations/copyfile", json!({ "srcFs": "serveur:/a", "srcRemote": "x:y.mp4", "dstFs": "D:\\", "dstRemote": "x.mp4" })),
            ("sync/move", json!({ "srcFs": "/a", "dstFs": "/b/c:d" })),
            ("options/set", json!({ "main": { "Inplace": true } })),
            ("config/create", json!({ "name": "serveur", "type": "sftp", "parameters": { "host": "h", "user": "u", "pass": "p", "port": "22", "concurrency": "64", "disable_hashcheck": "true" }, "opt": { "obscure": true } })),
        ];
        for (m, p) in ok {
            assert!(check_call(m, &p).is_ok(), "{m} {p} devrait passer : {:?}", check_call(m, &p));
        }
    }

    /// Tout ce qui permettrait d'executer un programme ou de sortir du cadre
    /// doit etre refuse AVANT d'atteindre rclone.
    #[test]
    fn la_liste_blanche_bloque_les_appels_dangereux() {
        use serde_json::json;
        let ko = [
            ("core/command", json!({ "command": "ls" })),
            ("config/dump", json!({})),
            ("backend/command", json!({})),
            ("rc/noop", json!({})),
            // Remote a la volee avec programme externe.
            ("operations/list", json!({ "fs": ":sftp,host=h,ssh='calc.exe':", "remote": "" })),
            ("operations/list", json!({ "fs": "serveur,ssh='calc.exe':", "remote": "" })),
            ("operations/list", json!({ "fs": "autre:", "remote": "" })),
            ("operations/copyfile", json!({ "srcFs": "/a", "dstFs": ":local:" })),
            ("operations/list", json!({ "fs": 3, "remote": "" })),
            // Parametres SFTP qui executent une commande ou lisent un fichier.
            ("config/create", json!({ "name": "serveur", "type": "sftp", "parameters": { "host": "h", "ssh": "calc.exe" } })),
            ("config/create", json!({ "name": "serveur", "type": "sftp", "parameters": { "host": "h", "md5sum_command": "rm -rf /" } })),
            ("config/create", json!({ "name": "serveur", "type": "local", "parameters": {} })),
            ("config/create", json!({ "name": "autre", "type": "sftp", "parameters": { "host": "h" } })),
            ("options/set", json!({ "sftp": { "ssh": "calc.exe" } })),
            ("options/set", json!({ "main": {}, "rc": { "NoAuth": true } })),
        ];
        for (m, p) in ko {
            assert!(check_call(m, &p).is_err(), "{m} {p} devrait etre refuse");
        }
    }

    /// La config rclone (mot de passe du serveur compris) reste en memoire.
    #[test]
    fn la_config_rclone_n_est_jamais_ecrite_sur_le_disque() {
        let auth = Auth { user: "copiteur".into(), pass: random_secret() };
        let cmd = rcd_command(Path::new("rclone"), "127.0.0.1:5572", &auth);
        let args: Vec<String> = cmd.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        let i = args.iter().position(|a| a == "--config").expect("--config present");
        assert_eq!(args.get(i + 1).map(String::as_str), Some(""), "{args:?}");
    }
}
