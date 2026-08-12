//! Persist Host app-state to ~/.vera/partner/app-state.json

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use serde_json::Value;

use crate::persist_writer::{self, WriteJob};

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
    // Host owns the tab strip and the preview project; `replace_state` carries a
    // whole Shell document, so honouring those fields lets any Shell holder with
    // a stale snapshot (a hot-reloaded module generation, a slow debounced write)
    // drag the active tab back. Tab state moves only through the dedicated ops
    // (`activate_session` / `open_tab` / `close_tab` / `set_preview_project`).
    //
    // Exception: a Host that has never had a tab is still bootstrapping (fresh
    // install, or a legacy migration the Shell just computed) and must accept
    // them once.
    let bootstrapping = state.open_tab_ids.is_empty() && state.active_tab_id.is_none();
    let kept_tabs = state.open_tab_ids.clone();
    let kept_active = state.active_tab_id.clone();
    let kept_preview = state.preview_project_id.clone();

    apply_persisted(state, value);

    if !bootstrapping {
        state.open_tab_ids = kept_tabs;
        state.active_tab_id = kept_active;
        state.preview_project_id = kept_preview;
    }
}

/// Queue the app-state document for a throttled background write.
///
/// Every caller holds the `HostState` mutex, so this must not touch the disk:
/// the 22 MB read-merge-write it used to do inline made a tab activation cost
/// ~1.25 s. It snapshots the document and returns; the write lands within
/// `persist_writer::THROTTLE_INTERVAL`, and `persist_writer::flush_now` (app
/// exit / window close, wired in `lib.rs`) forces it out immediately.
///
/// Content-bearing writes (`session.update`) are deliberately *not* fast-tracked
/// past the throttle. The Shell syncs session messages on a debounce while a run
/// streams, so writing immediately for those would push the whole document to
/// disk several times a second — the stall this replaces. One coalescing window
/// for everything bounds a hard-kill loss to the last <=1.5 s of any state (tab
/// or content); a clean quit loses nothing.
pub fn save_from(state: &HostState) -> Result<(), String> {
    let path = partner_app_state_path()?;
    persist_writer::writer().schedule(WriteJob {
        path,
        document: state.persist_document(),
        merge_with_disk: Some(merge_with_disk),
    });
    Ok(())
}

/// Transition-period dual-write: Pinia may have just merged richer session
/// history onto disk. Never clobber non-empty disk sessions with emptier Host
/// memory (e.g. after workspace.open before shell reloads Host).
fn merge_with_disk(document: &mut Value, disk: &Value) {
    merge_sessions_preferring_richer(document, disk);
    merge_projects_union(document, disk);
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn document(active: &str, tabs: &[&str], preview: &str) -> Value {
        json!({
            "version": 4,
            "projects": [],
            "sessions": {},
            "openTabIds": tabs,
            "activeTabId": active,
            "previewProjectId": preview,
            "updatedAt": 1,
        })
    }

    /// A Shell `replace_state` carries the whole document. Letting it set tab
    /// state means any holder of a stale snapshot can drag the active tab back,
    /// which is what made the session tree, chat strip and file tree disagree.
    #[test]
    fn replace_state_cannot_move_tab_state_once_the_host_has_tabs() {
        let mut state = HostState::default();
        state.open_tab_ids = vec!["a".into(), "b".into()];
        state.active_tab_id = Some("a".into());
        state.preview_project_id = Some("p-current".into());

        apply_document(&mut state, &document("b", &["b", "a"], "p-stale"));

        assert_eq!(state.active_tab_id.as_deref(), Some("a"));
        assert_eq!(state.open_tab_ids, vec!["a".to_string(), "b".to_string()]);
        assert_eq!(state.preview_project_id.as_deref(), Some("p-current"));
    }

    /// A Host with no tab yet is bootstrapping (fresh install, or a legacy
    /// migration the Shell just computed) and must accept the Shell's tabs once.
    #[test]
    fn replace_state_seeds_tab_state_while_bootstrapping() {
        let mut state = HostState::default();

        apply_document(&mut state, &document("a", &["a", "b"], "p1"));

        assert_eq!(state.active_tab_id.as_deref(), Some("a"));
        assert_eq!(state.open_tab_ids, vec!["a".to_string(), "b".to_string()]);
        assert_eq!(state.preview_project_id.as_deref(), Some("p1"));
    }

    /// Content still flows through: only the tab fields are pinned.
    #[test]
    fn replace_state_still_applies_sessions() {
        let mut state = HostState::default();
        state.open_tab_ids = vec!["a".into()];
        state.active_tab_id = Some("a".into());

        let mut doc = document("z", &["z"], "p-stale");
        doc["sessions"] = json!({
            "a": {
                "id": "a",
                "projectId": null,
                "title": "kept",
                "messages": [],
                "createdAt": 1,
                "updatedAt": 2,
            }
        });
        apply_document(&mut state, &doc);

        assert_eq!(
            state.sessions.get("a").map(|s| s.title.as_str()),
            Some("kept")
        );
        assert_eq!(state.active_tab_id.as_deref(), Some("a"));
    }

    /// `save_from` runs with the `HostState` mutex held and is called by every
    /// mutation, so any filesystem work here is the 1.25 s tab switch coming
    /// back. The disk access belongs to `persist_writer`'s background thread.
    #[test]
    fn save_from_does_not_touch_the_filesystem() {
        let source = include_str!("persist.rs");
        let body = source
            .split_once("pub fn save_from")
            .expect("save_from definition")
            .1
            .split_once("\n}")
            .expect("save_from body end")
            .0;

        assert!(
            !body.contains("fs::") && !body.contains("to_string_pretty"),
            "save_from must stay off the disk: {body}"
        );
    }

    #[test]
    fn merge_keeps_the_richer_session_from_disk() {
        fn session(id: &str, messages: usize) -> Value {
            json!({
                "id": id,
                "projectId": null,
                "title": id,
                "messages": vec![json!({ "role": "user" }); messages],
                "createdAt": 1,
                "updatedAt": 2,
            })
        }

        let mut document = json!({
            "sessions": { "a": session("a", 1), "b": session("b", 5) },
            "projects": [],
        });
        let disk = json!({
            "sessions": {
                "a": session("a", 3),
                "b": session("b", 2),
                "c": session("c", 1),
            },
            "projects": [],
        });

        merge_with_disk(&mut document, &disk);

        assert_eq!(message_count(&document["sessions"]["a"]), 3, "richer disk");
        assert_eq!(message_count(&document["sessions"]["b"]), 5, "richer host");
        assert_eq!(message_count(&document["sessions"]["c"]), 1, "disk only");
    }

    #[test]
    fn merge_unions_projects_by_id() {
        let mut document = json!({
            "sessions": {},
            "projects": [{ "id": "p1", "name": "host" }],
        });
        let disk = json!({
            "sessions": {},
            "projects": [{ "id": "p1", "name": "disk" }, { "id": "p2", "name": "disk only" }],
        });

        merge_with_disk(&mut document, &disk);

        let projects = document["projects"].as_array().expect("projects");
        assert_eq!(projects.len(), 2);
        assert_eq!(projects[0]["name"], json!("host"));
        assert_eq!(projects[1]["id"], json!("p2"));
    }
}
