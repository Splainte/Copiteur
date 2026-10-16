// ============================================================
//  Copiteur — moteur backend (accent systeme, racines locales, serveurs memorises)
// ============================================================

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};
use crate::i18n::tr;

// ------------------------------------------------------------------
//  Racines du volet de navigation local (lecteurs + acces rapide)
// ------------------------------------------------------------------
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalRoot {
    pub label: String,
    pub path: String,       // chemin en slashs avant, termine par "/"
    pub kind: String,       // "quick" | "drive"
    pub drive_type: String, // "" | "fixed" | "network" | "removable" | "cdrom"
    // Chemin UNC d'un lecteur reseau (\\serveur\partage), vide sinon. Sert de
    // cle STABLE pour renommer/memoriser le lecteur (la lettre, elle, peut
    // changer d'une session a l'autre).
    pub unc: String,
}

fn norm_dir(p: &Path) -> String {
    let mut s = p.to_string_lossy().replace('\\', "/");
    if !s.ends_with('/') {
        s.push('/');
    }
    s
}

#[cfg(windows)]
fn drive_letters() -> Vec<char> {
    extern "system" {
        fn GetLogicalDrives() -> u32;
    }
    let mask = unsafe { GetLogicalDrives() };
    (0u32..26)
        .filter(|i| mask & (1 << i) != 0)
        .map(|i| (b'A' + i as u8) as char)
        .collect()
}

#[cfg(windows)]
fn to_wide(s: &str) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    std::ffi::OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

// Type d'un lecteur (rapide : GetDriveTypeW n'accede pas au support).
#[cfg(windows)]
fn drive_type(letter: char) -> String {
    extern "system" {
        fn GetDriveTypeW(root: *const u16) -> u32;
    }
    let root = to_wide(&format!("{letter}:\\"));
    match unsafe { GetDriveTypeW(root.as_ptr()) } {
        2 => "removable",
        3 => "fixed",
        4 => "network",
        5 => "cdrom",
        _ => "fixed",
    }
    .to_string()
}

// Nom de volume d'un lecteur LOCAL (comme l'explorateur). A NE PAS appeler sur un
// lecteur reseau : GetVolumeInformationW contacte alors le partage SMB et bloque
// plusieurs secondes (voire jusqu'au timeout) si le serveur dort ou est absent —
// c'etait la cause du long gel « démarrage de rclone » au lancement.
#[cfg(windows)]
fn volume_label(letter: char) -> String {
    extern "system" {
        fn GetVolumeInformationW(
            root: *const u16,
            vol_name: *mut u16,
            vol_name_size: u32,
            serial: *mut u32,
            max_len: *mut u32,
            flags: *mut u32,
            fs_name: *mut u16,
            fs_name_size: u32,
        ) -> i32;
    }
    let root = to_wide(&format!("{letter}:\\"));
    let mut buf = [0u16; 256];
    let ok = unsafe {
        GetVolumeInformationW(
            root.as_ptr(),
            buf.as_mut_ptr(),
            buf.len() as u32,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            0,
        )
    };
    if ok != 0 {
        let end = buf.iter().position(|&c| c == 0).unwrap_or(0);
        String::from_utf16_lossy(&buf[..end])
    } else {
        String::new()
    }
}

// Chemin UNC (\\serveur\partage) d'un lecteur reseau mappe. Lu dans la table de
// connexions LOCALE (Multiple Provider Router) : aucun aller-retour vers le
// serveur, donc instantane meme si le partage est injoignable. C'est aussi ce
// qui DISTINGUE deux partages du meme serveur (que le nom de volume, identique,
// confondait — d'ou le meme nom de partage affiche en triple).
#[cfg(windows)]
fn unc_of(letter: char) -> Option<String> {
    #[link(name = "mpr")]
    extern "system" {
        fn WNetGetConnectionW(local: *const u16, remote: *mut u16, len: *mut u32) -> u32;
    }
    const NO_ERROR: u32 = 0;
    let local = to_wide(&format!("{letter}:"));
    let mut buf = [0u16; 512];
    let mut len = buf.len() as u32;
    let r = unsafe { WNetGetConnectionW(local.as_ptr(), buf.as_mut_ptr(), &mut len) };
    if r != NO_ERROR {
        return None;
    }
    let end = buf.iter().position(|&c| c == 0).unwrap_or(0);
    let s = String::from_utf16_lossy(&buf[..end]);
    (!s.is_empty()).then_some(s)
}

// Nom que l'utilisateur a donne au lecteur reseau DANS L'EXPLORATEUR Windows.
// Stocke dans le registre (MountPoints2\<UNC avec \ -> #>\_LabelFromReg) : lecture
// locale instantanee, aucun acces reseau. Permet de reprendre tel quel le nom
// deja choisi cote systeme.
#[cfg(windows)]
fn explorer_label(unc: &str) -> Option<String> {
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
    // HKEY_CURRENT_USER = (HKEY)(LONG)0x80000001, sign-etendu vers un pointeur.
    const HKEY_CURRENT_USER: isize = 0x8000_0001u32 as i32 as isize;
    const RRF_RT_REG_SZ: u32 = 0x0000_0002;

    let key_frag = unc.replace('\\', "#"); // \\serveur\partage -> ##serveur#partage
    let subkey = to_wide(&format!(
        "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\MountPoints2\\{key_frag}"
    ));
    let value = to_wide("_LabelFromReg");
    let mut buf = [0u16; 256];
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
    let s = String::from_utf16_lossy(&buf[..end]);
    (!s.is_empty()).then_some(s)
}

// Decoupe un UNC \\serveur\partage[\...] en (serveur, partage complet).
#[cfg(windows)]
fn split_unc(unc: &str) -> (String, Option<String>) {
    let t = unc.trim_start_matches('\\');
    let mut it = t.splitn(2, '\\');
    let server = it.next().unwrap_or("").to_string();
    let share = it.next().map(|s| s.to_string());
    (server, share)
}

// Nom affiche d'un lecteur reseau, par ordre de priorite :
//   1. le nom donne dans l'explorateur Windows (_LabelFromReg) ;
//   2. a defaut, une composition facon explorateur : partage (\\serveur) (X:).
#[cfg(windows)]
fn network_display(unc: &str, letter: char) -> String {
    if let Some(l) = explorer_label(unc) {
        return format!("{l} ({letter}:)");
    }
    let (server, share) = split_unc(unc);
    match share {
        Some(sh) => format!("{sh} (\\\\{server}) ({letter}:)"),
        None => format!("{unc} ({letter}:)"),
    }
}

// macOS : volumes montes sous /Volumes (disques externes, images disque,
// partages reseau). Le disque de demarrage n'y apparait pas — il est mounte
// sur "/" et ajoute a part dans collect_roots sous le nom "Macintosh HD".
//
// On lit la sortie de `mount` plutot que de passer par une API bas niveau
// (getattrlist/DiskArbitration) : c'est deja le choix fait pour la couleur
// d'accent (cf. get_accent_color, `defaults read`), et ca evite d'ajouter
// une dependance FFI juste pour lire un type de systeme de fichiers.
//
// NB : si l'app tourne encore depuis son propre .dmg monte, ce montage
// apparaitrait ici comme un volume de plus. On ne le filtre PAS par nom :
// `mac_dmg_mount`/`move_to_applications` (plus bas) traitent ce cas a la
// racine en proposant de deplacer l'app vers Applications puis en ejectant
// le .dmg — dans le cas (rare) ou l'utilisateur refuse, le volume reste
// visible ici, ce qui est le comportement attendu (mieux vaut le voir que le
// camoufler alors qu'il est toujours monte).
#[cfg(target_os = "macos")]
fn macos_volumes() -> Vec<LocalRoot> {
    let Ok(out) = std::process::Command::new("mount").output() else {
        return Vec::new();
    };
    let Ok(text) = String::from_utf8(out.stdout) else {
        return Vec::new();
    };
    text.lines()
        .filter_map(|line| {
            // Ligne type : "//user@serveur/partage on /Volumes/Nom (smbfs, ...)"
            let idx = line.find(" on /Volumes/")?;
            let rest = &line[idx + 4..]; // "/Volumes/Nom (type, options...)"
            let (path, opts) = rest.split_once(" (")?;
            let name = path.strip_prefix("/Volumes/")?;
            // Volumes caches et doublon defensif du disque de demarrage.
            if name.is_empty() || name.starts_with('.') || name.eq_ignore_ascii_case("macintosh hd")
            {
                return None;
            }
            let fstype = opts.split(',').next().unwrap_or("").trim();
            let drive_type = match fstype {
                "smbfs" | "afpfs" | "nfs" | "webdav" | "ftp" => "network",
                _ => "removable",
            };
            Some(LocalRoot {
                label: name.to_string(),
                path: format!("{path}/"),
                kind: "drive".into(),
                drive_type: drive_type.into(),
                unc: String::new(),
            })
        })
        .collect()
}

// ------------------------------------------------------------------
//  macOS : deplacer vers Applications + ejecter le .dmg
// ------------------------------------------------------------------
//
// Distribution SANS installeur (juste un .dmg a glisser dans Applications,
// cf. copiteur-macos-signature-adhoc) : si l'utilisateur lance l'app
// directement depuis le volume monte (frequent en test, avant tout
// glisser-deposer), on le detecte au demarrage et on propose de deplacer le
// bundle vers /Applications puis d'ejecter le .dmg — le pattern "Move to
// Applications" utilise par la plupart des petites apps macOS (LetsMove).

#[cfg(target_os = "macos")]
fn dmg_mount_point() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?.canonicalize().ok()?;
    let rest = exe.strip_prefix("/Volumes").ok()?;
    let name = rest.components().next()?.as_os_str().to_str()?;
    Some(PathBuf::from("/Volumes").join(name))
}

#[cfg(target_os = "macos")]
fn app_bundle_path(exe: &Path) -> Option<PathBuf> {
    exe.ancestors()
        .find(|p| p.extension().is_some_and(|e| e == "app"))
        .map(Path::to_path_buf)
}

// `None` si l'app ne tourne pas depuis un .dmg monte (cas normal, une fois
// installee dans Applications) ou hors macOS.
#[tauri::command]
pub fn mac_dmg_mount() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        dmg_mount_point().map(|p| p.to_string_lossy().into_owned())
    }
    #[cfg(not(target_os = "macos"))]
    None
}

// SYNCHRONE + `spawn_blocking` depuis la commande async ci-dessous : `ditto`
// copie tout le bundle .app (dizaines de Mo), un appel direct sur le thread
// principal gelerait l'UI le temps de la copie (meme piege que `local_roots`,
// cf. son commentaire).
#[cfg(target_os = "macos")]
fn do_move_to_applications(app: AppHandle) -> Result<(), String> {
    let exe = std::env::current_exe()
        .and_then(|p| p.canonicalize())
        .map_err(|e| e.to_string())?;
    let mount = dmg_mount_point().ok_or(tr("L'app ne tourne pas depuis un .dmg", "The app is not running from a .dmg"))?;
    let bundle = app_bundle_path(&exe).ok_or(tr("Bundle .app introuvable", ".app bundle not found"))?;
    let bundle_name = bundle.file_name().ok_or(tr("Nom de bundle introuvable", "Bundle name not found"))?;
    let dest = Path::new("/Applications").join(bundle_name);

    // Remplace une eventuelle installation precedente (comme le ferait
    // un glisser-deposer Finder qui accepte d'ecraser).
    if dest.exists() {
        std::fs::remove_dir_all(&dest)
            .map_err(|e| {
                if crate::i18n::en() {
                    format!("Unable to replace the previous version: {e}")
                } else {
                    format!("Impossible de remplacer l'ancienne version : {e}")
                }
            })?;
    }

    // `ditto` (et non une copie recursive maison) : seul outil qui
    // preserve fidelement forks de ressources, attributs etendus et
    // signature du bundle — l'outil que macOS lui-meme utilise pour ce
    // genre de copie.
    let status = std::process::Command::new("ditto")
        .arg(&bundle)
        .arg(&dest)
        .status()
        .map_err(|e| e.to_string())?;
    if !status.success() {
        return Err(tr("La copie vers Applications a échoué", "Copying to Applications failed").into());
    }

    // Relance la copie fraiche (celle-la tourne depuis /Applications, pas
    // depuis le .dmg) en lui passant le point de montage a ejecter une
    // fois demarree — nous, on est encore en train de lire depuis ce
    // .dmg a l'instant present, on ne peut pas l'ejecter nous-memes.
    std::process::Command::new("open")
        .arg("-n")
        .arg(&dest)
        .arg("--args")
        .arg(format!("--eject-dmg={}", mount.to_string_lossy()))
        .spawn()
        .map_err(|e| e.to_string())?;

    app.exit(0);
    Ok(())
}

#[tauri::command]
pub async fn move_to_applications(app: AppHandle) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err(crate::i18n::tr("Non disponible sur cette plateforme", "Not available on this platform").into())
    }
    #[cfg(target_os = "macos")]
    {
        tauri::async_runtime::spawn_blocking(move || do_move_to_applications(app))
            .await
            .map_err(|e| e.to_string())?
    }
}

// Enumeration des racines locales. ASYNC + `spawn_blocking` a dessein : les
// appels systeme aux lecteurs (surtout reseau) peuvent bloquer, et une commande
// Tauri SYNCHRONE s'execute sur le THREAD PRINCIPAL — elle y figeait toute l'UI
// (« Ne répond pas »), le temps affiche restant bloque sur « démarrage de
// rclone ». Ici le travail part sur un thread dedie : l'UI ne gele jamais.
#[tauri::command]
pub async fn local_roots(_app: AppHandle) -> Vec<LocalRoot> {
    tauri::async_runtime::spawn_blocking(collect_roots)
        .await
        .unwrap_or_default()
}

fn collect_roots() -> Vec<LocalRoot> {
    let mut roots = Vec::new();

    let home =
        std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from);

    let quick = [
        ("Desktop", tr("Bureau", "Desktop")),
        ("Documents", tr("Documents", "Documents")),
        ("Downloads", tr("Téléchargements", "Downloads")),
        ("Pictures", tr("Images", "Pictures")),
        ("Music", tr("Musique", "Music")),
        ("Videos", tr("Vidéos", "Videos")),
    ];
    if let Some(ref h) = home {
        roots.push(LocalRoot {
            label: h
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| tr("Accueil", "Home").into()),
            path: norm_dir(h),
            kind: "quick".into(),
            drive_type: String::new(),
            unc: String::new(),
        });
        for (folder, label) in quick {
            let p = h.join(folder);
            if p.is_dir() {
                roots.push(LocalRoot {
                    label: label.into(),
                    path: norm_dir(&p),
                    kind: "quick".into(),
                    drive_type: String::new(),
                    unc: String::new(),
                });
            }
        }
    }

    #[cfg(windows)]
    for c in drive_letters() {
        let dtype = drive_type(c);
        // Reseau : on NE lit PAS le nom de volume (bloquant). Le nom vient de la
        // table de connexions locale + du registre.
        let (name, unc) = if dtype == "network" {
            match unc_of(c) {
                Some(u) => (network_display(&u, c), u),
                None => (format!("{} ({}:)", tr("Lecteur réseau", "Network Drive"), c), String::new()),
            }
        } else {
            let label = volume_label(c);
            let name = if label.is_empty() {
                match dtype.as_str() {
                    "removable" => format!("{} ({}:)", tr("Lecteur amovible", "Removable Drive"), c),
                    "cdrom" => format!("{} ({}:)", tr("Lecteur CD", "CD Drive"), c),
                    _ => format!("{} ({}:)", tr("Disque local", "Local Disk"), c),
                }
            } else {
                format!("{} ({}:)", label, c)
            };
            (name, String::new())
        };
        roots.push(LocalRoot {
            label: name,
            path: format!("{}:/", c),
            kind: "drive".into(),
            drive_type: dtype,
            unc,
        });
    }
    #[cfg(target_os = "macos")]
    {
        roots.push(LocalRoot {
            label: "Macintosh HD".into(),
            path: "/".into(),
            kind: "drive".into(),
            drive_type: "fixed".into(),
            unc: String::new(),
        });
        roots.extend(macos_volumes());
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    roots.push(LocalRoot {
        label: "Racine".into(),
        path: "/".into(),
        kind: "drive".into(),
        drive_type: "fixed".into(),
        unc: String::new(),
    });

    roots
}

// ------------------------------------------------------------------
//  Serveurs memorises (config par-utilisateur, hors depot)
// ------------------------------------------------------------------
#[derive(Serialize, Deserialize, Clone)]
pub struct Server {
    pub label: String,
    pub host: String,
    pub user: String,
    pub pass: String,
    pub port: String,
    // Dossier de depart memorise (chemin ABSOLU sur le serveur, ex.
    // "/share/CACHEDEV1_DATA/Projets"). Vide = pas de dossier de depart. `default`
    // pour rester compatible avec les serveurs.json ecrits avant ce champ.
    #[serde(default, rename = "startDir")]
    pub start_dir: String,
}

fn servers_path(app: &AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| std::env::temp_dir());
    let _ = std::fs::create_dir_all(&dir);
    dir.join("serveurs.json")
}

// Forme SUR LE DISQUE d'un serveur : le mot de passe y est chiffre (`passEnc`,
// cf. vault.rs). `pass` en clair n'existe plus que dans les fichiers ecrits par
// les anciennes versions, convertis a la premiere lecture.
#[derive(Serialize, Deserialize, Clone, Default)]
struct StoredServer {
    label: String,
    host: String,
    user: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pass: String,
    #[serde(default, rename = "passEnc", skip_serializing_if = "String::is_empty")]
    pass_enc: String,
    port: String,
    #[serde(default, rename = "startDir")]
    start_dir: String,
}

fn config_dir(app: &AppHandle) -> PathBuf {
    servers_path(app)
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(std::env::temp_dir)
}

fn read_stored(app: &AppHandle) -> Vec<StoredServer> {
    std::fs::read_to_string(servers_path(app))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

// Le trousseau est inaccessible (acces refuse, trousseau verrouille) : on le
// dit une fois, et on continue sans les mots de passe chiffres — l'utilisateur
// peut les retaper, rien n'est efface.
fn vault_key(app: &AppHandle) -> Option<[u8; 32]> {
    match crate::vault::key(&config_dir(app)) {
        Ok(k) => Some(k),
        Err(e) => {
            let _ = app.emit(
                "copiteur://backend-error",
                if crate::i18n::en() {
                    format!("System keychain unavailable, passwords not decrypted — {e}")
                } else {
                    format!("Trousseau du système inaccessible, mots de passe non déchiffrés — {e}")
                },
            );
            None
        }
    }
}

fn read_servers(app: &AppHandle) -> Vec<Server> {
    let stored = read_stored(app);
    if stored.is_empty() {
        return Vec::new();
    }
    let key = vault_key(app);
    let list: Vec<Server> = stored
        .iter()
        .map(|s| Server {
            label: s.label.clone(),
            host: s.host.clone(),
            user: s.user.clone(),
            pass: if !s.pass_enc.is_empty() {
                key.as_ref()
                    .and_then(|k| crate::vault::decrypt(k, &s.pass_enc))
                    .unwrap_or_default()
            } else {
                s.pass.clone()
            },
            port: s.port.clone(),
            start_dir: s.start_dir.clone(),
        })
        .collect();
    // Conversion d'un fichier d'une ancienne version : des mots de passe en
    // clair et un trousseau disponible -> on reecrit tout de suite chiffre.
    if key.is_some() && stored.iter().any(|s| !s.pass.is_empty()) {
        write_servers(app, &list);
    }
    list
}

// Ecriture ATOMIQUE. `fs::write` tronque le fichier a zero AVANT d'ecrire : un
// crash ou une coupure de courant a cet instant laisse `serveurs.json` vide ou
// coupe en deux, et tous les serveurs memorises (avec leurs mots de passe) sont
// perdus au prochain demarrage. On ecrit donc a cote, on force le vidage sur le
// disque, puis on renomme : le rename est atomique, le fichier final est soit
// l'ancien soit le nouveau, jamais un entre-deux. Fichier prive (0600 sous Unix).
fn write_atomic(path: &Path, data: &str) -> std::io::Result<()> {
    let tmp = path.with_extension("json.tmp");
    if let Err(e) = crate::vault::write_private(&tmp, data.as_bytes()) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

/// Forme disque d'une liste de serveurs. Avec une cle : mots de passe chiffres.
/// Sans cle (trousseau refuse) : on ne PERD rien — un serveur dont on n'a pas
/// pu dechiffrer le mot de passe garde son ancien `passEnc` ; un mot de passe
/// tape pendant cette session reste en clair, faute de mieux, jusqu'a la
/// prochaine ecriture avec cle.
fn to_stored(
    list: &[Server],
    key: Option<&[u8; 32]>,
    previous: &[StoredServer],
) -> Result<Vec<StoredServer>, String> {
    list.iter()
        .map(|s| {
            let (pass, pass_enc) = match key {
                Some(k) if !s.pass.is_empty() => (String::new(), crate::vault::encrypt(k, &s.pass)?),
                Some(_) => (String::new(), String::new()),
                None => {
                    let kept = previous
                        .iter()
                        .find(|p| p.label == s.label && s.pass.is_empty())
                        .map(|p| p.pass_enc.clone())
                        .unwrap_or_default();
                    (s.pass.clone(), kept)
                }
            };
            Ok(StoredServer {
                label: s.label.clone(),
                host: s.host.clone(),
                user: s.user.clone(),
                pass,
                pass_enc,
                port: s.port.clone(),
                start_dir: s.start_dir.clone(),
            })
        })
        .collect()
}

// Un echec d'enregistrement ne doit pas etre silencieux : sinon l'utilisateur
// croit son serveur memorise et le retrouve disparu au redemarrage, sans le
// moindre indice. On previent le front, qui le journalise.
fn write_servers(app: &AppHandle, list: &[Server]) {
    let key = vault_key(app);
    let previous = if key.is_none() { read_stored(app) } else { Vec::new() };
    let res = to_stored(list, key.as_ref(), &previous)
        .and_then(|stored| serde_json::to_string_pretty(&stored).map_err(|e| e.to_string()))
        .and_then(|json| write_atomic(&servers_path(app), &json).map_err(|e| e.to_string()));
    if let Err(e) = res {
        let _ = app.emit(
            "copiteur://backend-error",
            if crate::i18n::en() {
                format!("Unable to save the servers — {e}")
            } else {
                format!("Impossible d'enregistrer les serveurs — {e}")
            },
        );
    }
}

// Commandes `async` : le premier acces au trousseau peut afficher une demande
// d'autorisation du systeme (macOS) ; une commande synchrone tournerait sur le
// thread principal et figerait la fenetre le temps de la reponse.
#[tauri::command]
pub async fn list_servers(app: AppHandle) -> Vec<Server> {
    read_servers(&app)
}

// Ajoute ou met a jour (par label) un serveur memorise.
#[tauri::command]
pub async fn save_server(app: AppHandle, server: Server) -> Vec<Server> {
    let mut list = read_servers(&app);
    if let Some(existing) = list.iter_mut().find(|s| s.label == server.label) {
        *existing = server;
    } else {
        list.push(server);
    }
    write_servers(&app, &list);
    list
}

#[tauri::command]
pub async fn delete_server(app: AppHandle, label: String) -> Vec<Server> {
    let mut list = read_servers(&app);
    list.retain(|s| s.label != label);
    write_servers(&app, &list);
    list
}

// Renomme un serveur memorise (change son `label`, qui sert aussi de cle). Le
// nom n'est qu'un libelle d'affichage : hote/user/mot de passe/port ne bougent
// pas. Si le nouveau nom est vide ou deja pris par un AUTRE serveur, on ne change
// rien (l'appelant garde alors l'ancien nom).
#[tauri::command]
pub async fn rename_server(app: AppHandle, old_label: String, new_label: String) -> Vec<Server> {
    let new_label = new_label.trim().to_string();
    let mut list = read_servers(&app);
    let taken = list
        .iter()
        .any(|s| s.label != old_label && s.label == new_label);
    if !new_label.is_empty() && !taken {
        if let Some(s) = list.iter_mut().find(|s| s.label == old_label) {
            s.label = new_label;
        }
        write_servers(&app, &list);
    }
    list
}

// ------------------------------------------------------------------
//  Elements caches (attribut Windows)
// ------------------------------------------------------------------

// Sous Unix (et en SFTP), « cache » est une CONVENTION DE NOM : le point devant.
// Sous Windows, c'est un ATTRIBUT du systeme de fichiers, absent du nom — et
// rclone ne l'expose nulle part. On le lit donc nous-memes, en FFI brut comme le
// reste du module.
//
// On considere aussi l'attribut SYSTEM : c'est ce qui masque « System Volume
// Information » ou « $Recycle.Bin » a la racine d'un disque, comme l'explorateur.
#[tauri::command]
pub fn hidden_names(dir: String, names: Vec<String>) -> Vec<String> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        extern "system" {
            fn GetFileAttributesW(path: *const u16) -> u32;
        }
        const INVALID_FILE_ATTRIBUTES: u32 = u32::MAX;
        const FILE_ATTRIBUTE_HIDDEN: u32 = 0x0000_0002;
        const FILE_ATTRIBUTE_SYSTEM: u32 = 0x0000_0004;

        let base = dir.replace('/', "\\");
        let base = base.trim_end_matches('\\');

        names
            .into_iter()
            .filter(|n| {
                let full = format!("{base}\\{n}");
                let wide: Vec<u16> = std::ffi::OsStr::new(&full)
                    .encode_wide()
                    .chain(std::iter::once(0))
                    .collect();
                let attr = unsafe { GetFileAttributesW(wide.as_ptr()) };
                attr != INVALID_FILE_ATTRIBUTES
                    && (attr & (FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM)) != 0
            })
            .collect()
    }
    #[cfg(not(windows))]
    {
        // Ailleurs, le point suffit : c'est gere cote front.
        let _ = (dir, names);
        Vec::new()
    }
}

// ------------------------------------------------------------------
//  Ouverture d'un fichier distant via une copie temporaire
// ------------------------------------------------------------------
//
// Un fichier du serveur n'est pas ouvrable tel quel : on en telecharge une copie
// dans un cache dedie, puis l'OS l'ouvre avec l'appli associee. Cycle de vie de
// ces copies (voir aussi `clean_opens`, appele au demarrage ET a la fermeture) :
//   - un SOUS-DOSSIER unique par ouverture, pour garder le NOM et l'EXTENSION
//     d'origine sans collision entre deux fichiers homonymes ;
//   - elles vivent le temps de la SESSION ;
//   - vidage integral au demarrage (rattrape les restes d'un crash ou d'une
//     fermeture brutale) et best-effort a la sortie.
// Copie JETABLE : les modifications faites dans l'appli externe ne remontent pas.

use std::sync::atomic::{AtomicU64, Ordering};

fn opens_root(app: &AppHandle) -> PathBuf {
    let base = app
        .path()
        .app_cache_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("copiteur"));
    base.join("ouvertures")
}

// Efface toutes les copies temporaires. Best-effort MAIS entree par entree : un
// `remove_dir_all` sur la racine s'arrete au PREMIER fichier verrouille (un
// document encore ouvert dans Word ou Excel sous Windows) et abandonne tout le
// reste, qui s'accumulerait alors indefiniment. On traite donc chaque ouverture
// separement : seules celles qui sont vraiment verrouillees survivent, et le
// vidage du prochain demarrage s'en chargera.
pub fn clean_opens(app: &AppHandle) {
    clean_dir(&opens_root(app));
}

fn clean_dir(root: &Path) {
    if let Ok(entries) = std::fs::read_dir(root) {
        for e in entries.flatten() {
            let p = e.path();
            let _ = if p.is_dir() {
                std::fs::remove_dir_all(&p)
            } else {
                std::fs::remove_file(&p)
            };
        }
    }
    // La racine ne part que si elle a pu etre entierement videe.
    let _ = std::fs::remove_dir(root);
}

// Coeur testable : cree un sous-dossier UNIQUE sous `root` (horodatage + compteur
// process) et le renvoie en chemin a slashs avant, termine par « / » (pret a etre
// concatene avec le nom du fichier cote front, accepte tel quel par rclone comme
// par l'ouverture OS, y compris sous Windows).
fn fresh_under(root: &Path) -> Result<String, String> {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    let dir = root.join(format!("{stamp}-{n}"));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut s = dir.to_string_lossy().replace('\\', "/");
    if !s.ends_with('/') {
        s.push('/');
    }
    Ok(s)
}

#[tauri::command]
pub fn open_cache_dir(app: AppHandle) -> Result<String, String> {
    fresh_under(&opens_root(&app))
}

#[cfg(test)]
mod open_tests {
    use super::*;

    #[test]
    fn fresh_under_cree_des_sous_dossiers_uniques() {
        let root = std::env::temp_dir().join(format!(
            "copiteur-opens-test-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let a = fresh_under(&root).expect("a");
        let b = fresh_under(&root).expect("b");
        assert_ne!(a, b, "deux ouvertures doivent donner des dossiers distincts");
        assert!(a.ends_with('/') && b.ends_with('/'));
        assert!(std::path::Path::new(&a).is_dir());
        assert!(std::path::Path::new(&b).is_dir());
        // Nettoyage = ce que fait `clean_opens`.
        clean_dir(&root);
        assert!(!std::path::Path::new(&a).exists());
        assert!(!root.exists(), "la racine videe doit partir aussi");
    }

    // Une copie encore verrouillee (document ouvert dans Word/Excel sous Windows)
    // ne doit pas faire abandonner le nettoyage des AUTRES : sinon le cache
    // grossit indefiniment. Simule ici par un dossier non modifiable (Unix).
    #[test]
    #[cfg(unix)]
    fn clean_dir_continue_malgre_une_entree_impossible_a_supprimer() {
        use std::os::unix::fs::PermissionsExt;

        let root = std::env::temp_dir().join(format!(
            "copiteur-clean-test-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let bloque = root.join("bloque");
        std::fs::create_dir_all(&bloque).unwrap();
        std::fs::write(bloque.join("ouvert.docx"), b"x").unwrap();
        // Plus le droit d'ecriture sur le dossier => son contenu est indelebile.
        std::fs::set_permissions(&bloque, std::fs::Permissions::from_mode(0o500)).unwrap();

        let libres: Vec<PathBuf> = (0..3).map(|i| root.join(format!("libre{i}"))).collect();
        for l in &libres {
            std::fs::create_dir_all(l).unwrap();
            std::fs::write(l.join("copie.pdf"), b"x").unwrap();
        }

        clean_dir(&root);

        for l in &libres {
            assert!(!l.exists(), "les copies liberables doivent partir : {l:?}");
        }
        assert!(bloque.exists(), "seule l'entree verrouillee survit");

        std::fs::set_permissions(&bloque, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::remove_dir_all(&root).unwrap();
    }

    fn srv(label: &str, pass: &str) -> Server {
        Server {
            label: label.into(),
            host: "h".into(),
            user: "u".into(),
            pass: pass.into(),
            port: "22".into(),
            start_dir: String::new(),
        }
    }

    /// Avec une cle : aucun mot de passe en clair sur le disque, et il se relit.
    #[test]
    fn les_mots_de_passe_sont_chiffres_sur_le_disque() {
        let mut key = [0u8; 32];
        getrandom::fill(&mut key).unwrap();
        let stored = to_stored(&[srv("nas", "hunter2"), srv("vide", "")], Some(&key), &[]).unwrap();
        let json = serde_json::to_string(&stored).unwrap();
        assert!(!json.contains("hunter2"), "{json}");
        assert!(!json.contains("\"pass\""), "plus de champ en clair : {json}");
        assert_eq!(crate::vault::decrypt(&key, &stored[0].pass_enc).as_deref(), Some("hunter2"));
        assert!(stored[1].pass_enc.is_empty());
    }

    /// Un fichier d'une ancienne version (mot de passe en clair) se relit.
    #[test]
    fn l_ancien_format_en_clair_se_relit() {
        let old = r#"[{"label":"nas","host":"h","user":"u","pass":"hunter2","port":"22"}]"#;
        let s: Vec<StoredServer> = serde_json::from_str(old).unwrap();
        assert_eq!(s[0].pass, "hunter2");
        assert!(s[0].pass_enc.is_empty());
    }

    /// Trousseau refuse : on ne perd pas le mot de passe chiffre d'un serveur
    /// qu'on n'a pas pu dechiffrer (il revient vide au front).
    #[test]
    fn sans_trousseau_rien_n_est_perdu() {
        let previous = vec![StoredServer {
            label: "nas".into(),
            pass_enc: "v1:abcd".into(),
            ..Default::default()
        }];
        let stored = to_stored(&[srv("nas", ""), srv("neuf", "tape")], None, &previous).unwrap();
        assert_eq!(stored[0].pass_enc, "v1:abcd");
        assert_eq!(stored[1].pass, "tape");
    }

    #[test]
    fn write_atomic_remplace_le_contenu_sans_laisser_de_tmp() {
        let dir = std::env::temp_dir().join(format!(
            "copiteur-atomic-test-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("serveurs.json");

        write_atomic(&f, "[]").unwrap();
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "[]");

        // Reecriture : l'ancien contenu est remplace d'un bloc.
        write_atomic(&f, "[{\"label\":\"nas\"}]").unwrap();
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "[{\"label\":\"nas\"}]");

        let restes: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(restes, vec!["serveurs.json"], "aucun .tmp ne doit trainer");

        std::fs::remove_dir_all(&dir).unwrap();
    }
}

// ------------------------------------------------------------------
//  Ouvrir avec... (boite de dialogue Windows "Ouvrir avec")
// ------------------------------------------------------------------
#[tauri::command]
pub fn open_with(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let native = path.replace('/', "\\");
        std::process::Command::new("rundll32.exe")
            .arg("shell32.dll,OpenAs_RunDLL")
            .arg(&native)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Err(crate::i18n::tr(
            "« Ouvrir avec » n'est disponible que sous Windows",
            "“Open with” is only available on Windows",
        )
        .into())
    }
}

// ------------------------------------------------------------------
//  Couleur d'accent systeme
// ------------------------------------------------------------------

// Windows : lit un DWORD du registre (HKEY_CURRENT_USER) en FFI brut, comme le
// reste du module (pas de crate WinRT ajoutee juste pour ca).
#[cfg(windows)]
fn hkcu_dword(subkey: &str, value: &str) -> Option<u32> {
    extern "system" {
        fn RegGetValueW(
            hkey: isize,
            sub_key: *const u16,
            value: *const u16,
            flags: u32,
            typ: *mut u32,
            data: *mut core::ffi::c_void,
            data_len: *mut u32,
        ) -> i32;
    }
    // HKEY est un handle (pointeur) : extension par ZEROS sur 64 bits. Passer
    // par `as i32` sign-etendrait en 0xFFFFFFFF80000001 => handle invalide.
    const HKEY_CURRENT_USER: isize = 0x8000_0001u32 as isize;
    const RRF_RT_REG_DWORD: u32 = 0x0000_0010;

    let wide = |s: &str| -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    };
    let (sk, v) = (wide(subkey), wide(value));
    let mut data: u32 = 0;
    let mut len: u32 = 4;
    let rc = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            sk.as_ptr(),
            v.as_ptr(),
            RRF_RT_REG_DWORD,
            std::ptr::null_mut(),
            &mut data as *mut u32 as *mut core::ffi::c_void,
            &mut len,
        )
    };
    (rc == 0).then_some(data)
}

#[tauri::command]
pub async fn get_accent_color() -> Option<String> {
    #[cfg(not(any(target_os = "macos", windows)))]
    return None;

    // macOS : `defaults` est un process externe. La commande etant `async`, un
    // `std::process::Command::output()` (synchrone) bloquerait un thread de
    // l'executor Tokio le temps de sa reponse => on passe par tokio::process.
    #[cfg(target_os = "macos")]
    {
        let idx = tokio::process::Command::new("defaults")
            .args(["read", "-g", "AppleAccentColor"])
            .output()
            .await
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .and_then(|s| s.trim().parse::<i32>().ok());
        Some(
            match idx {
                Some(-1) => "#8e8e93",
                Some(0) => "#ff3b30",
                Some(1) => "#ff9500",
                Some(2) => "#ffcc00",
                Some(3) => "#34c759",
                Some(4) => "#007aff",
                Some(5) => "#af52de",
                Some(6) => "#ff2d55",
                _ => "#007aff",
            }
            .to_string(),
        )
    }

    // Windows : le mot-cle CSS `AccentColor` ne reflete PAS l'accent systeme
    // dans WebView2 (il rend un bleu par defaut) => on lit le registre.
    //   DWM\AccentColor        : DWORD au format 0xAABBGGRR (ABGR, pas ARGB !)
    //   DWM\ColorizationColor  : DWORD au format 0xAARRGGBB (ARGB) — repli
    #[cfg(windows)]
    {
        if let Some(v) = hkcu_dword("Software\\Microsoft\\Windows\\DWM", "AccentColor") {
            let (r, g, b) = (v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF);
            return Some(format!("#{:02x}{:02x}{:02x}", r, g, b));
        }
        if let Some(v) = hkcu_dword("Software\\Microsoft\\Windows\\DWM", "ColorizationColor") {
            let (r, g, b) = ((v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF);
            return Some(format!("#{:02x}{:02x}{:02x}", r, g, b));
        }
        None
    }
}
