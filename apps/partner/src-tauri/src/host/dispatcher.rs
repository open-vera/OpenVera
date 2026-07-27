//! Dispatch `host.*` commands against HostState.

use serde_json::{json, Value};
use tauri::{AppHandle, State};

use crate::commands::pty::{pty_kill, pty_resize, pty_spawn, pty_write, PtyManager};
use crate::commands::workspace_watch::WorkspaceWatchManager;
use crate::sidecar::SidecarManager;

use super::orchestrator;
use super::persist;
use super::protocol::{HostCommand, HostCommandResult, HostDomainEvent};
use super::state::{now_ms, LayoutSnapshot, SETTINGS_TAB_ID};
use super::workspace;
use super::HostHandle;

pub async fn dispatch(
    app: &AppHandle,
    host: &HostHandle,
    watch: &State<'_, WorkspaceWatchManager>,
    sidecar: &State<'_, SidecarManager>,
    pty: &State<'_, std::sync::Arc<PtyManager>>,
    command: HostCommand,
) -> HostCommandResult {
    match command {
        HostCommand::AppGetState => {
            let state = host.lock();
            HostCommandResult::ok(serde_json::to_value(&*state).unwrap_or(json!({})))
        }
        HostCommand::AppReplaceState { document } => {
            host.with_mut(|state| {
                super::persist::apply_document(state, &document);
                state.bump();
                let _ = persist::save_from(state);
            });
            host.emit_patch(app, true);
            HostCommandResult::empty_ok()
        }
        HostCommand::AppSetLayout { layout } => {
            let mut state = host.lock();
            if let Ok(parsed) = serde_json::from_value::<LayoutSnapshot>(layout) {
                state.layout = parsed;
                state.bump();
                let _ = persist::save_from(&state);
                super::emit_state_patch(app, &state, true);
                HostCommandResult::empty_ok()
            } else {
                HostCommandResult::err("invalid layout")
            }
        }
        HostCommand::AppSetActiveTab { tab_id } => {
            let mut state = host.lock();
            state.active_tab_id = tab_id;
            state.bump();
            let _ = persist::save_from(&state);
            super::emit_state_patch(app, &state, true);
            HostCommandResult::empty_ok()
        }
        HostCommand::AppOpenTab { tab_id } => {
            let mut state = host.lock();
            if !state.open_tab_ids.contains(&tab_id) {
                state.open_tab_ids.push(tab_id.clone());
            }
            state.active_tab_id = Some(tab_id);
            state.bump();
            let _ = persist::save_from(&state);
            super::emit_state_patch(app, &state, true);
            HostCommandResult::empty_ok()
        }
        HostCommand::AppCloseTab { tab_id } => {
            let mut state = host.lock();
            state.open_tab_ids.retain(|id| id != &tab_id);
            if state.active_tab_id.as_deref() == Some(tab_id.as_str()) {
                state.active_tab_id = state.open_tab_ids.last().cloned();
            }
            state.bump();
            let _ = persist::save_from(&state);
            super::emit_state_patch(app, &state, true);
            HostCommandResult::empty_ok()
        }
        HostCommand::WorkspaceOpen { path } => {
            match workspace::open_project_unlocked(app, host, watch.inner(), &path).await {
                Ok(project_id) => {
                    let _ = host.with_mut(|state| persist::save_from(state));
                    host.emit_patch(app, true);
                    HostCommandResult::ok(json!({ "projectId": project_id }))
                }
                Err(error) => HostCommandResult::err(error),
            }
        }
        HostCommand::WorkspaceClose { project_id } => {
            let mut state = host.lock();
            state.projects.retain(|p| p.id != project_id);
            state.project_runtime.remove(&project_id);
            if state.preview_project_id.as_deref() == Some(project_id.as_str()) {
                state.preview_project_id = state.projects.first().map(|p| p.id.clone());
            }
            for session in state.sessions.values_mut() {
                if session.project_id.as_deref() == Some(project_id.as_str()) {
                    session.project_id = None;
                }
            }
            state.bump();
            let _ = persist::save_from(&state);
            super::emit_state_patch(app, &state, true);
            HostCommandResult::empty_ok()
        }
        HostCommand::WorkspaceSetPreviewProject { project_id } => {
            let mut state = host.lock();
            state.preview_project_id = project_id;
            state.bump();
            let _ = persist::save_from(&state);
            super::emit_state_patch(app, &state, true);
            HostCommandResult::empty_ok()
        }
        HostCommand::WorkspaceSetProjectExpanded {
            project_id,
            expanded,
        } => {
            let mut state = host.lock();
            if let Some(project) = state.project_by_id_mut(&project_id) {
                project.expanded = expanded;
                project.updated_at = now_ms();
                state.bump();
                let _ = persist::save_from(&state);
                super::emit_state_patch(app, &state, true);
            }
            HostCommandResult::empty_ok()
        }
        HostCommand::WorkspaceListDir { path } => {
            match workspace::list_directory_unlocked(host, watch.inner(), &path).await {
                Ok(entries) => {
                    host.emit_patch(app, true);
                    HostCommandResult::ok(json!(entries))
                }
                Err(error) => HostCommandResult::err(error),
            }
        }
        HostCommand::WorkspaceWatchDir { path } => match watch.watch_dir(path) {
            Ok(()) => HostCommandResult::empty_ok(),
            Err(error) => HostCommandResult::err(error),
        },
        HostCommand::WorkspaceRefreshGit { project_id } => {
            let target = host.with_mut(|state| {
                project_id
                    .or_else(|| state.preview_project_id.clone())
                    .and_then(|id| {
                        state
                            .projects
                            .iter()
                            .find(|p| p.id == id)
                            .map(|p| (p.id.clone(), p.root_path.clone()))
                    })
            });
            if let Some((id, root)) = target {
                workspace::refresh_git_unlocked(host, &id, &root).await;
                host.with_mut(|state| state.bump());
                host.emit_patch(app, true);
                workspace::emit_domain(
                    app,
                    HostDomainEvent::GitUpdated {
                        project_id: id,
                        root,
                    },
                );
            }
            HostCommandResult::empty_ok()
        }
        HostCommand::SessionCreate { project_id, title } => {
            let mut state = host.lock();
            let id = orchestrator::create_session(&mut state, project_id, title);
            let _ = persist::save_from(&state);
            super::emit_state_patch(app, &state, true);
            HostCommandResult::ok(json!({ "sessionId": id }))
        }
        HostCommand::SessionUpdate {
            session_id,
            title,
            messages,
        } => {
            let mut state = host.lock();
            if let Some(session) = state.sessions.get_mut(&session_id) {
                if let Some(title) = title {
                    session.title = title;
                }
                if let Some(messages) = messages {
                    if let Ok(parsed) = serde_json::from_value::<Vec<Value>>(messages) {
                        session.messages = parsed;
                    }
                }
                session.updated_at = now_ms();
                state.bump();
                let _ = persist::save_from(&state);
                super::emit_state_patch(app, &state, true);
                HostCommandResult::empty_ok()
            } else {
                HostCommandResult::err("unknown session")
            }
        }
        HostCommand::SessionDelete { session_id } => {
            let mut state = host.lock();
            state.sessions.remove(&session_id);
            state.open_tab_ids.retain(|id| id != &session_id);
            if state.active_tab_id.as_deref() == Some(session_id.as_str()) {
                state.active_tab_id = state
                    .open_tab_ids
                    .iter()
                    .rev()
                    .find(|id| *id != SETTINGS_TAB_ID)
                    .cloned();
            }
            state.bump();
            let _ = persist::save_from(&state);
            super::emit_state_patch(app, &state, true);
            HostCommandResult::empty_ok()
        }
        HostCommand::SessionSend {
            session_id,
            text,
            attachments: _,
            project_root,
            llm_config,
            agent_mode,
        } => match orchestrator::send_message(
            app,
            host,
            sidecar.inner(),
            &session_id,
            &text,
            project_root,
            llm_config,
            agent_mode,
        ) {
            Ok(data) => {
                let _ = host.with_mut(|state| persist::save_from(state));
                host.emit_patch(app, true);
                HostCommandResult::ok(data)
            }
            Err(error) => HostCommandResult::err(error),
        },
        HostCommand::SessionAbort { session_id } => {
            match orchestrator::abort_session(host, sidecar.inner(), &session_id) {
                Ok(()) => {
                    host.emit_patch(app, true);
                    HostCommandResult::empty_ok()
                }
                Err(error) => HostCommandResult::err(error),
            }
        }
        HostCommand::DocumentOpen {
            project_id,
            path,
            language_id,
        } => {
            let mut state = host.lock();
            if let Some(project) = state.project_by_id_mut(&project_id) {
                let tab_id = format!("file:{}", path);
                let exists = project
                    .preview
                    .tabs
                    .iter()
                    .any(|tab| tab.get("id").and_then(|v| v.as_str()) == Some(tab_id.as_str()));
                if !exists {
                    project.preview.tabs.push(json!({
                        "id": tab_id,
                        "filePath": path,
                        "title": path.rsplit('/').next().unwrap_or(&path),
                        "languageId": language_id,
                        "dirty": false,
                    }));
                }
                project.preview.active_tab_id = Some(format!("file:{path}"));
                project.updated_at = now_ms();
                state.preview_project_id = Some(project_id);
                state.bump();
                let _ = persist::save_from(&state);
                super::emit_state_patch(app, &state, true);
                HostCommandResult::ok(json!({ "tabId": format!("file:{path}") }))
            } else {
                HostCommandResult::err("unknown project")
            }
        }
        HostCommand::DocumentClose { project_id, tab_id } => {
            let mut state = host.lock();
            if let Some(project) = state.project_by_id_mut(&project_id) {
                project
                    .preview
                    .tabs
                    .retain(|tab| tab.get("id").and_then(|v| v.as_str()) != Some(tab_id.as_str()));
                if project.preview.active_tab_id.as_deref() == Some(tab_id.as_str()) {
                    project.preview.active_tab_id = project
                        .preview
                        .tabs
                        .last()
                        .and_then(|tab| tab.get("id"))
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                }
                state.bump();
                let _ = persist::save_from(&state);
                super::emit_state_patch(app, &state, true);
            }
            HostCommandResult::empty_ok()
        }
        HostCommand::DocumentSetActive { project_id, tab_id } => {
            let mut state = host.lock();
            if let Some(project) = state.project_by_id_mut(&project_id) {
                project.preview.active_tab_id = tab_id;
                state.bump();
                let _ = persist::save_from(&state);
                super::emit_state_patch(app, &state, true);
            }
            HostCommandResult::empty_ok()
        }
        HostCommand::DocumentSetDirty {
            project_id,
            tab_id,
            dirty,
        } => {
            let mut state = host.lock();
            if let Some(project) = state.project_by_id_mut(&project_id) {
                for tab in &mut project.preview.tabs {
                    if tab.get("id").and_then(|v| v.as_str()) == Some(tab_id.as_str()) {
                        tab.as_object_mut()
                            .map(|obj| obj.insert("dirty".into(), json!(dirty)));
                    }
                }
                state.bump();
                super::emit_state_patch(app, &state, true);
            }
            HostCommandResult::empty_ok()
        }
        HostCommand::DocumentReplacePreview { project_id, preview } => {
            let mut state = host.lock();
            if let Some(project) = state.project_by_id_mut(&project_id) {
                if let Ok(parsed) = serde_json::from_value(preview) {
                    project.preview = parsed;
                    project.updated_at = now_ms();
                    state.bump();
                    let _ = persist::save_from(&state);
                    super::emit_state_patch(app, &state, true);
                }
            }
            HostCommandResult::empty_ok()
        }
        HostCommand::PtySpawn { cwd, cols, rows } => {
            match pty_spawn(app.clone(), pty.clone(), cwd, cols, rows).await {
                Ok(result) => HostCommandResult::ok(json!(result)),
                Err(error) => HostCommandResult::err(error),
            }
        }
        HostCommand::PtyWrite { id, data } => match pty_write(pty.clone(), id, data).await {
            Ok(()) => HostCommandResult::empty_ok(),
            Err(error) => HostCommandResult::err(error),
        },
        HostCommand::PtyResize { id, cols, rows } => {
            match pty_resize(pty.clone(), id, cols, rows).await {
                Ok(()) => HostCommandResult::empty_ok(),
                Err(error) => HostCommandResult::err(error),
            }
        }
        HostCommand::PtyKill { id } => match pty_kill(pty.clone(), id).await {
            Ok(()) => HostCommandResult::empty_ok(),
            Err(error) => HostCommandResult::err(error),
        },
        HostCommand::LspStart {
            language_id,
            workspace_root,
        } => match sidecar.call_rpc(
            "lsp.start",
            json!({
                "languageId": language_id,
                "workspaceRoot": workspace_root,
            }),
        ) {
            Ok(value) => HostCommandResult::ok(value),
            Err(error) => HostCommandResult::err(error),
        },
        HostCommand::LspStop { language_id } => {
            // language_id carries server_id for host.lsp.stop
            match sidecar.call_rpc("lsp.stop", json!({ "serverId": language_id })) {
                Ok(value) => HostCommandResult::ok(value),
                Err(error) => HostCommandResult::err(error),
            }
        }
        HostCommand::LspSymbolSearch {
            workspace_root,
            query,
            language_id: _,
        } => match sidecar.call_rpc(
            "lsp.symbolSearch",
            json!({
                "workspaceRoot": workspace_root,
                "query": query,
            }),
        ) {
            Ok(value) => HostCommandResult::ok(value),
            Err(error) => HostCommandResult::err(error),
        },
        HostCommand::MenuAction { action } => {
            workspace::emit_domain(app, HostDomainEvent::Menu { action: action.clone() });
            HostCommandResult::ok(json!({ "action": action }))
        }
        other => match super::io::dispatch_io(app, sidecar, other).await {
            Some(result) => result,
            None => HostCommandResult::err("unsupported host command"),
        },
    }
}

#[cfg(test)]
mod tests {
    /// `HostHandle::lock` hands out a non-reentrant `MutexGuard`, so calling
    /// `host.emit_patch` (which locks again) from an arm that already holds the
    /// guard self-deadlocks the Host: every later command — file listing, tab
    /// switch, agent run — blocks forever. Such arms must use
    /// `super::emit_state_patch(app, &state, ..)` instead.
    #[test]
    fn arms_holding_the_state_guard_never_call_emit_patch() {
        let source = include_str!("dispatcher.rs");
        let dispatch_fn = source
            .split_once("\n#[cfg(test)]")
            .expect("test module marker")
            .0;
        let body = dispatch_fn
            .split_once("    match command {")
            .expect("dispatch match block")
            .1;
        let mut offenders = Vec::new();
        for arm in body.split("\n        HostCommand::") {
            if arm.contains("host.lock()") && arm.contains("host.emit_patch(") {
                let head = arm.lines().next().unwrap_or("<unknown>").trim();
                offenders.push(head.to_string());
            }
        }
        assert!(
            offenders.is_empty(),
            "these arms emit a patch while holding the state guard: {offenders:?}"
        );
    }
}
