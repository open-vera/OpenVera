mod commands;
mod sidecar;

use sidecar::SidecarManager;
use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

const MENU_OPEN_FOLDER: &str = "open_folder";
const MENU_OPEN_SETTINGS: &str = "open_settings";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .menu(build_menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            MENU_OPEN_FOLDER => {
                let app_handle = app.clone();
                app.dialog().file().pick_folder(move |folder| {
                    let Some(folder) = folder else {
                        return;
                    };
                    if let Some(path) = folder.as_path() {
                        let _ = app_handle.emit(
                            "workspace:open-folder",
                            serde_json::json!({
                                "path": path.to_string_lossy().to_string(),
                            }),
                        );
                    }
                });
            }
            MENU_OPEN_SETTINGS => {
                let _ = app.emit("app:open-settings", ());
            }
            _ => {}
        })
        .setup(|app| {
            let sidecar = SidecarManager::try_spawn(&app.handle());
            if let Ok(info) = sidecar.info() {
                if !info.running {
                    let _ = app.emit(
                        "sidecar:unavailable",
                        serde_json::json!({
                            "error": info.error,
                            "needsNodeInstall": info.needs_node_install,
                        }),
                    );
                }
            }
            app.manage(sidecar);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_app_version,
            commands::fs::read_file,
            commands::fs::write_file,
            commands::fs::append_file,
            commands::fs::path_info,
            commands::fs::list_dir,
            commands::fs::search_files,
            commands::fs::search_content,
            commands::fs::replace_content,
            commands::fs::git_status,
            commands::shell::execute_shell,
            commands::keychain::store_secret,
            commands::keychain::get_secret,
            commands::keychain::delete_secret,
            commands::keychain::default_service_name,
            commands::storage::storage_ping,
            commands::storage::load_partner_sessions,
            commands::storage::save_partner_sessions,
            commands::agent::agent_run,
            commands::agent::agent_abort,
            commands::agent::agent_tool_approval,
            commands::agent::sidecar_status,
            commands::agent::inspect_llm_config,
            commands::agent::save_vera_llm_config,
            commands::agent::list_llm_providers,
            commands::agent::list_llm_provider_models,
            commands::agent::refresh_llm_provider_models,
            commands::agent::test_llm_connection,
            commands::lsp::lsp_start,
            commands::lsp::lsp_stop,
            commands::lsp::lsp_symbol_search,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn build_menu(handle: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let pkg_info = handle.package_info();
    let config = handle.config();
    let about_metadata = AboutMetadata {
        name: Some(pkg_info.name.clone()),
        version: Some(pkg_info.version.to_string()),
        copyright: config.bundle.copyright.clone(),
        authors: config
            .bundle
            .publisher
            .clone()
            .map(|publisher| vec![publisher]),
        ..Default::default()
    };
    let open_folder = MenuItem::with_id(
        handle,
        MENU_OPEN_FOLDER,
        "Open Folder…",
        true,
        Some("CmdOrCtrl+O"),
    )?;
    let open_settings = MenuItem::with_id(
        handle,
        MENU_OPEN_SETTINGS,
        "Settings…",
        true,
        Some("CmdOrCtrl+,"),
    )?;

    Menu::with_items(
        handle,
        &[
            #[cfg(target_os = "macos")]
            &Submenu::with_items(
                handle,
                pkg_info.name.clone(),
                true,
                &[
                    &PredefinedMenuItem::about(handle, None, Some(about_metadata))?,
                    &PredefinedMenuItem::separator(handle)?,
                    &open_settings,
                    &PredefinedMenuItem::separator(handle)?,
                    &PredefinedMenuItem::services(handle, None)?,
                    &PredefinedMenuItem::separator(handle)?,
                    &PredefinedMenuItem::hide(handle, None)?,
                    &PredefinedMenuItem::hide_others(handle, None)?,
                    &PredefinedMenuItem::separator(handle)?,
                    &PredefinedMenuItem::quit(handle, None)?,
                ],
            )?,
            &Submenu::with_items(
                handle,
                "File",
                true,
                &[
                    &open_folder,
                    &PredefinedMenuItem::separator(handle)?,
                    #[cfg(not(target_os = "macos"))]
                    &open_settings,
                    #[cfg(not(target_os = "macos"))]
                    &PredefinedMenuItem::separator(handle)?,
                    &PredefinedMenuItem::close_window(handle, None)?,
                    #[cfg(not(target_os = "macos"))]
                    &PredefinedMenuItem::quit(handle, None)?,
                ],
            )?,
            &Submenu::with_items(
                handle,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(handle, None)?,
                    &PredefinedMenuItem::redo(handle, None)?,
                    &PredefinedMenuItem::separator(handle)?,
                    &PredefinedMenuItem::cut(handle, None)?,
                    &PredefinedMenuItem::copy(handle, None)?,
                    &PredefinedMenuItem::paste(handle, None)?,
                    &PredefinedMenuItem::select_all(handle, None)?,
                ],
            )?,
            #[cfg(target_os = "macos")]
            &Submenu::with_items(
                handle,
                "View",
                true,
                &[&PredefinedMenuItem::fullscreen(handle, None)?],
            )?,
            &Submenu::with_items(
                handle,
                "Window",
                true,
                &[
                    &PredefinedMenuItem::minimize(handle, None)?,
                    &PredefinedMenuItem::maximize(handle, None)?,
                    #[cfg(target_os = "macos")]
                    &PredefinedMenuItem::separator(handle)?,
                    &PredefinedMenuItem::close_window(handle, None)?,
                ],
            )?,
            &Submenu::with_items(
                handle,
                "Help",
                true,
                &[
                    #[cfg(not(target_os = "macos"))]
                    &PredefinedMenuItem::about(handle, None, Some(about_metadata))?,
                ],
            )?,
        ],
    )
}
