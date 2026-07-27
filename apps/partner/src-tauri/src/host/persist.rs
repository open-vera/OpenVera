//! Persist Host app-state to ~/.vera/partner/app-state.json

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use serde_json::Value;

use super::state::{
    now_ms, LayoutSnapshot, PreviewSnapshot, ProjectRecord, SessionRecord, HostState,
    APP_STATE_VERSION,
};

pub fn partner_app_state_path() -> Result<PathBuf, String> {
    Ok(crate::paths::global_vera_dir()?
        .join("partner")
        .join("app-state.json"))
}

pub fn load_into(state: &mut HostState) -> Result<(), String> {
    let path = partner_app_state_path()?;
    if !path.exists() {
        return Ok(());
    }
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let value: Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    apply_persisted(state, &value);
    Ok(())
}

/// Apply a Shell-provided persist document into Host state (hard cutover sync).
pub fn apply_document(state: &mut HostState, value: &Value) {
    apply_persisted(state, value);
}

pub fn save_from(state: &HostState) -> Result<(), String> {
    let path = partner_app_state_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    // Transition-period dual-write: Pinia may have just merged richer session
    // history onto disk. Never clobber non-empty disk sessions with emptier
    // Host memory (e.g. after workspace.open before shell reloads Host).
    let mut document = state.persist_document();
    if let Ok(existing) = fs::read_to_string(&path) {
        if let Ok(disk) = serde_json::from_str::<Value>(&existing) {
            merge_sessions_preferring_richer(&mut document, &disk);
            merge_projects_union(&mut document, &disk);
        }
    }
    let content = serde_json::to_string_pretty(&document).map_err(|e| e.to_string())?;
    fs::write(path, content).map_err(|e| e.to_string())
}

fn message_count(session: &Value) -> usize {
    session
        .get("messages")
        .and_then(|v| v.as_array())
        .map(|arr| arr.len())
        .unwrap_or(0)
}

fn merge_sessions_preferring_richer(document: &mut Value, disk: &Value) {
    let Some(disk_sessions) = disk.get("sessions").and_then(|v| v.as_object()) else {
        return;
    };
    let Some(doc_sessions) = document
        .get_mut("sessions")
        .and_then(|v| v.as_object_mut())
    else {
        return;
    };
    for (id, disk_session) in disk_sessions {
        match doc_sessions.get(id) {
            None => {
                doc_sessions.insert(id.clone(), disk_session.clone());
            }
            Some(host_session) => {
                if message_count(disk_session) > message_count(host_session) {
                    doc_sessions.insert(id.clone(), disk_session.clone());
                }
            }
        }
    }
}

fn merge_projects_union(document: &mut Value, disk: &Value) {
    let Some(disk_projects) = disk.get("projects").and_then(|v| v.as_array()) else {
        return;
    };
    let Some(doc_projects) = document
        .get_mut("projects")
        .and_then(|v| v.as_array_mut())
    else {
        return;
    };
    for disk_project in disk_projects {
        let Some(disk_id) = disk_project.get("id").and_then(|v| v.as_str()) else {
            continue;
        };
        let exists = doc_projects.iter().any(|item| {
            item.get("id")
                .and_then(|v| v.as_str())
                .is_some_and(|id| id == disk_id)
        });
        if !exists {
            doc_projects.push(disk_project.clone());
        }
    }
}

fn apply_persisted(state: &mut HostState, value: &Value) {
    state.version = value
        .get("version")
        .and_then(|v| v.as_u64())
        .map(|v| v as u32)
        .unwrap_or(APP_STATE_VERSION);

    state.projects = value
        .get("projects")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| serde_json::from_value::<ProjectRecord>(item.clone()).ok())
                .collect()
        })
        .unwrap_or_default();

    state.sessions = value
        .get("sessions")
        .and_then(|v| serde_json::from_value::<HashMap<String, SessionRecord>>(v.clone()).ok())
        .unwrap_or_default();

    state.open_tab_ids = value
        .get("openTabIds")
        .and_then(|v| serde_json::from_value::<Vec<String>>(v.clone()).ok())
        .unwrap_or_default();

    state.active_tab_id = value
        .get("activeTabId")
        .and_then(|v| {
            if v.is_null() {
                Some(None)
            } else {
                v.as_str().map(|s| Some(s.to_string()))
            }
        })
        .unwrap_or(None);

    state.preview_project_id = value
        .get("previewProjectId")
        .and_then(|v| {
            if v.is_null() {
                Some(None)
            } else {
                v.as_str().map(|s| Some(s.to_string()))
            }
        })
        .unwrap_or(None);

    if let Some(layout) = value
        .get("layout")
        .and_then(|v| serde_json::from_value::<LayoutSnapshot>(v.clone()).ok())
    {
        state.layout = layout;
    }

    // Ensure preview defaults.
    for project in &mut state.projects {
        if project.preview.version == 0 {
            project.preview = PreviewSnapshot {
                version: 1,
                active_tab_id: None,
                tabs: Vec::new(),
            };
        }
    }

    state.updated_at = value
        .get("updatedAt")
        .and_then(|v| v.as_u64())
        .unwrap_or_else(now_ms);
}
