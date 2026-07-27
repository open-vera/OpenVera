//! Partner Workbench Host — single source of truth for app/workspace/session state.
//! Vue Shell talks only via `host_boot` / `host_dispatch` + `host:patch` / `host:event`.

mod dispatcher;
mod io;
mod orchestrator;
mod persist;
pub mod protocol;
mod state;
mod workspace;

use std::sync::{Arc, Mutex};

use protocol::{HostCommand, HostCommandResult, HostPatch, HOST_PATCH_EVENT};
use state::HostState;
use tauri::{AppHandle, Emitter, Listener, Manager, State};

use crate::commands::pty::PtyManager;
use crate::commands::workspace_watch::WorkspaceWatchManager;
use crate::sidecar::SidecarManager;

#[derive(Clone, Default)]
pub struct HostHandle {
    inner: Arc<Mutex<HostState>>,
}

impl HostHandle {
    pub fn lock(&self) -> std::sync::MutexGuard<'_, HostState> {
        self.inner.lock().expect("host state poisoned")
    }

    pub fn with_mut<R>(&self, f: impl FnOnce(&mut HostState) -> R) -> R {
        let mut state = self.lock();
        f(&mut state)
    }

    /// Emit a patch built from an already-held state guard.
    ///
    /// `Mutex` here is not reentrant: calling [`HostHandle::emit_patch`] while a
    /// guard from [`HostHandle::lock`] is still alive self-deadlocks the whole
    /// Host, so every command that mutates under its own guard must emit through
    /// this instead.
    pub fn emit_patch(&self, app: &AppHandle, replace: bool) {
        let state = self.lock();
        emit_state_patch(app, &state, replace);
    }
}

pub fn emit_state_patch(app: &AppHandle, state: &HostState, replace: bool) {
    let patch = HostPatch {
        protocol_version: protocol::HOST_PROTOCOL_VERSION,
        revision: state.revision,
        replace,
        state: serde_json::to_value(state).unwrap_or_default(),
    };
    let _ = app.emit(HOST_PATCH_EVENT, patch);
}

pub fn boot_host(app: &AppHandle, host: &HostHandle) -> Result<HostState, String> {
    let snapshot = host.with_mut(|state| {
        persist::load_into(state)?;
        state.booted = true;
        state.bump();
        Ok::<HostState, String>(state.clone())
    })?;
    host.emit_patch(app, true);
    Ok(snapshot)
}

/// Wire native watch / agent lifecycle events into Host state.
pub fn install_host_bridges(app: &AppHandle, host: HostHandle) {
    let host_fs = host.clone();
    let app_fs = app.clone();
    app.listen("workspace:fs-changed", move |event| {
        let payload = event.payload().to_string();
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&payload) else {
            return;
        };
        let root = value
            .get("root")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let paths: Vec<String> = value
            .get("paths")
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default();
        let host = host_fs.clone();
        let app = app_fs.clone();
        tauri::async_runtime::spawn(async move {
            workspace::handle_fs_changed_unlocked(&app, &host, &root, &paths).await;
            host.emit_patch(&app, true);
        });
    });

    let host_git = host.clone();
    let app_git = app.clone();
    app.listen("workspace:git-status", move |event| {
        let payload = event.payload().to_string();
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&payload) else {
            return;
        };
        let root = value
            .get("root")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let changes = value.get("changes").cloned().unwrap_or_default();
        // Emit only after the guard is released — `app.emit` can run Rust
        // listeners inline, and any of them touching Host state would deadlock.
        let updated = host_git.with_mut(|state| {
            let project = state.project_by_root(&root).map(|p| p.id.clone())?;
            let parsed =
                serde_json::from_value::<Vec<state::GitChangeView>>(changes).ok()?;
            state.ensure_runtime(&project).git_changes = parsed;
            state.bump();
            Some(project)
        });
        if let Some(project_id) = updated {
            workspace::emit_domain(
                &app_git,
                protocol::HostDomainEvent::GitUpdated {
                    project_id,
                    root,
                },
            );
        }
        host_git.emit_patch(&app_git, true);
    });

    let host_done = host.clone();
    let app_done = app.clone();
    app.listen("agent:stream:done", move |event| {
        let payload = event.payload().to_string();
        let session_id = serde_json::from_str::<serde_json::Value>(&payload)
            .ok()
            .and_then(|v| {
                v.get("instanceId")
                    .and_then(|s| s.as_str())
                    .and_then(|instance| instance.strip_prefix("host-"))
                    .map(|s| s.to_string())
            })
            .or_else(|| host_done.lock().orchestrator.running_session_id.clone());
        let Some(session_id) = session_id else {
            return;
        };
        let host = host_done.clone();
        let app = app_done.clone();
        tauri::async_runtime::spawn(async move {
            let Some(sidecar) = app.try_state::<SidecarManager>() else {
                return;
            };
            let _ = orchestrator::on_agent_done_unlocked(
                &app,
                &host,
                sidecar.inner(),
                &session_id,
            )
            .await;
            host.emit_patch(&app, true);
        });
    });

    let host_err = host.clone();
    let app_err = app.clone();
    app.listen("agent:stream:error", move |_event| {
        let host = host_err.clone();
        let app = app_err.clone();
        tauri::async_runtime::spawn(async move {
            let Some(sidecar) = app.try_state::<SidecarManager>() else {
                return;
            };
            let session_id = host.lock().orchestrator.running_session_id.clone();
            let Some(session_id) = session_id else {
                return;
            };
            let _ = orchestrator::on_agent_done_unlocked(
                &app,
                &host,
                sidecar.inner(),
                &session_id,
            )
            .await;
            host.emit_patch(&app, true);
        });
    });
}

pub async fn open_workspace_path(
    app: &AppHandle,
    host: &HostHandle,
    watch: &WorkspaceWatchManager,
    path: &str,
) -> Result<String, String> {
    let project_id = workspace::open_project_unlocked(app, host, watch, path).await?;
    let _ = host.with_mut(|state| persist::save_from(state));
    host.emit_patch(app, true);
    Ok(project_id)
}

#[tauri::command]
pub async fn host_boot(
    app: AppHandle,
    host: State<'_, HostHandle>,
) -> Result<serde_json::Value, String> {
    let snapshot = boot_host(&app, &host)?;
    serde_json::to_value(snapshot).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn host_dispatch(
    app: AppHandle,
    host: State<'_, HostHandle>,
    watch: State<'_, WorkspaceWatchManager>,
    sidecar: State<'_, SidecarManager>,
    pty: State<'_, Arc<PtyManager>>,
    command: HostCommand,
) -> Result<HostCommandResult, String> {
    Ok(dispatcher::dispatch(&app, &host, &watch, &sidecar, &pty, command).await)
}
