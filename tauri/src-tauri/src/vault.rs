// ============================================================
//  Copiteur — chiffrement des mots de passe des serveurs memorises
//
//  Les mots de passe ne sont plus ecrits en clair dans `serveurs.json` : ils y
//  sont CHIFFRES (ChaCha20-Poly1305) avec une cle aleatoire de 32 octets, et
//  cette cle vit dans le trousseau du systeme — Gestionnaire d'identifiants
//  sous Windows, Trousseau sous macOS. Un programme qui lirait le fichier n'en
//  tirerait rien.
//
//  Pourquoi UNE cle plutot qu'une entree de trousseau par serveur : sous macOS,
//  une app signee « ad hoc » (sans compte developpeur Apple) change d'identite
//  a chaque mise a jour, et le Trousseau redemande alors l'autorisation pour
//  chaque entree. Une seule entree = une seule question, et seulement apres une
//  mise a jour. La cle est lue une fois par lancement puis gardee en memoire.
//
//  Ailleurs (Linux : outil de dev), pas de trousseau : la cle est un fichier
//  lisible par le seul utilisateur, a cote de `serveurs.json`.
// ============================================================

use std::path::Path;
use std::sync::Mutex;

use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, CHACHA20_POLY1305};

const PREFIX: &str = "v1:";

/// Resultat de la premiere lecture, garde pour tout le lancement. L'ECHEC aussi
/// est memorise : si l'utilisateur a refuse l'acces au trousseau, on ne lui
/// repose pas la question a chaque enregistrement.
static KEY: Mutex<Option<Result<[u8; 32], String>>> = Mutex::new(None);

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn entry() -> keyring::Result<keyring::Entry> {
    keyring::Entry::new("Copiteur", "cle-serveurs")
}

fn fresh_key() -> Result<[u8; 32], String> {
    let mut k = [0u8; 32];
    getrandom::fill(&mut k).map_err(|e| e.to_string())?;
    Ok(k)
}

/// Lit la cle dans le trousseau, ou la cree si elle n'y est pas ENCORE. Toute
/// autre erreur (acces refuse par l'utilisateur, trousseau verrouille…) est
/// remontee telle quelle : surtout ne pas creer une nouvelle cle par-dessus,
/// on perdrait l'acces aux mots de passe deja chiffres.
#[cfg(any(target_os = "macos", target_os = "windows"))]
fn load_or_create(_dir: &Path) -> Result<[u8; 32], String> {
    let e = entry().map_err(|e| e.to_string())?;
    match e.get_secret() {
        Ok(bytes) => bytes
            .try_into()
            .map_err(|_| "clé du trousseau illisible".to_string()),
        Err(keyring::Error::NoEntry) => {
            let k = fresh_key()?;
            e.set_secret(&k).map_err(|e| e.to_string())?;
            Ok(k)
        }
        Err(err) => Err(err.to_string()),
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn load_or_create(dir: &Path) -> Result<[u8; 32], String> {
    let f = dir.join("cle-serveurs");
    if let Ok(bytes) = std::fs::read(&f) {
        return bytes
            .try_into()
            .map_err(|_| "fichier de clé illisible".to_string());
    }
    let k = fresh_key()?;
    write_private(&f, &k).map_err(|e| e.to_string())?;
    Ok(k)
}

/// Ecrit un fichier lisible par le seul utilisateur (0600 sous Unix ; sous
/// Windows, le dossier de config du profil est deja prive).
pub fn write_private(path: &Path, data: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(path)?;
    f.write_all(data)?;
    f.sync_all()?;
    // `mode` ne s'applique qu'a la creation : on resserre un fichier existant.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

/// Cle de chiffrement (lue une seule fois par lancement).
pub fn key(config_dir: &Path) -> Result<[u8; 32], String> {
    let mut guard = KEY.lock().unwrap_or_else(|p| p.into_inner());
    guard
        .get_or_insert_with(|| load_or_create(config_dir))
        .clone()
}

fn to_hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn from_hex(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok())
        .collect()
}

/// Chiffre un mot de passe : "v1:" + hexa(nonce de 12 octets + chiffre + tag).
pub fn encrypt(key: &[u8; 32], plain: &str) -> Result<String, String> {
    let k = LessSafeKey::new(UnboundKey::new(&CHACHA20_POLY1305, key).map_err(|e| e.to_string())?);
    let mut nonce = [0u8; 12];
    getrandom::fill(&mut nonce).map_err(|e| e.to_string())?;
    let mut buf = plain.as_bytes().to_vec();
    k.seal_in_place_append_tag(Nonce::assume_unique_for_key(nonce), Aad::empty(), &mut buf)
        .map_err(|e| e.to_string())?;
    let mut out = nonce.to_vec();
    out.extend_from_slice(&buf);
    Ok(format!("{PREFIX}{}", to_hex(&out)))
}

/// Dechiffre ; `None` si le texte est abime ou chiffre avec une autre cle.
pub fn decrypt(key: &[u8; 32], enc: &str) -> Option<String> {
    let raw = from_hex(enc.strip_prefix(PREFIX)?)?;
    if raw.len() < 12 {
        return None;
    }
    let (nonce, rest) = raw.split_at(12);
    let k = LessSafeKey::new(UnboundKey::new(&CHACHA20_POLY1305, key).ok()?);
    let mut buf = rest.to_vec();
    let plain = k
        .open_in_place(Nonce::try_assume_unique_for_key(nonce).ok()?, Aad::empty(), &mut buf)
        .ok()?;
    String::from_utf8(plain.to_vec()).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aller_retour_et_mauvaise_cle() {
        let k = fresh_key().unwrap();
        let e = encrypt(&k, "mot de passe é ✓").unwrap();
        assert!(e.starts_with(PREFIX));
        assert!(!e.contains("mot"), "le clair ne doit pas apparaitre");
        assert_eq!(decrypt(&k, &e).as_deref(), Some("mot de passe é ✓"));
        // Deux chiffrements du meme mot de passe different (nonce aleatoire).
        assert_ne!(encrypt(&k, "x").unwrap(), encrypt(&k, "x").unwrap());
        // Autre cle, texte abime : refuse, sans paniquer.
        let autre = fresh_key().unwrap();
        assert_eq!(decrypt(&autre, &e), None);
        let mut abime = e.clone();
        abime.pop();
        abime.push('0');
        assert_eq!(decrypt(&k, &abime), None);
        assert_eq!(decrypt(&k, "v1:zz"), None);
        assert_eq!(decrypt(&k, "clair"), None);
    }

    #[cfg(unix)]
    #[test]
    fn fichier_prive() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("copiteur-vault-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("x");
        std::fs::write(&f, b"ancien").unwrap();
        std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o644)).unwrap();
        write_private(&f, b"secret").unwrap();
        let mode = std::fs::metadata(&f).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
