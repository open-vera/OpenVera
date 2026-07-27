//! Native workspace supervisor: FS notify + background git status.
//! Frontend subscribes to events instead of polling via JS timers.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use super::fs::{git_status_sync, GitChange};

const FS_DEBOUNCE: Duration = Duration::from_millis(280);
const GIT_INTERVAL: Duration = Duration::from_secs(12);
const IGNORED_DIR_NAMES: &[&str] = &[
    "node_modules",
    ".git",
    ".vera",
    "target",
    "dist",
    ".next",
    ".pnpm-store",
];

enum WatchControl {
    AddDir(PathBuf),
    Stop,
}

#[derive(Default)]
pub struct WorkspaceWatchManager {
    inner: Mutex<Option<WatchSession>>,
}

impl WorkspaceWatchManager {
    pub fn start(&self, app: AppHandle, root: String) -> Result<(), String> {
        let root_path = normalize_path(Path::new(&root));
        if !root_path.is_dir() {
            return Err(format!("not a directory: {}", root_path.display()));
        }

        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "workspace watch lock poisoned".to_string())?;

        if let Some(existing) = guard.as_ref() {
            if existing.root == root_path {
                return Ok(());
            }
            let _ = existing.control_tx.send(WatchControl::Stop);
            existing.stop.store(true, Ordering::Relaxed);
        }

        let stop = Arc::new(AtomicBool::new(false));
        let (control_tx, control_rx) = mpsc::channel();
        spawn_fs_watcher(
            app.clone(),
            root_path.clone(),
            Arc::clone(&stop),
            control_rx,
        );
        spawn_git_worker(app, root_path.clone(), Arc::clone(&stop));
        *guard = Some(WatchSession {
            root: root_path,
            stop,
            control_tx,
        });
        Ok(())
    }

    pub fn watch_dir(&self, path: String) -> Result<(), String> {
        let dir = normalize_path(Path::new(&path));
        if !dir.is_dir() {
            return Err(format!("not a directory: {}", dir.display()));
        }
        let guard = self
            .inner
            .lock()
            .map_err(|_| "workspace watch lock poisoned".to_string())?;
        let Some(session) = guard.as_ref() else {
            return Ok(());
        };
        if !dir.starts_with(&session.root) {
            return Err("path is outside workspace root".to_string());
        }
        let _ = session.control_tx.send(WatchControl::AddDir(dir));
        Ok(())
    }
}

struct WatchSession {
    root: PathBuf,
    stop: Arc<AtomicBool>,
    control_tx: Sender<WatchControl>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FsChangedPayload {
    root: String,
    /// Parent directories that should be re-listed (workspace root included).
    paths: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitStatusPayload {
    root: String,
    changes: Vec<GitChange>,
}

fn normalize_path(path: &Path) -> PathBuf {
    path.components().collect()
}

fn should_ignore_path(root: &Path, path: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return true;
    };
    relative.components().any(|component| {
        let name = component.as_os_str().to_string_lossy();
        IGNORED_DIR_NAMES.iter().any(|ignored| *ignored == name)
    })
}

fn affected_reload_path(root: &Path, path: &Path) -> Option<PathBuf> {
    if should_ignore_path(root, path) {
        return None;
    }
    let dir = if path.is_dir() {
        path.to_path_buf()
    } else {
        path.parent()?.to_path_buf()
    };
    if dir.starts_with(root) {
        Some(normalize_path(&dir))
    } else {
        None
    }
}

fn spawn_fs_watcher(
    app: AppHandle,
    root: PathBuf,
    stop: Arc<AtomicBool>,
    control_rx: mpsc::Receiver<WatchControl>,
) {
    thread::Builder::new()
        .name("partner-fs-watch".into())
        .spawn(move || {
            let (tx, rx) = mpsc::channel();
            let mut watcher = match RecommendedWatcher::new(
                move |result: Result<notify::Event, notify::Error>| {
                    let _ = tx.send(result);
                },
                notify::Config::default(),
            ) {
                Ok(watcher) => watcher,
                Err(error) => {
                    eprintln!("[WorkspaceWatch] failed to create watcher: {error}");
                    return;
                }
            };

            // Non-recursive watches avoid exploding on node_modules / huge trees.
            // Expanded folders are added from the frontend via workspace_watch_dir.
            if let Err(error) = watcher.watch(&root, RecursiveMode::NonRecursive) {
                eprintln!(
                    "[WorkspaceWatch] failed to watch {}: {error}",
                    root.display()
                );
                return;
            }

            let mut watched: HashSet<PathBuf> = HashSet::new();
            watched.insert(root.clone());

            let mut pending: HashSet<PathBuf> = HashSet::new();
            let mut last_event = Instant::now();

            while !stop.load(Ordering::Relaxed) {
                while let Ok(control) = control_rx.try_recv() {
                    match control {
                        WatchControl::Stop => {
                            stop.store(true, Ordering::Relaxed);
                            break;
                        }
                        WatchControl::AddDir(path) => {
                            let path = normalize_path(&path);
                            if !path.is_dir()
                                || !path.starts_with(&root)
                                || should_ignore_path(&root, &path)
                                || !watched.insert(path.clone())
                            {
                                continue;
                            }
                            if let Err(error) =
                                watcher.watch(&path, RecursiveMode::NonRecursive)
                            {
                                eprintln!(
                                    "[WorkspaceWatch] failed to watch {}: {error}",
                                    path.display()
                                );
                                watched.remove(&path);
                            }
                        }
                    }
                }

                match rx.recv_timeout(Duration::from_millis(120)) {
                    Ok(Ok(event)) => {
                        if matches!(
                            event.kind,
                            EventKind::Access(_) | EventKind::Other | EventKind::Any
                        ) {
                            continue;
                        }
                        for path in event.paths {
                            if let Some(parent) = affected_reload_path(&root, &path) {
                                pending.insert(parent);
                                last_event = Instant::now();
                            }
                        }
                    }
                    Ok(Err(error)) => {
                        eprintln!("[WorkspaceWatch] notify error: {error}");
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }

                if !pending.is_empty() && last_event.elapsed() >= FS_DEBOUNCE {
                    let mut paths: Vec<String> = pending
                        .drain()
                        .map(|path| path.to_string_lossy().to_string())
                        .collect();
                    paths.sort();
                    let _ = app.emit(
                        "workspace:fs-changed",
                        FsChangedPayload {
                            root: root.to_string_lossy().to_string(),
                            paths,
                        },
                    );
                }
            }
        })
        .ok();
}

fn spawn_git_worker(app: AppHandle, root: PathBuf, stop: Arc<AtomicBool>) {
    thread::Builder::new()
        .name("partner-git-watch".into())
        .spawn(move || {
            let root_str = root.to_string_lossy().to_string();
            let mut last: Option<Vec<GitChange>> = None;
            while !stop.load(Ordering::Relaxed) {
                match git_status_sync(&root_str) {
                    Ok(changes) => {
                        if last.as_ref() != Some(&changes) {
                            last = Some(changes.clone());
                            let _ = app.emit(
                                "workspace:git-status",
                                GitStatusPayload {
                                    root: root_str.clone(),
                                    changes,
                                },
                            );
                        }
                    }
                    Err(error) => {
                        eprintln!("[WorkspaceWatch] git status failed: {error}");
                    }
                }

                let started = Instant::now();
                while started.elapsed() < GIT_INTERVAL {
                    if stop.load(Ordering::Relaxed) {
                        return;
                    }
                    thread::sleep(Duration::from_millis(200));
                }
            }
        })
        .ok();
}
