//! Host-owned workbench state (single source of truth).

use std::collections::{HashMap, VecDeque};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const APP_STATE_VERSION: u32 = 4;
pub const SETTINGS_TAB_ID: &str = "settings";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutSnapshot {
    pub left_width: f64,
    pub preview_width: f64,
    pub left_open: bool,
    pub preview_open: bool,
    pub explorer_open: bool,
    pub editor_open: bool,
}

impl Default for LayoutSnapshot {
    fn default() -> Self {
        Self {
            left_width: 240.0,
            preview_width: 640.0,
            left_open: true,
            preview_open: true,
            explorer_open: true,
            editor_open: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSnapshot {
    pub version: u32,
    pub active_tab_id: Option<String>,
    pub tabs: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRecord {
    pub id: String,
    pub root_path: String,
    pub name: String,
    pub expanded: bool,
    pub preview: PreviewSnapshot,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecord {
    pub id: String,
    pub project_id: Option<String>,
    pub title: String,
    pub messages: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<Value>,
    /// Task id of the most recent run; the run log is named after it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_task_id: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntryView {
    pub name: String,
    pub is_dir: bool,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitChangeView {
    pub path: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitSummaryView {
    pub branch: String,
    pub upstream: String,
    pub ahead: u64,
    pub behind: u64,
    pub rebasing: bool,
    #[serde(default)]
    pub loading: bool,
    #[serde(default)]
    pub error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRuntime {
    pub entries: Vec<DirEntryView>,
    pub dir_cache: HashMap<String, Vec<DirEntryView>>,
    pub git_changes: Vec<GitChangeView>,
    pub git_summary: GitSummaryView,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedTask {
    pub id: String,
    pub session_id: String,
    pub text: String,
    pub project_root: Option<String>,
    pub llm_config: Option<Value>,
    pub agent_mode: Option<String>,
    pub created_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorRuntime {
    pub running_session_id: Option<String>,
    pub running_request_id: Option<String>,
    pub queue: VecDeque<QueuedTask>,
    pub max_concurrency: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostState {
    pub protocol_version: u32,
    pub revision: u64,
    pub version: u32,
    pub projects: Vec<ProjectRecord>,
    pub sessions: HashMap<String, SessionRecord>,
    pub open_tab_ids: Vec<String>,
    pub active_tab_id: Option<String>,
    pub preview_project_id: Option<String>,
    pub layout: LayoutSnapshot,
    pub updated_at: u64,
    /// Runtime (not always persisted): per-project tree/git.
    pub project_runtime: HashMap<String, ProjectRuntime>,
    pub orchestrator: OrchestratorRuntime,
    pub booted: bool,
}

impl Default for HostState {
    fn default() -> Self {
        Self {
            protocol_version: crate::host::protocol::HOST_PROTOCOL_VERSION,
            revision: 0,
            version: APP_STATE_VERSION,
            projects: Vec::new(),
            sessions: HashMap::new(),
            open_tab_ids: Vec::new(),
            active_tab_id: None,
            preview_project_id: None,
            layout: LayoutSnapshot::default(),
            updated_at: now_ms(),
            project_runtime: HashMap::new(),
            orchestrator: OrchestratorRuntime {
                max_concurrency: 1,
                ..Default::default()
            },
            booted: false,
        }
    }
}

impl HostState {
    pub fn bump(&mut self) {
        self.revision = self.revision.saturating_add(1);
        self.updated_at = now_ms();
    }

    pub fn persist_document(&self) -> Value {
        json!({
            "version": self.version,
            "projects": self.projects,
            "sessions": self.sessions,
            "openTabIds": self.open_tab_ids,
            "activeTabId": self.active_tab_id,
            "previewProjectId": self.preview_project_id,
            "layout": self.layout,
            "updatedAt": self.updated_at,
        })
    }

    pub fn project_by_id_mut(&mut self, id: &str) -> Option<&mut ProjectRecord> {
        self.projects.iter_mut().find(|p| p.id == id)
    }

    pub fn project_by_root(&self, root: &str) -> Option<&ProjectRecord> {
        let norm = normalize_path(root);
        self.projects
            .iter()
            .find(|p| normalize_path(&p.root_path) == norm)
    }

    pub fn ensure_runtime(&mut self, project_id: &str) -> &mut ProjectRuntime {
        self.project_runtime.entry(project_id.to_string()).or_default()
    }
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn normalize_path(path: &str) -> String {
    let mut out = path.replace('\\', "/");
    while out.ends_with('/') && out.len() > 1 {
        out.pop();
    }
    out
}

pub fn project_id_from_root(root_path: &str) -> String {
    let normalized = normalize_path(root_path);
    let mut hash: u32 = 0;
    for b in normalized.bytes() {
        hash = hash
            .wrapping_mul(31)
            .wrapping_add(u32::from(b));
    }
    format!("proj_{:x}", hash)
}

pub fn project_name_from_root(root_path: &str) -> String {
    let normalized = normalize_path(root_path);
    normalized
        .rsplit('/')
        .find(|part| !part.is_empty())
        .unwrap_or(&normalized)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_id_stable() {
        let a = project_id_from_root("/Users/me/demo/");
        let b = project_id_from_root("/Users/me/demo");
        assert_eq!(a, b);
        assert!(a.starts_with("proj_"));
    }

    #[test]
    fn persist_document_omits_runtime() {
        let mut state = HostState::default();
        state.ensure_runtime("proj_1").entries.push(DirEntryView {
            name: "src".into(),
            is_dir: true,
            path: "/tmp/src".into(),
        });
        let doc = state.persist_document();
        assert!(doc.get("projectRuntime").is_none());
        assert_eq!(doc["version"], APP_STATE_VERSION);
    }
}
