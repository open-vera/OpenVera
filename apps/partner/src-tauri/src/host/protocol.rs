//! Partner Host IPC protocol v1 (`host.*`).

use serde::{Deserialize, Serialize};
use serde_json::Value;

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
    LlmInspect { project_root: Option<String> },
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
    /// Full snapshot when `replace` is true; otherwise a partial merge document.
    pub replace: bool,
    pub state: Value,
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
    fn command_accepts_camel_case_fields_from_shell() {
        let cmd: HostCommand = serde_json::from_value(serde_json::json!({
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
}
