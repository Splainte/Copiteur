use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, Manager};

mod edits;
mod engine;
mod hostkeys;
mod journal;
mod rclone;
mod vault;

// « Il y a du travail en cours » (transferts, dossiers en cours d'eclatement,
// editions pas renvoyees), tenu a jour par le front. Cote Rust uniquement pour
// le Cmd+Q de macOS : ce raccourci quitte l'APPLICATION, il ne passe donc pas
// par le `onCloseRequested` de la fenetre (contrairement au bouton custom, a
// Alt+F4 et au feu rouge). Sans ce garde-fou, Cmd+Q tuait les transferts en
// cours sans rien demander.
#[derive(Default)]
pub struct Busy(AtomicBool);

#[tauri::command]
fn set_busy(state: tauri::State<Busy>, busy: bool) {
    state.0.store(busy, Ordering::Relaxed);
}

// « Fermer quand meme » : l'utilisateur a vu la modale et tranche. On leve le
// garde-fou AVANT de sortir, sinon `ExitRequested` le relirait a `true` et
// annulerait la sortie — l'app resterait vivante sans fenetre.
#[tauri::command]
fn force_quit(app: tauri::AppHandle, state: tauri::State<Busy>) {
    state.0.store(false, Ordering::Relaxed);
    app.exit(0);
}

// Juste avant d'installer une mise a jour : on arrete le daemon rclone (et on
// interdit sa relance). Sous Windows, l'installeur doit pouvoir remplacer
// `rclone.exe`, impossible tant qu'il tourne ; et l'app quitte ensuite par un
// chemin qui ne passe pas par `RunEvent::Exit`, ou on le tue d'habitude.
#[tauri::command]
fn prepare_update(app: tauri::AppHandle) {
    app.state::<rclone::Rclone>().shutdown();
}

// L'installation a echoue apres `prepare_update` : rclone peut redemarrer.
#[tauri::command]
fn cancel_update(app: tauri::AppHandle) {
    app.state::<rclone::Rclone>().resume();
}

// L'entree « Tout selectionner » du menu macOS. On la garde sous la main pour
// pouvoir la GRISER quand aucun panneau n'a le focus : sans cible, l'action n'a
// aucun sens. Reste vide hors macOS (pas de barre de menus), ou la commande
// ci-dessous ne fait alors rien.
#[derive(Default)]
pub struct SelectAllItem(std::sync::Mutex<Option<tauri::menu::MenuItem<tauri::Wry>>>);

#[tauri::command]
fn set_pane_active(state: tauri::State<SelectAllItem>, active: bool) {
    if let Ok(guard) = state.0.lock() {
        if let Some(item) = guard.as_ref() {
            let _ = item.set_enabled(active);
        }
    }
}

#[cfg(target_os = "macos")]
use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
#[cfg(target_os = "windows")]
use window_vibrancy::apply_mica;

// macOS : le contenu centre "saute" (ancre dans un coin) pendant resize/zoom.
// On force chaque NSView a redessiner pendant le live resize et a ancrer sa
// couche au centre pendant l'animation de zoom. (Herite de Robloader-Tauri.)
#[cfg(target_os = "macos")]
unsafe fn stabilize_content_on_resize(view: *mut objc2::runtime::AnyObject) {
    use objc2::msg_send;

    if view.is_null() {
        return;
    }
    let _: () = msg_send![view, setLayerContentsRedrawPolicy: 2isize];
    let _: () = msg_send![view, setLayerContentsPlacement: 3isize];

    let subviews: *mut objc2::runtime::AnyObject = msg_send![view, subviews];
    if subviews.is_null() {
        return;
    }
    let count: usize = msg_send![subviews, count];
    for i in 0..count {
        let sub: *mut objc2::runtime::AnyObject = msg_send![subviews, objectAtIndex: i];
        stabilize_content_on_resize(sub);
    }
}

// Fond opaque de secours quand le materiau natif (Mica/Vibrancy) est
// indisponible (ex. Windows 10) : la page a un fond CSS 100% transparent,
// sans materiau la fenetre serait invisible/illisible.
#[cfg(any(target_os = "macos", target_os = "windows"))]
fn fallback_solid_background<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    use tauri::webview::Color;
    let dark = matches!(window.theme(), Ok(tauri::Theme::Dark));
    let color = if dark {
        Color(32, 32, 32, 255)
    } else {
        Color(243, 243, 243, 255)
    };
    let _ = window.set_background_color(Some(color));
}

// Instance relancee par `engine::move_to_applications` depuis /Applications
// (voir ce module) : elle recoit le point de montage du .dmg d'origine en
// argument et l'ejecte une fois demarree. Fait ICI (pas dans l'ancienne
// instance) car au moment de la relance, l'ancienne instance lit peut-etre
// encore des fichiers depuis ce .dmg — seule la nouvelle, deja sur
// /Applications, peut l'ejecter sereinement. Petit delai pour laisser
// l'ancienne instance finir de quitter et liberer le volume.
#[cfg(target_os = "macos")]
fn eject_dmg_if_relaunched() {
    let Some(arg) = std::env::args().find(|a| a.starts_with("--eject-dmg=")) else {
        return;
    };
    let mount = arg.trim_start_matches("--eject-dmg=").to_string();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(1));
        let _ = std::process::Command::new("hdiutil")
            .args(["detach", &mount, "-force"])
            .status();
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "macos")]
    eject_dmg_if_relaunched();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(rclone::Rclone::default())
        .manage(edits::Edits::default())
        .manage(hostkeys::HostKeys::default())
        .manage(Busy::default())
        .manage(SelectAllItem::default())
        .setup(|app| {
            // macOS : le menu PAR DEFAUT a un « Quitter » predefini, cable
            // directement sur `NSApp terminate:`. Il court-circuite la boucle
            // d'evenements, donc `ExitRequested` n'est jamais emis et Cmd+Q
            // tuait les transferts en cours sans rien demander. On reconstruit
            // le menu avec un « Quitter » CUSTOM, qu'on peut intercepter
            // (cf. `on_menu_event`). Le sous-menu Edition est reconduit tel
            // quel : sans lui, remplacer le menu ferait sauter les raccourcis
            // Cmd+C / Cmd+V / Cmd+A dans les champs de saisie.
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
                let quit = MenuItem::with_id(app, "quit", "Quitter Copiteur", true, Some("Cmd+Q"))?;
                let app_menu = Submenu::with_items(
                    app,
                    "Copiteur",
                    true,
                    &[
                        &PredefinedMenuItem::about(app, None, None)?,
                        &PredefinedMenuItem::separator(app)?,
                        &PredefinedMenuItem::services(app, None)?,
                        &PredefinedMenuItem::separator(app)?,
                        &PredefinedMenuItem::hide(app, None)?,
                        &PredefinedMenuItem::hide_others(app, None)?,
                        &PredefinedMenuItem::show_all(app, None)?,
                        &PredefinedMenuItem::separator(app)?,
                        &quit,
                    ],
                )?;
                // « Tout selectionner » est CUSTOM, pas predefini : l'action
                // native `selectAll:` surligne le TEXTE de la webview, alors
                // qu'ici on veut selectionner les FICHIERS du panneau actif.
                // Desactive au demarrage, le front l'active des qu'un panneau
                // prend le focus.
                let select_all =
                    MenuItem::with_id(app, "select_all", "Tout sélectionner", false, Some("Cmd+A"))?;
                let edit_menu = Submenu::with_items(
                    app,
                    "Édition",
                    true,
                    &[
                        &PredefinedMenuItem::undo(app, None)?,
                        &PredefinedMenuItem::redo(app, None)?,
                        &PredefinedMenuItem::separator(app)?,
                        &PredefinedMenuItem::cut(app, None)?,
                        &PredefinedMenuItem::copy(app, None)?,
                        &PredefinedMenuItem::paste(app, None)?,
                        &select_all,
                    ],
                )?;
                *app.state::<SelectAllItem>().0.lock().unwrap() = Some(select_all);
                let window_menu = Submenu::with_items(
                    app,
                    "Fenêtre",
                    true,
                    &[
                        &PredefinedMenuItem::minimize(app, None)?,
                        &PredefinedMenuItem::fullscreen(app, None)?,
                    ],
                )?;
                app.set_menu(Menu::with_items(
                    app,
                    &[&app_menu, &edit_menu, &window_menu],
                )?)?;
            }

            // Lance le daemon rclone RC (sidecar) des le demarrage.
            rclone::start(app.handle());

            // Vide les copies temporaires d'ouverture laissees par une session
            // precedente (fermeture brutale / crash).
            engine::clean_opens(app.handle());

            // Surveillance des fichiers en edition : un tick toutes les 3 s.
            // Ne fait rien tant qu'aucun fichier n'est en edition.
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_secs(3));
                edits::check_all(&handle);
            });

            let window = app.get_webview_window("main").unwrap();

            // Sur Linux, aucun materiau natif : on evite le warning "unused".
            #[cfg(not(any(target_os = "macos", target_os = "windows")))]
            let _ = &window;

            // macOS : Vibrancy natif (NSVisualEffectView).
            #[cfg(target_os = "macos")]
            if apply_vibrancy(
                &window,
                NSVisualEffectMaterial::UnderWindowBackground,
                Some(NSVisualEffectState::Active),
                None,
            )
            .is_err()
            {
                fallback_solid_background(&window);
            }

            // Corrige le "saut" du contenu pendant l'animation de zoom macOS.
            #[cfg(target_os = "macos")]
            unsafe {
                if let Ok(ns_window) = window.ns_window() {
                    let content_view: *mut objc2::runtime::AnyObject =
                        objc2::msg_send![ns_window as *mut objc2::runtime::AnyObject, contentView];
                    stabilize_content_on_resize(content_view);
                }
            }

            // Windows 11 : frameless (titlebar custom) => decorations OFF, puis Mica.
            // Windows 10 : Mica absent — on peint un fond opaque au lieu de paniquer
            // (sinon crash au lancement, cf. piege Robloader-Tauri).
            #[cfg(target_os = "windows")]
            {
                let _ = window.set_decorations(false);
                if apply_mica(&window, None).is_err() {
                    fallback_solid_background(&window);
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            engine::get_accent_color,
            engine::local_roots,
            engine::mac_dmg_mount,
            engine::move_to_applications,
            engine::list_servers,
            engine::save_server,
            engine::delete_server,
            engine::rename_server,
            engine::open_with,
            engine::hidden_names,
            engine::open_cache_dir,
            journal::journal_log,
            journal::journal_read,
            journal::journal_info,
            journal::journal_clear,
            edits::edit_register,
            edits::edit_reset,
            edits::edit_set_uploading,
            edits::edit_stop,
            edits::edit_list,
            edits::edit_poll_now,
            rclone::rc_call,
            hostkeys::host_key_check,
            hostkeys::host_key_trust,
            set_busy,
            force_quit,
            prepare_update,
            cancel_update,
            set_pane_active,
        ])
        // Menu macOS. « Quitter » : s'il reste du travail, on ne quitte pas —
        // on demande au front la meme modale que pour Alt+F4. « Tout
        // selectionner » : delegue au panneau actif, cote front.
        .on_menu_event(|app, event| match event.id().as_ref() {
            "quit" => {
                if app.state::<Busy>().0.load(Ordering::Relaxed) {
                    let _ = app.emit("copiteur://close-ask", ());
                } else {
                    app.exit(0);
                }
            }
            "select_all" => {
                let _ = app.emit("copiteur://select-all", ());
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| match event {
            // Cmd+Q (macOS) et « Quitter » du menu quittent l'APPLICATION sans
            // passer par la fermeture de fenetre : c'est ici qu'il faut les
            // rattraper. S'il reste du travail, on annule la sortie et on
            // demande au front d'afficher la meme modale que pour Alt+F4 ; le
            // bouton « Fermer quand meme » appelle `destroy()`, qui lui n'est
            // pas intercepte.
            tauri::RunEvent::ExitRequested { api, .. } => {
                if app.state::<Busy>().0.load(Ordering::Relaxed) {
                    api.prevent_exit();
                    let _ = app.emit("copiteur://close-ask", ());
                }
            }
            // Tue le daemon rclone a la fermeture pour ne pas laisser de process orphelin.
            tauri::RunEvent::Exit => {
                app.state::<rclone::Rclone>().shutdown();
                // Efface les copies temporaires d'ouverture (best-effort).
                engine::clean_opens(app);
            }
            _ => {}
        });
}
