//! Workspace + git runtime services (Host-owned).

use std::process::Command;

use tauri::{AppHandle, Emitter};

use crate::commands::fs::{git_status_sync, list_dir};
use crate::commands::workspace_watch::WorkspaceWatchManager;

use super::protocol::{HostDomainEvent, HOST_EVENT};
use super::state::{
    normalize_path, now_ms, project_id_from_root, project_name_from_root, DirEntryView,
    GitChangeView, GitSummaryView, HostState, PreviewSnapshot, ProjectRecord,
};
use super::HostHandle;

pub async fn open_project_unlocked(
    app: &AppHandle,
    host: &HostHandle,
    watch: &WorkspaceWatchManager,
    path: &str,
) -> Result<String, String> {
    let root = normalize_path(path);
    if !std::path::Path::new(&root).is_dir() {
        return Err(format!("not a directory: {root}"));
    }

    let project_id = project_id_from_root(&root);
    host.with_mut(|state| {
        if let Some(existing) = state.project_by_id_mut(&project_id) {
            existing.root_path = root.clone();
            existing.name = project_name_from_root(&root);
            existing.updated_at = now_ms();
            existing.expanded = true;
        } else {
            state.projects.push(ProjectRecord {
                id: project_id.clone(),
                root_path: root.clone(),
                name: project_name_from_root(&root),
                expanded: true,
                preview: PreviewSnapshot {
                    version: 1,
                    active_tab_id: None,
                    tabs: Vec::new(),
                },
                updated_at: now_ms(),
            });
        }
        state.preview_project_id = Some(project_id.clone());
    });

    let entries = list_dir(root.clone()).await?;
    let views = to_views(&root, entries);
    host.with_mut(|state| {
        state.ensure_runtime(&project_id).entries = views;
    });

    watch.start(app.clone(), root.clone())?;
    refresh_git_unlocked(host, &project_id, &root).await;
    host.with_mut(|state| state.bump());
    Ok(project_id)
}

pub async fn list_directory_unlocked(
    host: &HostHandle,
    watch: &WorkspaceWatchManager,
    path: &str,
) -> Result<Vec<DirEntryView>, String> {
    let dir = normalize_path(path);
    let entries = list_dir(dir.clone()).await?;
    let views = to_views(&dir, entries);

    let project = host.with_mut(|state| {
        state
            .projects
            .iter()
            .find(|p| dir.starts_with(&normalize_path(&p.root_path)))
            .map(|p| (p.id.clone(), normalize_path(&p.root_path)))
    });

    if let Some((project_id, root_path)) = project {
        // Only the root listing is projected into Host state; deeper levels stay
        // in the command result so expanding a folder costs no state broadcast.
        if root_path == dir {
            host.with_mut(|state| {
                state.ensure_runtime(&project_id).entries = views.clone();
            });
        }
        let _ = watch.watch_dir(dir);
    }

    Ok(views)
}

pub async fn refresh_git_unlocked(host: &HostHandle, project_id: &str, root: &str) {
    host.with_mut(|state| {
        let runtime = state.ensure_runtime(project_id);
        runtime.git_summary.loading = true;
        runtime.git_summary.error.clear();
    });

    let root_owned = root.to_string();
    let changes_result =
        tauri::async_runtime::spawn_blocking(move || git_status_sync(&root_owned)).await;

    match changes_result {
        Ok(Ok(items)) => {
            let changes: Vec<GitChangeView> = items
                .into_iter()
                .map(|c| GitChangeView {
                    path: c.path,
                    status: c.status,
                })
                .collect();
            let summary = fetch_git_summary(root).await;
            host.with_mut(|state| {
                let runtime = state.ensure_runtime(project_id);
                runtime.git_changes = changes;
                runtime.git_summary = summary;
                runtime.git_summary.loading = false;
            });
        }
        Ok(Err(error)) => {
            host.with_mut(|state| {
                let runtime = state.ensure_runtime(project_id);
                runtime.git_summary.loading = false;
                runtime.git_summary.error = error;
            });
        }
        Err(error) => {
            host.with_mut(|state| {
                let runtime = state.ensure_runtime(project_id);
                runtime.git_summary.loading = false;
                runtime.git_summary.error = error.to_string();
            });
        }
    }
}

async fn fetch_git_summary(root: &str) -> GitSummaryView {
    let root = root.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let mut summary = GitSummaryView::default();
        summary.branch = git_stdout(&root, &["branch", "--show-current"]);
        summary.upstream = git_stdout(
            &root,
            &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
        );
        let rebase_path = git_stdout(&root, &["rev-parse", "--git-path", "rebase-merge"]);
        summary.rebasing =
            !rebase_path.is_empty() && std::path::Path::new(&root).join(&rebase_path).exists();
        if !summary.upstream.is_empty() {
            let counts = git_stdout(
                &root,
                &[
                    "rev-list",
                    "--left-right",
                    "--count",
                    &format!("{}...HEAD", summary.upstream),
                ],
            );
            let mut parts = counts.split_whitespace();
            summary.behind = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
            summary.ahead = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        }
        summary
    })
    .await
    .unwrap_or_default()
}

fn git_stdout(root: &str, args: &[&str]) -> String {
    let output = Command::new("git").args(["-C", root]).args(args).output();
    match output {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout).trim().to_string(),
        _ => String::new(),
    }
}

fn to_views(root: &str, entries: Vec<crate::commands::fs::DirEntry>) -> Vec<DirEntryView> {
    entries
        .into_iter()
        .map(|entry| DirEntryView {
            path: format!("{}/{}", root.trim_end_matches('/'), entry.name),
            name: entry.name,
            is_dir: entry.is_dir,
        })
        .collect()
}

pub fn emit_domain(app: &AppHandle, event: HostDomainEvent) {
    let _ = app.emit(HOST_EVENT, event);
}

/// Returns `true` when Host state changed and the Shell needs a state patch.
pub async fn handle_fs_changed_unlocked(
    app: &AppHandle,
    host: &HostHandle,
    root: &str,
    paths: &[String],
) -> bool {
    let project = host.with_mut(|state: &mut HostState| {
        state
            .project_by_root(root)
            .map(|p| (p.id.clone(), p.root_path.clone()))
    });
    let Some((project_id, root_path)) = project else {
        return false;
    };
    let root_norm = normalize_path(&root_path);
    // Only the root listing lives in Host state; deeper levels are owned by the
    // tree component, which re-lists them on demand.
    let root_changed = paths.iter().any(|path| normalize_path(path) == root_norm);
    let mut changed = false;
    if root_changed {
        if let Ok(entries) = list_dir(root_path.clone()).await {
            let views = to_views(&root_path, entries);
            changed = host.with_mut(|state| {
                let runtime = state.ensure_runtime(&project_id);
                if runtime.entries == views {
                    return false;
                }
                runtime.entries = views;
                state.bump();
                true
            });
        }
    }
    emit_domain(
        app,
        HostDomainEvent::WorkspaceFsChanged {
            root: root_path,
            paths: paths.to_vec(),
        },
    );
    changed
}
