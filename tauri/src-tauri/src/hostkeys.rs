// ============================================================
//  Copiteur — identite des serveurs SFTP (cle d'hote), facon FileZilla
//
//  Sans verification, rclone accepte n'importe quelle cle : sur un reseau
//  qu'on ne maitrise pas (Wi-Fi public, hotel…), un tiers peut se faire passer
//  pour le serveur et recuperer le mot de passe a la connexion.
//
//  Principe « confiance a la premiere connexion » (TOFU) :
//    1. avant de se connecter, on lit la cle du serveur par une poignee de main
//       SSH minimale (russh, sans authentification : on raccroche des que la
//       cle est connue) ;
//    2. cle inconnue -> l'utilisateur voit l'empreinte et accepte ou non ;
//       cle differente de celle memorisee -> alerte rouge ;
//    3. la cle acceptee est ecrite dans un `known_hosts` propre a l'app, et
//       rclone est configure pour l'EXIGER (`known_hosts_file`). Ainsi meme si
//       un intrus s'intercalait entre la verification et la vraie connexion,
//       rclone refuserait de lui parler.
// ============================================================

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::keys::{HashAlg, PublicKey};
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

/// Cles lues mais pas encore acceptees, par motif d'hote. C'est le backend qui
/// garde la cle entre la lecture et l'acceptation : le front ne fait que dire
/// « oui », il ne transmet jamais de cle.
#[derive(Default)]
pub struct HostKeys {
    pending: Mutex<HashMap<String, String>>,
}

#[derive(Serialize, Clone, Debug)]
pub struct HostKeyStatus {
    /// "known" (deja acceptee), "new" (jamais vue) ou "changed" (differente).
    pub status: &'static str,
    /// Type de cle, ex. "ssh-ed25519".
    pub algo: String,
    /// Empreinte SHA-256, au format d'OpenSSH/FileZilla ("SHA256:…").
    pub fingerprint: String,
    /// Empreinte memorisee jusqu'ici (seulement si "changed").
    pub previous: Option<String>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// Port saisi -> numero (22 si vide ou illisible, comme la connexion).
pub fn parse_port(port: &str) -> u16 {
    port.trim().parse().unwrap_or(22)
}

/// Motif d'hote tel que l'ecrit et le relit le `known_hosts` de Go (celui de
/// rclone) — reprise de `knownhosts.Normalize` : port 22 -> "hote", sinon
/// "[hote]:port" ; une IPv6 nue est toujours entre crochets.
pub fn host_pattern(host: &str, port: u16) -> String {
    let h = host.trim();
    let h = h
        .strip_prefix('[')
        .and_then(|x| x.strip_suffix(']'))
        .unwrap_or(h);
    if port != 22 {
        format!("[{h}]:{port}")
    } else if h.contains(':') {
        format!("[{h}]")
    } else {
        h.to_string()
    }
}

fn known_hosts_path(app: &AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| std::env::temp_dir());
    let _ = std::fs::create_dir_all(&dir);
    dir.join("known_hosts")
}

/// "type base64" d'une cle (sans commentaire), forme stockee dans le fichier.
fn key_line(key: &PublicKey) -> Result<String, String> {
    let s = key.to_openssh().map_err(|e| e.to_string())?;
    let mut it = s.split_whitespace();
    match (it.next(), it.next()) {
        (Some(a), Some(b)) => Ok(format!("{a} {b}")),
        _ => Err("clé illisible".into()),
    }
}

fn fingerprint_of(key_line: &str) -> String {
    PublicKey::from_openssh(key_line)
        .map(|k| k.fingerprint(HashAlg::Sha256).to_string())
        .unwrap_or_else(|_| "?".into())
}

/// Cle memorisee pour un motif d'hote ("type base64"), s'il y en a une.
fn stored(path: &std::path::Path, pattern: &str) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    text.lines().find_map(|l| {
        let mut it = l.split_whitespace();
        (it.next()? == pattern).then(|| {
            let (a, b) = (it.next()?, it.next()?);
            Some(format!("{a} {b}"))
        })?
    })
}

/// Remplace (ou ajoute) la ligne d'un hote. Ecriture atomique : tmp + rename.
fn store(path: &std::path::Path, pattern: &str, key: &str) -> std::io::Result<()> {
    let old = std::fs::read_to_string(path).unwrap_or_default();
    let mut out: String = old
        .lines()
        .filter(|l| l.split_whitespace().next() != Some(pattern) && !l.trim().is_empty())
        .map(|l| format!("{l}\n"))
        .collect();
    out.push_str(&format!("{pattern} {key}\n"));
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, out)?;
    std::fs::rename(&tmp, path)
}

/// Algorithmes de cle d'hote a imposer a rclone pour qu'il negocie la MEME cle
/// que celle memorisee (un serveur en a souvent plusieurs : ed25519, ecdsa,
/// rsa). Sinon rclone pourrait recevoir une autre de ses cles et la prendre
/// pour une usurpation.
pub fn rclone_algorithms(key_type: &str) -> String {
    match key_type {
        "ssh-rsa" => "rsa-sha2-512 rsa-sha2-256 ssh-rsa".into(),
        other => other.into(),
    }
}

struct Grab(Arc<Mutex<Option<PublicKey>>>);

impl russh::client::Handler for Grab {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        key: &russh::keys::PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        if let russh::keys::PublicKeyOrCertificate::PublicKey { key, .. } = key {
            *lock(&self.0) = Some(key.clone());
        }
        // On a ce qu'on voulait : on raccroche sans s'authentifier.
        Ok(false)
    }
}

/// Lit la cle d'hote du serveur. Ne s'authentifie pas : aucun mot de passe
/// n'est envoye a un serveur qu'on n'a pas encore reconnu.
pub async fn fetch_key(host: &str, port: u16) -> Result<PublicKey, String> {
    use russh::{cipher, kex, mac, Preferred};
    use std::borrow::Cow;

    let h = host.trim();
    let h = h
        .strip_prefix('[')
        .and_then(|x| x.strip_suffix(']'))
        .unwrap_or(h)
        .to_string();
    // On ne fait que LIRE la cle : on accepte aussi les vieux algorithmes
    // d'echange (SHA-1, CBC) qu'un NAS ancien est parfois seul a parler, pour
    // ne pas refuser un serveur que rclone, lui, saurait joindre.
    let mut kexes: Vec<kex::Name> = Preferred::DEFAULT.kex.to_vec();
    kexes.extend([kex::DH_G14_SHA1, kex::DH_G1_SHA1]);
    let mut ciphers: Vec<cipher::Name> = Preferred::DEFAULT.cipher.to_vec();
    ciphers.extend([cipher::AES_128_CBC, cipher::AES_192_CBC, cipher::AES_256_CBC]);
    let mut macs: Vec<mac::Name> = Preferred::DEFAULT.mac.to_vec();
    macs.extend([mac::HMAC_SHA1_ETM, mac::HMAC_SHA1]);
    let config = russh::client::Config {
        preferred: Preferred {
            kex: Cow::Owned(kexes),
            cipher: Cow::Owned(ciphers),
            mac: Cow::Owned(macs),
            ..Preferred::DEFAULT
        },
        ..Default::default()
    };

    let slot = Arc::new(Mutex::new(None));
    let attempt = russh::client::connect(Arc::new(config), (h.as_str(), port), Grab(slot.clone()));
    let res = tokio::time::timeout(Duration::from_secs(12), attempt).await;
    if let Some(key) = lock(&slot).take() {
        return Ok(key);
    }
    Err(match res {
        Err(_) => "le serveur ne répond pas (délai dépassé)".into(),
        Ok(Err(e)) => format!("impossible de lire l'identité du serveur : {e}"),
        Ok(Ok(_)) => "le serveur n'a présenté aucune clé".into(),
    })
}

/// Compare la cle presentee a celle memorisee.
fn classify(saved: Option<&str>, current: &str) -> &'static str {
    match saved {
        Some(s) if s == current => "known",
        Some(_) => "changed",
        None => "new",
    }
}

/// Etape 1 : lit la cle du serveur et dit si elle est connue, nouvelle ou
/// differente. Une cle non connue est gardee de cote pour `host_key_trust`.
#[tauri::command]
pub async fn host_key_check(
    app: AppHandle,
    state: State<'_, HostKeys>,
    host: String,
    port: String,
) -> Result<HostKeyStatus, String> {
    let port = parse_port(&port);
    let pattern = host_pattern(&host, port);
    let key = fetch_key(&host, port).await?;
    let line = key_line(&key)?;
    let saved = stored(&known_hosts_path(&app), &pattern);
    let status = classify(saved.as_deref(), &line);
    if status != "known" {
        lock(&state.pending).insert(pattern, line.clone());
    }
    Ok(HostKeyStatus {
        status,
        algo: line.split(' ').next().unwrap_or("").to_string(),
        fingerprint: key.fingerprint(HashAlg::Sha256).to_string(),
        previous: saved.filter(|_| status == "changed").map(|s| fingerprint_of(&s)),
    })
}

/// Etape 2 : l'utilisateur a accepte — on memorise la cle lue a l'etape 1.
#[tauri::command]
pub fn host_key_trust(
    app: AppHandle,
    state: State<'_, HostKeys>,
    host: String,
    port: String,
) -> Result<(), String> {
    let pattern = host_pattern(&host, parse_port(&port));
    let Some(line) = lock(&state.pending).remove(&pattern) else {
        return Err("aucune clé en attente pour ce serveur".into());
    };
    store(&known_hosts_path(&app), &pattern, &line).map_err(|e| e.to_string())
}

/// Parametres a imposer au remote rclone : le fichier `known_hosts` de l'app et
/// l'algorithme de la cle memorisee. Refuse si le serveur n'a jamais ete
/// reconnu — on ne configure pas de remote pour un serveur non verifie.
pub fn rclone_params(app: &AppHandle, host: &str, port: &str) -> Result<(String, String), String> {
    let path = known_hosts_path(app);
    let pattern = host_pattern(host, parse_port(port));
    let Some(line) = stored(&path, &pattern) else {
        return Err("identité du serveur non vérifiée".into());
    };
    let algo = line.split(' ').next().unwrap_or("");
    Ok((path.to_string_lossy().into_owned(), rclone_algorithms(algo)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn motif_d_hote_identique_a_celui_de_go() {
        assert_eq!(host_pattern("nas.local", 22), "nas.local");
        assert_eq!(host_pattern(" nas.local ", 22), "nas.local");
        assert_eq!(host_pattern("10.0.0.5", 2222), "[10.0.0.5]:2222");
        assert_eq!(host_pattern("::1", 22), "[::1]");
        assert_eq!(host_pattern("[::1]", 2222), "[::1]:2222");
        assert_eq!(parse_port(""), 22);
        assert_eq!(parse_port("10022"), 10022);
    }

    #[test]
    fn classement_connue_nouvelle_changee() {
        assert_eq!(classify(None, "ssh-ed25519 AAA"), "new");
        assert_eq!(classify(Some("ssh-ed25519 AAA"), "ssh-ed25519 AAA"), "known");
        assert_eq!(classify(Some("ssh-ed25519 AAA"), "ssh-ed25519 BBB"), "changed");
    }

    #[test]
    fn le_fichier_remplace_la_ligne_d_un_hote_sans_toucher_aux_autres() {
        let dir = std::env::temp_dir().join(format!("copiteur-kh-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("known_hosts");
        let _ = std::fs::remove_file(&f);
        store(&f, "a", "ssh-ed25519 AAA").unwrap();
        store(&f, "[b]:2222", "ssh-rsa BBB").unwrap();
        store(&f, "a", "ssh-ed25519 CCC").unwrap();
        assert_eq!(stored(&f, "a").as_deref(), Some("ssh-ed25519 CCC"));
        assert_eq!(stored(&f, "[b]:2222").as_deref(), Some("ssh-rsa BBB"));
        assert_eq!(stored(&f, "b"), None);
        let text = std::fs::read_to_string(&f).unwrap();
        assert_eq!(text.lines().count(), 2, "{text}");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn algorithmes_rsa_elargis() {
        assert_eq!(rclone_algorithms("ssh-ed25519"), "ssh-ed25519");
        assert_eq!(rclone_algorithms("ssh-rsa"), "rsa-sha2-512 rsa-sha2-256 ssh-rsa");
    }

    fn rclone_bin() -> PathBuf {
        let triple = tauri::utils::platform::target_triple().unwrap_or_default();
        let ext = if cfg!(windows) { ".exe" } else { "" };
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(format!("rclone-{triple}{ext}"))
    }

    /// rclone, lance avec les parametres que pose l'app, contre un serveur
    /// SSH reel. Rend sa sortie d'erreur.
    fn rclone_lsd(known_hosts: &std::path::Path, algos: &str) -> String {
        let obscured = std::process::Command::new(rclone_bin())
            .args(["obscure", "pas-le-bon-mot-de-passe"])
            .output()
            .expect("rclone obscure");
        let pass = String::from_utf8_lossy(&obscured.stdout).trim().to_string();
        let out = std::process::Command::new(rclone_bin())
            .args(["lsd", ":sftp:", "--config", "", "--contimeout", "5s", "--low-level-retries", "1", "--retries", "1"])
            .args(["--sftp-host", "127.0.0.1", "--sftp-user", "copiteur-test-inexistant"])
            .args(["--sftp-pass", &pass])
            .arg("--sftp-known-hosts-file")
            .arg(known_hosts)
            .args(["--sftp-host-key-algorithms", algos])
            .output()
            .expect("rclone");
        String::from_utf8_lossy(&out.stderr).into_owned()
    }

    /// Parcours complet contre le serveur SSH de la machine (ignore s'il n'y
    /// en a pas) : la cle lue par russh, ecrite comme le fait l'app, est
    /// acceptee par rclone ; une autre cle pour le meme hote est REFUSEE.
    #[tokio::test]
    async fn rclone_exige_la_cle_memorisee() {
        if std::net::TcpStream::connect_timeout(
            &"127.0.0.1:22".parse().unwrap(),
            Duration::from_secs(1),
        )
        .is_err()
        {
            eprintln!("pas de serveur SSH local : test ignore");
            return;
        }
        let key = fetch_key("127.0.0.1", 22).await.expect("lecture de la cle");
        let line = key_line(&key).unwrap();
        let algo = line.split(' ').next().unwrap().to_string();

        let dir = std::env::temp_dir().join(format!("copiteur-kh-e2e-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("known_hosts");
        let _ = std::fs::remove_file(&f);

        // Bonne cle : la poignee de main passe, seule l'authentification
        // echoue (utilisateur inexistant, aucun mot de passe).
        store(&f, &host_pattern("127.0.0.1", 22), &line).unwrap();
        let err = rclone_lsd(&f, &rclone_algorithms(&algo));
        assert!(!err.contains("knownhosts"), "la bonne cle doit etre acceptee : {err}");
        assert!(err.contains("unable to authenticate"), "{err}");

        // Cle d'un AUTRE serveur memorisee pour cet hote : usurpation, refus.
        store(
            &f,
            &host_pattern("127.0.0.1", 22),
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",
        )
        .unwrap();
        let err = rclone_lsd(&f, "ssh-ed25519");
        assert!(err.contains("knownhosts: key mismatch"), "une autre cle doit etre refusee : {err}");

        std::fs::remove_dir_all(&dir).unwrap();
    }
}
