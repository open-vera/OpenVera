mod commands;
mod host;
mod paths;
mod persist_writer;
mod sidecar;

use commands::pty::PtyManager;
use commands::workspace_watch::WorkspaceWatchManager;
use host::HostHandle;
use sidecar::SidecarManager;
use std::sync::Arc;
use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

const MENU_OPEN_FOLDER: &str = "open_folder";
const MENU_OPEN_SETTINGS: &str = "open_settings";
const MENU_CLOSE_TAB: &str = "close_tab";

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
                        let path = path.to_string_lossy().to_string();
                        let app_handle = app_handle.clone();
                        tauri::async_runtime::spawn(async move {
                            if let (Some(host), Some(watch)) = (
                                app_handle.try_state::<HostHandle>(),
                                app_handle.try_state::<WorkspaceWatchManager>(),
                            ) {
                                let _ = host::open_workspace_path(
                                    &app_handle,
                                    host.inner(),
                                    watch.inner(),
                                    &path,
                                )
                                .await;
                            }
                            let _ = app_handle.emit(
                                "host:event",
                                serde_json::json!({
                                    "kind": "menu",
                                    "action": "open_folder",
                                    "path": path,
                                }),
                            );
                        });
                    }
                });
            }
            MENU_OPEN_SETTINGS => {
                let _ = app.emit(
                    "host:event",
                    serde_json::json!({ "kind": "menu", "action": "open_settings" }),
                );
                // Legacy channel kept for Shell HMR / mixed binary cutover.
                let _ = app.emit("app:open-settings", ());
            }
            MENU_CLOSE_TAB => {
                let _ = app.emit(
                    "host:event",
                    serde_json::json!({ "kind": "menu", "action": "close_tab" }),
                );
                let _ = app.emit("app:close-tab", ());
            }
            _ => {}
        })
        .setup(|app| {
            let host = HostHandle::default();
            host::install_host_bridges(&app.handle(), host.clone());
            app.manage(host);

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
            app.manage(Arc::new(PtyManager::default()));
            app.manage(WorkspaceWatchManager::default());
            Ok(())
        })
        // Hard cutover: Shell may only talk to Workbench Host.
        .invoke_handler(tauri::generate_handler![
            host::host_boot,
            host::host_dispatch,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| flush_app_state(&event));
}

/// Durability boundary for the throttled app-state writer: up to
/// `persist_writer::THROTTLE_INTERVAL` of state (active tab, layout, session
/// content) only exists in memory, so every path that ends the session — quit,
/// programmatic exit, closing the last window — has to force it out.
fn flush_app_state(event: &tauri::RunEvent) {
    let ending = match event {
        tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => true,
        tauri::RunEvent::WindowEvent { event, .. } => matches!(
            event,
            tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed
        ),
        _ => false,
    };
    if ending {
        let _ = persist_writer::flush_now();
    }
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
    // Claim Cmd+W for tab close (settings included). Do not use
    // PredefinedMenuItem::close_window — it steals Cmd+W on macOS.
    let close_tab = MenuItem::with_id(
        handle,
        MENU_CLOSE_TAB,
        "Close Tab",
        true,
        Some("CmdOrCtrl+W"),
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
                    &close_tab,
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
