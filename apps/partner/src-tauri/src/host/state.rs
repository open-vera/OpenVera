//! Host-owned workbench state (single source of truth).

use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, VecDeque};
use std::hash::Hasher;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const APP_STATE_VERSION: u32 = 4;
pub const SETTINGS_TAB_ID: &str = "settings";

/// Patch sections that can be omitted when unchanged, by wire (camelCase) name.
pub const SECTION_SESSIONS: &str = "sessions";
pub const SECTION_PROJECTS: &str = "projects";
pub const SECTION_PROJECT_RUNTIME: &str = "projectRuntime";
pub const PATCH_SECTIONS: [&str; 3] =
    [SECTION_SESSIONS, SECTION_PROJECTS, SECTION_PROJECT_RUNTIME];

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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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

/// Monotonic revision per omittable section.
///
/// A section keeps its number while its content is unchanged, which is what lets
/// a patch leave the section out instead of re-shipping it (sessions alone are
/// ~99% of the payload).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SectionRevisions {
    pub sessions: u64,
    pub projects: u64,
    pub project_runtime: u64,
}

impl SectionRevisions {
    pub fn get(&self, section: &str) -> Option<u64> {
        match section {
            SECTION_SESSIONS => Some(self.sessions),
            SECTION_PROJECTS => Some(self.projects),
            SECTION_PROJECT_RUNTIME => Some(self.project_runtime),
            _ => None,
        }
    }
}

/// Content hashes behind [`SectionRevisions`]; never leaves the Host.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct SectionHashes {
    sessions: u64,
    projects: u64,
    project_runtime: u64,
}

impl SectionHashes {
    fn of(state: &HostState) -> Self {
        Self {
            sessions: section_hash(&state.sessions),
            projects: section_hash(&state.projects),
            project_runtime: section_hash(&state.project_runtime),
        }
    }
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
    #[serde(default)]
    pub section_revisions: SectionRevisions,
    #[serde(skip)]
    section_hashes: SectionHashes,
}

impl Default for HostState {
    fn default() -> Self {
        let mut state = Self {
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
            section_revisions: SectionRevisions::default(),
            section_hashes: SectionHashes::default(),
        };
        // Seed the hashes so an untouched state doesn't report all sections as
        // changed on its first bump.
        state.section_hashes = SectionHashes::of(&state);
        state
    }
}

impl HostState {
    pub fn bump(&mut self) {
        self.revision = self.revision.saturating_add(1);
        self.updated_at = now_ms();
        self.refresh_section_revisions();
    }

    /// Re-hash the omittable sections and advance only the ones that moved.
    ///
    /// Driven from [`HostState::bump`], so the mutate → bump → emit order every
    /// Host command already follows is what keeps patch omission honest: a
    /// mutation that skips `bump` would also be skipped by the next patch.
    pub fn refresh_section_revisions(&mut self) {
        let next = SectionHashes::of(self);
        if next.sessions != self.section_hashes.sessions {
            self.section_revisions.sessions = self.section_revisions.sessions.saturating_add(1);
        }
        if next.projects != self.section_hashes.projects {
            self.section_revisions.projects = self.section_revisions.projects.saturating_add(1);
        }
        if next.project_runtime != self.section_hashes.project_runtime {
            self.section_revisions.project_runtime =
                self.section_revisions.project_runtime.saturating_add(1);
        }
        self.section_hashes = next;
    }

    /// JSON for a `host:patch`, leaving `omitted` sections out entirely.
    ///
    /// Assembled key by key rather than `to_value` + remove, because the whole
    /// point is to never serialise an omitted `sessions` map in the first place.
    /// `patch_value_with_no_omission_matches_full_serialization` guards the key
    /// list against drift.
    pub fn to_patch_value(&self, omitted: &[&str]) -> Value {
        let mut map = serde_json::Map::new();
        map.insert("protocolVersion".into(), json!(self.protocol_version));
        map.insert("revision".into(), json!(self.revision));
        map.insert("version".into(), json!(self.version));
        if !omitted.contains(&SECTION_PROJECTS) {
            map.insert(SECTION_PROJECTS.into(), json!(self.projects));
        }
        if !omitted.contains(&SECTION_SESSIONS) {
            map.insert(SECTION_SESSIONS.into(), json!(self.sessions));
        }
        map.insert("openTabIds".into(), json!(self.open_tab_ids));
        map.insert("activeTabId".into(), json!(self.active_tab_id));
        map.insert("previewProjectId".into(), json!(self.preview_project_id));
        map.insert("layout".into(), json!(self.layout));
        map.insert("updatedAt".into(), json!(self.updated_at));
        if !omitted.contains(&SECTION_PROJECT_RUNTIME) {
            map.insert(SECTION_PROJECT_RUNTIME.into(), json!(self.project_runtime));
        }
        map.insert("orchestrator".into(), json!(self.orchestrator));
        map.insert("booted".into(), json!(self.booted));
        map.insert("sectionRevisions".into(), json!(self.section_revisions));
        Value::Object(map)
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

/// Feeds serialised bytes straight into a hasher, so a section can be
/// fingerprinted without materialising its JSON.
struct HashWriter(DefaultHasher);

impl std::io::Write for HashWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.write(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Never-repeating stand-in for a section whose hash could not be computed.
static UNHASHABLE_SECTION: AtomicU64 = AtomicU64::new(0);

/// Content hash of one patch section.
///
/// Hashed through the serialiser instead of field by field so that a new field
/// on e.g. `SessionRecord` cannot slip past change detection and leave the Shell
/// stuck with a stale section.
fn section_hash<T: Serialize>(value: &T) -> u64 {
    let mut writer = HashWriter(DefaultHasher::new());
    if serde_json::to_writer(&mut writer, value).is_err() {
        // Unreachable for these types; degrade to "always changed" rather than
        // to "never changed", which would silently freeze the section.
        return UNHASHABLE_SECTION.fetch_add(1, Ordering::Relaxed) | (1 << 63);
    }
    writer.0.finish()
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

    fn session(id: &str, messages: usize) -> SessionRecord {
        SessionRecord {
            id: id.into(),
            project_id: None,
            title: format!("chat {id}"),
            messages: (0..messages)
                .map(|i| json!({ "role": "user", "content": format!("msg {i}") }))
                .collect(),
            last_error: None,
            last_task_id: None,
            created_at: 1,
            updated_at: 1,
        }
    }

    #[test]
    fn bump_without_a_content_change_keeps_section_revisions() {
        let mut state = HostState::default();
        state.bump();
        let after_first = state.section_revisions;
        state.bump();
        state.bump();
        assert_eq!(state.section_revisions, after_first);
        assert_eq!(state.revision, 3);
    }

    #[test]
    fn session_edit_bumps_only_the_sessions_section() {
        let mut state = HostState::default();
        state.bump();
        let before = state.section_revisions;
        state.sessions.insert("s-1".into(), session("s-1", 2));
        state.bump();
        assert_eq!(state.section_revisions.sessions, before.sessions + 1);
        assert_eq!(state.section_revisions.projects, before.projects);
        assert_eq!(
            state.section_revisions.project_runtime,
            before.project_runtime
        );
    }

    #[test]
    fn message_append_is_detected_even_when_timestamps_match() {
        let mut state = HostState::default();
        state.sessions.insert("s-1".into(), session("s-1", 1));
        state.bump();
        let before = state.section_revisions.sessions;
        state
            .sessions
            .get_mut("s-1")
            .expect("session")
            .messages
            .push(json!({ "role": "assistant", "content": "hi" }));
        state.bump();
        assert_eq!(state.section_revisions.sessions, before + 1);
    }

    #[test]
    fn project_runtime_edit_bumps_only_its_own_section() {
        let mut state = HostState::default();
        state.sessions.insert("s-1".into(), session("s-1", 1));
        state.bump();
        let before = state.section_revisions;
        state.ensure_runtime("proj_1").git_changes.push(GitChangeView {
            path: "src/main.rs".into(),
            status: "M".into(),
        });
        state.bump();
        assert_eq!(state.section_revisions.sessions, before.sessions);
        assert_eq!(
            state.section_revisions.project_runtime,
            before.project_runtime + 1
        );
    }

    /// The patch value is assembled key by key, so a new `HostState` field would
    /// silently never reach the Shell. Full serialisation is the reference.
    #[test]
    fn patch_value_with_no_omission_matches_full_serialization() {
        let mut state = HostState::default();
        state.sessions.insert("s-1".into(), session("s-1", 2));
        state.ensure_runtime("proj_1");
        state.bump();
        let full = serde_json::to_value(&state).expect("serialize state");
        assert_eq!(state.to_patch_value(&[]), full);
    }

    #[test]
    fn patch_value_drops_only_the_named_sections() {
        let mut state = HostState::default();
        state.sessions.insert("s-1".into(), session("s-1", 2));
        state.bump();
        let value = state.to_patch_value(&[SECTION_SESSIONS]);
        assert!(value.get(SECTION_SESSIONS).is_none());
        assert!(value.get(SECTION_PROJECTS).is_some());
        assert!(value.get(SECTION_PROJECT_RUNTIME).is_some());
        assert_eq!(value["revision"], json!(state.revision));
        assert_eq!(
            value["sectionRevisions"]["sessions"],
            json!(state.section_revisions.sessions)
        );
    }

    #[test]
    fn section_revisions_expose_wire_names() {
        let revisions = SectionRevisions {
            sessions: 3,
            projects: 2,
            project_runtime: 1,
        };
        assert_eq!(revisions.get(SECTION_SESSIONS), Some(3));
        assert_eq!(revisions.get(SECTION_PROJECTS), Some(2));
        assert_eq!(revisions.get(SECTION_PROJECT_RUNTIME), Some(1));
        assert_eq!(revisions.get("layout"), None);
    }
}
