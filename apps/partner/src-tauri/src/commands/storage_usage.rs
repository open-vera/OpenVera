//! Scan Partner's on-disk footprint (sessions, run logs, perf traces, logs).
//!
//! Everything here is read-only: the panel reports sizes and locations so the
//! user can inspect or clean up in their file manager. The walk runs on a
//! blocking thread because a cold `~/.vera` can hold tens of thousands of
//! session JSONL files.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::paths::{global_vera_dir, PROJECTS_DIRNAME, RUN_LOG_DIRNAME, VERA_DIRNAME};

/// Depth guard: `~/.vera/projects/<slug>/<file>` is the deepest layout we own.
const MAX_DEPTH: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StorageScope {
    Global,
    Project,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageEntry {
    /// Stable key the UI maps to a localized label.
    pub id: String,
    pub path: String,
    pub scope: StorageScope,
    pub exists: bool,
    pub is_dir: bool,
    pub bytes: u64,
    pub files: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageUsageReport {
    pub entries: Vec<StorageEntry>,
    pub total_bytes: u64,
    pub total_files: u64,
}

pub fn scan_storage_usage(project_root: Option<String>) -> Result<StorageUsageReport, String> {
    let global = global_vera_dir()?;
    Ok(scan_storage_usage_in(&global, project_root.as_deref()))
}

fn scan_storage_usage_in(global: &Path, project_root: Option<&str>) -> StorageUsageReport {
    let mut targets: Vec<(&str, PathBuf, StorageScope)> = vec![
        (
            "app-state",
            global.join("partner").join("app-state.json"),
            StorageScope::Global,
        ),
        (
            "sessions",
            global.join(PROJECTS_DIRNAME),
            StorageScope::Global,
        ),
        (
            "run-logs",
            global.join(RUN_LOG_DIRNAME),
            StorageScope::Global,
        ),
        ("app-logs", global.join("logs"), StorageScope::Global),
        ("memory", global.join("memory"), StorageScope::Global),
        ("settings", global.join("settings.json"), StorageScope::Global),
    ];

    if let Some(root) = project_root.filter(|root| !root.is_empty()) {
        let project_vera = Path::new(root).join(VERA_DIRNAME);
        targets.push((
            "perf",
            project_vera.join("partner-perf"),
            StorageScope::Project,
        ));
        targets.push((
            "legacy-sessions",
            project_vera.join("partner-sessions.json"),
            StorageScope::Project,
        ));
        targets.push((
            "legacy-run-logs",
            project_vera.join(RUN_LOG_DIRNAME),
            StorageScope::Project,
        ));
    }

    let mut entries: Vec<StorageEntry> = targets
        .into_iter()
        .map(|(id, path, scope)| measure(id, &path, scope))
        .collect();

    entries.push(measure_sqlite(global));

    let total_bytes = entries.iter().map(|entry| entry.bytes).sum();
    let total_files = entries.iter().map(|entry| entry.files).sum();
    StorageUsageReport {
        entries,
        total_bytes,
        total_files,
    }
}

fn measure(id: &str, path: &Path, scope: StorageScope) -> StorageEntry {
    let metadata = fs::symlink_metadata(path).ok();
    let is_dir = metadata.as_ref().is_some_and(|meta| meta.is_dir());
    let (bytes, files) = match metadata.as_ref() {
        None => (0, 0),
        Some(meta) if meta.is_dir() => dir_usage(path, 0),
        Some(meta) => (meta.len(), 1),
    };

    StorageEntry {
        id: id.to_string(),
        path: path.to_string_lossy().to_string(),
        scope,
        exists: metadata.is_some(),
        is_dir,
        bytes,
        files,
    }
}

/// SQLite databases are created lazily by core (sessions, vector store), so
/// report them as one aggregate rather than guessing individual filenames.
fn measure_sqlite(global: &Path) -> StorageEntry {
    let mut bytes = 0u64;
    let mut files = 0u64;
    collect_sqlite(global, 0, &mut bytes, &mut files);

    StorageEntry {
        id: "sqlite".to_string(),
        path: global.to_string_lossy().to_string(),
        scope: StorageScope::Global,
        exists: files > 0,
        is_dir: true,
        bytes,
        files,
    }
}

fn collect_sqlite(dir: &Path, depth: usize, bytes: &mut u64, files: &mut u64) {
    if depth >= MAX_DEPTH {
        return;
    }
    let Ok(children) = fs::read_dir(dir) else {
        return;
    };
    for entry in children.filter_map(|entry| entry.ok()) {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            collect_sqlite(&path, depth + 1, bytes, files);
            continue;
        }
        if !meta.is_file() {
            continue;
        }
        if is_sqlite_file(&path) {
            *bytes += meta.len();
            *files += 1;
        }
    }
}

fn is_sqlite_file(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    // WAL / SHM sidecars belong to the database they shadow.
    [".db", ".sqlite", ".sqlite3", ".db-wal", ".db-shm"]
        .iter()
        .any(|suffix| name.ends_with(suffix))
}

/// Recursive size + file count. Symlinks are counted, never followed, so a
/// loop cannot hang the scan.
fn dir_usage(dir: &Path, depth: usize) -> (u64, u64) {
    if depth >= MAX_DEPTH {
        return (0, 0);
    }
    let Ok(children) = fs::read_dir(dir) else {
        return (0, 0);
    };

    let mut bytes = 0u64;
    let mut files = 0u64;
    for entry in children.filter_map(|entry| entry.ok()) {
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            let (child_bytes, child_files) = dir_usage(&entry.path(), depth + 1);
            bytes += child_bytes;
            files += child_files;
        } else {
            bytes += meta.len();
            files += 1;
        }
    }
    (bytes, files)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{create_dir_all, write};
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    fn temp_root(label: &str) -> PathBuf {
        let unique = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "partner-storage-{label}-{}-{unique}",
            std::process::id()
        ));
        create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn measures_a_single_file() {
        let root = temp_root("file");
        let path = root.join("a.json");
        write(&path, "12345").expect("write");

        let entry = measure("app-state", &path, StorageScope::Global);
        assert!(entry.exists);
        assert!(!entry.is_dir);
        assert_eq!(entry.bytes, 5);
        assert_eq!(entry.files, 1);
    }

    #[test]
    fn reports_missing_targets_as_empty() {
        let root = temp_root("missing");
        let entry = measure("perf", &root.join("nope"), StorageScope::Project);

        assert!(!entry.exists);
        assert_eq!(entry.bytes, 0);
        assert_eq!(entry.files, 0);
    }

    #[test]
    fn sums_nested_directories() {
        let root = temp_root("nested");
        create_dir_all(root.join("2026-07-27")).expect("day");
        write(root.join("2026-07-27/a.jsonl"), "aaa").expect("a");
        write(root.join("2026-07-27/b.jsonl"), "bbbb").expect("b");
        write(root.join("top.jsonl"), "c").expect("c");

        let entry = measure("run-logs", &root, StorageScope::Global);
        assert!(entry.is_dir);
        assert_eq!(entry.bytes, 8);
        assert_eq!(entry.files, 3);
    }

    #[test]
    fn stops_at_the_depth_guard() {
        let root = temp_root("deep");
        let mut deep = root.clone();
        for _ in 0..(MAX_DEPTH + 2) {
            deep = deep.join("d");
        }
        create_dir_all(&deep).expect("deep dirs");
        write(deep.join("buried.jsonl"), "xxxx").expect("buried");

        let (bytes, files) = dir_usage(&root, 0);
        assert_eq!(bytes, 0);
        assert_eq!(files, 0);
    }

    #[test]
    fn aggregates_sqlite_databases_only() {
        let root = temp_root("sqlite");
        create_dir_all(root.join("nested")).expect("nested");
        write(root.join("sessions.db"), "abcd").expect("db");
        write(root.join("sessions.db-wal"), "ef").expect("wal");
        write(root.join("nested/vectors.sqlite3"), "g").expect("sqlite3");
        write(root.join("notes.jsonl"), "ignored").expect("jsonl");

        let entry = measure_sqlite(&root);
        assert!(entry.exists);
        assert_eq!(entry.files, 3);
        assert_eq!(entry.bytes, 7);
    }

    #[test]
    fn sqlite_entry_is_absent_when_no_database_exists() {
        let root = temp_root("no-sqlite");
        write(root.join("a.jsonl"), "x").expect("jsonl");

        let entry = measure_sqlite(&root);
        assert!(!entry.exists);
        assert_eq!(entry.files, 0);
    }

    #[test]
    fn report_totals_add_up_and_include_project_targets() {
        let home = temp_root("report-home");
        let project = temp_root("report-project");
        create_dir_all(project.join(".vera/partner-perf")).expect("perf dir");
        write(project.join(".vera/partner-perf/2026-07-27.jsonl"), "abcde").expect("perf");
        create_dir_all(home.join("partner")).expect("partner dir");
        write(home.join("partner/app-state.json"), "xy").expect("state");
        write(home.join("sessions.db"), "1234").expect("db");

        let report = scan_storage_usage_in(&home, Some(&project.to_string_lossy()));

        let by_id = |id: &str| {
            report
                .entries
                .iter()
                .find(|entry| entry.id == id)
                .expect("entry present")
        };
        assert_eq!(by_id("app-state").bytes, 2);
        assert_eq!(by_id("perf").bytes, 5);
        assert_eq!(by_id("sqlite").bytes, 4);
        assert!(!by_id("memory").exists);
        assert_eq!(
            report.total_bytes,
            report.entries.iter().map(|entry| entry.bytes).sum::<u64>()
        );
    }

    #[test]
    fn project_targets_are_omitted_without_a_project_root() {
        let home = temp_root("report-global-only");
        let report = scan_storage_usage_in(&home, None);

        assert!(report.entries.iter().all(|entry| entry.id != "perf"));
        assert!(report
            .entries
            .iter()
            .all(|entry| entry.scope == StorageScope::Global));
    }

    #[test]
    fn an_empty_project_root_is_treated_as_absent() {
        let home = temp_root("report-empty-root");
        let report = scan_storage_usage_in(&home, Some(""));

        assert!(report.entries.iter().all(|entry| entry.id != "perf"));
    }
}
