//! Partner Host IPC protocol v1 (`host.*`).

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::state::{HostState, SectionRevisions, PATCH_SECTIONS};

pub const HOST_PROTOCOL_VERSION: u32 = 1;
pub const HOST_PATCH_EVENT: &str = "host:patch";
pub const HOST_EVENT: &str = "host:event";

#[derive(Debug, Clone, Serialize, Deserialize)]
// `rename_all` only renames variants for internally tagged enums; Shell sends
// camelCase payload fields, so field renaming needs `rename_all_fields`.
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum HostCommand {
    #[serde(rename = "host.app.get_state")]
    AppGetState,
    /// Replace persisted app document (projects/sessions/tabs/layout) from Shell projection sync.
    #[serde(rename = "host.app.replace_state")]
    AppReplaceState { document: Value },
    #[serde(rename = "host.app.set_layout")]
    AppSetLayout { layout: Value },
    #[serde(rename = "host.app.set_active_tab")]
    AppSetActiveTab { tab_id: Option<String> },
    #[serde(rename = "host.app.open_tab")]
    AppOpenTab { tab_id: String },
    #[serde(rename = "host.app.close_tab")]
    AppCloseTab { tab_id: String },
    /// Open + activate a session and follow its project in one mutation.
    ///
    /// Doing this as `open_tab` then `set_preview_project` emits two patches, and
    /// the Shell projects the one in between: it restores the *previous*
    /// project's preview snapshot, and any file opened from it re-claims that
    /// project — so the tree visibly bounces back.
    #[serde(rename = "host.app.activate_session")]
    AppActivateSession { session_id: String },
    /// Persist a drag-reorder of the open tab strip.
    ///
    /// `replace_state` no longer moves tab state (see persist::apply_document), so
    /// reordering needs its own op.
    #[serde(rename = "host.app.reorder_tabs")]
    AppReorderTabs { tab_ids: Vec<String> },

    #[serde(rename = "host.workspace.open")]
    WorkspaceOpen { path: String },
    #[serde(rename = "host.workspace.close")]
    WorkspaceClose { project_id: String },
    #[serde(rename = "host.workspace.set_preview_project")]
    WorkspaceSetPreviewProject { project_id: Option<String> },
    #[serde(rename = "host.workspace.set_project_expanded")]
    WorkspaceSetProjectExpanded { project_id: String, expanded: bool },
    #[serde(rename = "host.workspace.list_dir")]
    WorkspaceListDir { path: String },
    #[serde(rename = "host.workspace.watch_dir")]
    WorkspaceWatchDir { path: String },
    #[serde(rename = "host.workspace.refresh_git")]
    WorkspaceRefreshGit { project_id: Option<String> },

    #[serde(rename = "host.session.create")]
    SessionCreate {
        project_id: Option<String>,
        title: Option<String>,
    },
    #[serde(rename = "host.session.update")]
    SessionUpdate {
        session_id: String,
        title: Option<String>,
        messages: Option<Value>,
    },
    #[serde(rename = "host.session.delete")]
    SessionDelete { session_id: String },
    #[serde(rename = "host.session.send")]
    SessionSend {
        session_id: String,
        text: String,
        #[serde(default)]
        attachments: Value,
        project_root: Option<String>,
        llm_config: Option<Value>,
        agent_mode: Option<String>,
    },
    #[serde(rename = "host.session.abort")]
    SessionAbort { session_id: String },

    #[serde(rename = "host.document.open")]
    DocumentOpen {
        project_id: String,
        path: String,
        #[serde(default)]
        language_id: Option<String>,
    },
    #[serde(rename = "host.document.close")]
    DocumentClose { project_id: String, tab_id: String },
    #[serde(rename = "host.document.set_active")]
    DocumentSetActive {
        project_id: String,
        tab_id: Option<String>,
    },
    #[serde(rename = "host.document.set_dirty")]
    DocumentSetDirty {
        project_id: String,
        tab_id: String,
        dirty: bool,
    },
    #[serde(rename = "host.document.replace_preview")]
    DocumentReplacePreview { project_id: String, preview: Value },

    #[serde(rename = "host.pty.spawn")]
    PtySpawn {
        cwd: Option<String>,
        cols: Option<u16>,
        rows: Option<u16>,
    },
    #[serde(rename = "host.pty.write")]
    PtyWrite { id: String, data: String },
    #[serde(rename = "host.pty.resize")]
    PtyResize { id: String, cols: u16, rows: u16 },
    #[serde(rename = "host.pty.kill")]
    PtyKill { id: String },

    #[serde(rename = "host.lsp.start")]
    LspStart {
        language_id: String,
        workspace_root: String,
    },
    #[serde(rename = "host.lsp.stop")]
    LspStop { language_id: String },
    /// Live LSP server state for the settings editor panel.
    #[serde(rename = "host.lsp.status")]
    LspStatus,
    #[serde(rename = "host.lsp.symbol_search")]
    LspSymbolSearch {
        workspace_root: String,
        query: String,
        language_id: Option<String>,
    },

    #[serde(rename = "host.menu.action")]
    MenuAction { action: String },

    #[serde(rename = "host.app.version")]
    AppVersion,

    #[serde(rename = "host.sidecar.status")]
    SidecarStatus,

    #[serde(rename = "host.agent.tool_approval")]
    AgentToolApproval { call_id: String, approved: bool },

    #[serde(rename = "host.fs.read")]
    FsRead { path: String },
    #[serde(rename = "host.fs.write")]
    FsWrite { path: String, content: String },
    #[serde(rename = "host.fs.append")]
    FsAppend { path: String, content: String },
    #[serde(rename = "host.fs.path_info")]
    FsPathInfo { path: String },
    #[serde(rename = "host.fs.search_files")]
    FsSearchFiles {
        root: String,
        query: String,
        limit: Option<usize>,
        include: Option<String>,
        exclude: Option<String>,
    },
    #[serde(rename = "host.fs.search_content")]
    FsSearchContent {
        root: String,
        query: String,
        limit: Option<usize>,
        include: Option<String>,
        exclude: Option<String>,
    },
    #[serde(rename = "host.fs.replace_content")]
    FsReplaceContent {
        root: String,
        query: String,
        replacement: String,
        include: Option<String>,
        exclude: Option<String>,
    },
    #[serde(rename = "host.fs.create_dir")]
    FsCreateDir { path: String },
    #[serde(rename = "host.fs.rename")]
    FsRename { from: String, to: String },
    #[serde(rename = "host.fs.delete")]
    FsDelete { path: String },
    #[serde(rename = "host.fs.copy")]
    FsCopy { from: String, to: String },
    #[serde(rename = "host.fs.reveal")]
    FsReveal { path: String },
    /// Read a binary asset (image) as a data URL for the preview panel.
    #[serde(rename = "host.fs.read_data_url")]
    FsReadDataUrl { path: String },

    /// Resolve + read an agent run log. Shell never guesses the path itself.
    #[serde(rename = "host.run_log.read")]
    RunLogRead {
        project_root: String,
        #[serde(default)]
        task_id: Option<String>,
        #[serde(default)]
        max_bytes: Option<u64>,
    },

    /// Read-only footprint scan for the settings storage panel.
    #[serde(rename = "host.storage.usage")]
    StorageUsage {
        #[serde(default)]
        project_root: Option<String>,
    },

    #[serde(rename = "host.shell.execute")]
    ShellExecute {
        cmd: String,
        args: Vec<String>,
        cwd: Option<String>,
        timeout_ms: Option<u64>,
        confirmed: Option<bool>,
    },

    #[serde(rename = "host.keychain.store")]
    KeychainStore {
        service: String,
        key: String,
        value: String,
    },
    #[serde(rename = "host.keychain.get")]
    KeychainGet { service: String, key: String },
    #[serde(rename = "host.keychain.delete")]
    KeychainDelete { service: String, key: String },
    #[serde(rename = "host.keychain.default_service")]
    KeychainDefaultService,

    #[serde(rename = "host.llm.inspect")]
    LlmInspect {
        project_root: Option<String>,
        reveal_secrets: Option<bool>,
    },
    #[serde(rename = "host.llm.save")]
    LlmSave { project_root: Option<String>, config: Value },
    #[serde(rename = "host.llm.rename_provider")]
    LlmRenameProvider {
        project_root: Option<String>,
        from_id: String,
        to_id: String,
    },
    #[serde(rename = "host.llm.save_models_routing")]
    LlmSaveModelsRouting {
        project_root: Option<String>,
        models: Value,
        routing: Value,
    },
    #[serde(rename = "host.llm.list_providers")]
    LlmListProviders { project_root: Option<String> },
    #[serde(rename = "host.llm.list_provider_models")]
    LlmListProviderModels {
        project_root: Option<String>,
        provider_id: String,
    },
    #[serde(rename = "host.llm.refresh_provider_models")]
    LlmRefreshProviderModels {
        project_root: Option<String>,
        provider_id: String,
        protocol: Option<String>,
    },
    #[serde(rename = "host.llm.test_connection")]
    LlmTestConnection {
        project_root: Option<String>,
        config: Value,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostCommandResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl HostCommandResult {
    pub fn ok(data: Value) -> Self {
        Self {
            ok: true,
            data: Some(data),
            error: None,
        }
    }

    pub fn empty_ok() -> Self {
        Self {
            ok: true,
            data: None,
            error: None,
        }
    }

    pub fn err(message: impl Into<String>) -> Self {
        Self {
            ok: false,
            data: None,
            error: Some(message.into()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostPatch {
    pub protocol_version: u32,
    pub revision: u64,
    /// The sections carried in `state` replace their counterparts wholesale;
    /// `false` means a partial merge document.
    pub replace: bool,
    /// Sections deliberately absent from `state` because the Shell's copy is
    /// already current — the Shell must carry those forward. An empty list means
    /// `state` carries every section, so "absent because unchanged" is never
    /// confused with "present and empty".
    #[serde(default)]
    pub omitted: Vec<String>,
    pub state: Value,
}

impl HostPatch {
    /// Build a patch for `state`, omitting the sections `emitted` already covers.
    ///
    /// `emitted` is the section revision set the Shell last received; `None`
    /// (fresh boot / reload) forces a complete patch.
    pub fn build(state: &HostState, replace: bool, emitted: Option<&SectionRevisions>) -> Self {
        let omitted: Vec<&str> = match emitted {
            Some(previous) => PATCH_SECTIONS
                .iter()
                .copied()
                .filter(|section| previous.get(section) == state.section_revisions.get(section))
                .collect(),
            None => Vec::new(),
        };
        Self {
            protocol_version: HOST_PROTOCOL_VERSION,
            revision: state.revision,
            replace,
            state: state.to_patch_value(&omitted),
            omitted: omitted.into_iter().map(str::to_string).collect(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum HostDomainEvent {
    #[serde(rename = "workspace.fs_changed")]
    WorkspaceFsChanged { root: String, paths: Vec<String> },
    #[serde(rename = "git.updated")]
    GitUpdated { project_id: String, root: String },
    #[serde(rename = "agent.stream")]
    AgentStream { session_id: String, event: Value },
    #[serde(rename = "menu")]
    Menu { action: String },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_roundtrip_workspace_open() {
        let cmd = HostCommand::WorkspaceOpen {
            path: "/tmp/demo".into(),
        };
        let json = serde_json::to_value(&cmd).expect("serialize");
        assert_eq!(json["op"], "host.workspace.open");
        let back: HostCommand = serde_json::from_value(json).expect("deserialize");
        match back {
            HostCommand::WorkspaceOpen { path } => assert_eq!(path, "/tmp/demo"),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn command_roundtrip_activate_session() {
        let cmd: HostCommand = serde_json::from_value(serde_json::json!({
            "op": "host.app.activate_session",
            "sessionId": "s-1",
        }))
        .expect("deserialize camelCase payload");
        match cmd {
            HostCommand::AppActivateSession { session_id } => assert_eq!(session_id, "s-1"),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn command_accepts_camel_case_fields_from_shell() {        let cmd: HostCommand = serde_json::from_value(serde_json::json!({
            "op": "host.session.send",
            "sessionId": "s-1",
            "text": "hi",
            "projectRoot": "/tmp/demo",
            "agentMode": "agent",
        }))
        .expect("deserialize camelCase payload");
        match cmd {
            HostCommand::SessionSend {
                session_id,
                text,
                project_root,
                agent_mode,
                ..
            } => {
                assert_eq!(session_id, "s-1");
                assert_eq!(text, "hi");
                assert_eq!(project_root.as_deref(), Some("/tmp/demo"));
                assert_eq!(agent_mode.as_deref(), Some("agent"));
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn domain_event_serializes_camel_case_fields() {
        let event = HostDomainEvent::GitUpdated {
            project_id: "p-1".into(),
            root: "/tmp/demo".into(),
        };
        let json = serde_json::to_value(&event).expect("serialize");
        assert_eq!(json["kind"], "git.updated");
        assert_eq!(json["projectId"], "p-1");
    }

    /// Tauri rejects event names outside `[alphanumeric-/:_]`, so a dotted name
    /// would break every `listen` call at runtime.
    #[test]
    fn event_names_are_valid_tauri_identifiers() {
        for name in [HOST_PATCH_EVENT, HOST_EVENT] {
            assert!(
                name.chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '/' | ':' | '_')),
                "invalid tauri event name: {name}"
            );
        }
    }

    fn state_with_sessions(count: usize, messages: usize, body_len: usize) -> HostState {
        let mut state = HostState::default();
        for index in 0..count {
            let id = format!("s-{index}");
            state.sessions.insert(
                id.clone(),
                super::super::state::SessionRecord {
                    id,
                    project_id: Some("proj_1".into()),
                    title: "chat".into(),
                    messages: (0..messages)
                        .map(|m| {
                            serde_json::json!({
                                "role": "assistant",
                                "content": "x".repeat(body_len),
                                "index": m,
                            })
                        })
                        .collect(),
                    last_error: None,
                    last_task_id: None,
                    created_at: 1,
                    updated_at: 2,
                },
            );
        }
        state.bump();
        state
    }

    #[test]
    fn patch_without_a_cursor_carries_every_section() {
        let state = state_with_sessions(2, 1, 8);
        let patch = HostPatch::build(&state, true, None);
        assert!(patch.omitted.is_empty());
        assert!(patch.state.get("sessions").is_some());
        assert_eq!(patch.revision, state.revision);
        assert_eq!(patch.protocol_version, HOST_PROTOCOL_VERSION);
    }

    #[test]
    fn patch_omits_sections_the_shell_already_has() {
        let mut state = state_with_sessions(2, 1, 8);
        let cursor = state.section_revisions;

        // A tab activation moves no section at all.
        state.active_tab_id = Some("s-1".into());
        state.bump();
        let patch = HostPatch::build(&state, true, Some(&cursor));
        assert_eq!(patch.omitted, vec!["sessions", "projects", "projectRuntime"]);
        assert!(patch.state.get("sessions").is_none());
        assert_eq!(patch.state["activeTabId"], serde_json::json!("s-1"));
    }

    #[test]
    fn patch_keeps_the_section_that_changed() {
        let mut state = state_with_sessions(2, 1, 8);
        let cursor = state.section_revisions;
        state
            .sessions
            .get_mut("s-0")
            .expect("session")
            .messages
            .push(serde_json::json!({ "role": "user", "content": "next" }));
        state.bump();
        let patch = HostPatch::build(&state, true, Some(&cursor));
        assert_eq!(patch.omitted, vec!["projects", "projectRuntime"]);
        assert!(patch.state.get("sessions").is_some());
    }

    /// A section that is genuinely empty must still be sent, or the Shell could
    /// never learn that the last session was deleted.
    #[test]
    fn emptied_section_is_sent_rather_than_omitted() {
        let mut state = state_with_sessions(1, 1, 8);
        let cursor = state.section_revisions;
        state.sessions.clear();
        state.bump();
        let patch = HostPatch::build(&state, true, Some(&cursor));
        assert!(!patch.omitted.contains(&"sessions".to_string()));
        assert_eq!(patch.state["sessions"], serde_json::json!({}));
    }

    #[test]
    fn patch_serializes_omitted_as_a_list() {
        let mut state = state_with_sessions(1, 1, 8);
        let cursor = state.section_revisions;
        state.bump();
        let json = serde_json::to_value(HostPatch::build(&state, true, Some(&cursor)))
            .expect("serialize patch");
        assert_eq!(json["omitted"][0], "sessions");
        assert_eq!(json["replace"], serde_json::json!(true));
        assert!(json["state"].get("sessions").is_none());
    }

    /// Payload reduction for the shape that hurt in production: many sessions,
    /// long transcripts, and a mutation that touches none of them.
    #[test]
    fn omitting_sessions_shrinks_the_patch_payload() {
        let mut state = state_with_sessions(37, 13, 4096);
        let cursor = state.section_revisions;
        let full = serde_json::to_string(&HostPatch::build(&state, true, None))
            .expect("serialize full patch")
            .len();
        state.active_tab_id = Some("s-1".into());
        state.bump();
        let slim = serde_json::to_string(&HostPatch::build(&state, true, Some(&cursor)))
            .expect("serialize slim patch")
            .len();
        println!("host patch bytes: full={full} omitted={slim} ratio={:.5}", slim as f64 / full as f64);
        assert!(
            slim * 100 < full,
            "expected >100x reduction, got full={full} slim={slim}"
        );
    }
}
