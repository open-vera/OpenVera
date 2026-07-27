//! Locate and read Partner agent run logs.
//!
//! Shell must never compute the log path itself: the file name is a task id
//! and the directory is a UTC day, so any client-side guess breaks after a
//! restart (task id lost) or across UTC midnight (wrong day). The host owns
//! resolution and falls back to the newest log for the project.

use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::Serialize;

use crate::paths::{run_log_project_dir, run_log_segment, RUN_LOG_DIRNAME, VERA_DIRNAME};

const DEFAULT_MAX_BYTES: u64 = 400_000;
const MAX_ALLOWED_BYTES: u64 = 8_000_000;
const LOG_EXTENSION: &str = "jsonl";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RunLogSource {
    /// Found under `~/.vera/partner-runs/<project-slug>/`.
    Global,
    /// Found under the pre-migration `<project>/.vera/partner-runs/`.
    LegacyProject,
    /// Nothing on disk yet; `path` is where logs will appear.
    Missing,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunLogView {
    pub path: String,
    pub exists: bool,
    pub content: String,
    pub truncated: bool,
    pub total_bytes: u64,
    pub source: RunLogSource,
}

pub fn read_run_log(
    project_root: String,
    task_id: Option<String>,
    max_bytes: Option<u64>,
) -> Result<RunLogView, String> {
    let global_dir = run_log_project_dir(&project_root)?;
    // A symlinked project root (macOS /tmp, worktrees) canonicalizes to a
    // different slug than the raw path the sidecar may have written under.
    let canonical_dir = fs::canonicalize(&project_root)
        .ok()
        .map(|canonical| canonical.to_string_lossy().to_string())
        .filter(|canonical| canonical != &project_root)
        .and_then(|canonical| run_log_project_dir(&canonical).ok());
    let legacy_dir = Path::new(&project_root)
        .join(VERA_DIRNAME)
        .join(RUN_LOG_DIRNAME);

    let task_id = task_id.filter(|id| !id.is_empty());
    let limit = max_bytes
        .unwrap_or(DEFAULT_MAX_BYTES)
        .clamp(1, MAX_ALLOWED_BYTES);

    let mut roots: Vec<&PathBuf> = vec![&global_dir];
    if let Some(dir) = canonical_dir.as_ref() {
        roots.push(dir);
    }
    roots.push(&legacy_dir);
    let legacy_index = roots.len() - 1;

    let Some((path, source)) = resolve_in(&roots, task_id.as_deref()).map(|(path, index)| {
        let source = if index == legacy_index {
            RunLogSource::LegacyProject
        } else {
            RunLogSource::Global
        };
        (path, source)
    }) else {
        return Ok(RunLogView {
            path: global_dir.to_string_lossy().to_string(),
            exists: false,
            content: String::new(),
            truncated: false,
            total_bytes: 0,
            source: RunLogSource::Missing,
        });
    };

    let (content, truncated, total_bytes) = read_tail(&path, limit)?;
    Ok(RunLogView {
        path: path.to_string_lossy().to_string(),
        exists: true,
        content,
        truncated,
        total_bytes,
        source,
    })
}

/// Return the first matching log across `roots`, plus the index of the root it
/// came from so callers can label the source.
fn resolve_in(roots: &[&PathBuf], task_id: Option<&str>) -> Option<(PathBuf, usize)> {
    for (index, root) in roots.iter().enumerate() {
        let found = match task_id {
            Some(id) => find_task_log(root, id),
            None => find_newest_log(root),
        };
        if let Some(path) = found {
            return Some((path, index));
        }
    }
    None
}

/// A task log lives in `<root>/<utc-day>/<task-id>.jsonl`. The day is unknown
/// here (the run may predate today), so scan every day directory, newest first.
fn find_task_log(root: &Path, task_id: &str) -> Option<PathBuf> {
    let file_name = format!("{}.{LOG_EXTENSION}", run_log_segment(task_id));

    let direct = root.join(&file_name);
    if direct.is_file() {
        return Some(direct);
    }

    let mut day_dirs: Vec<(PathBuf, SystemTime)> = fs::read_dir(root)
        .ok()?
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.path().is_dir())
        .map(|entry| (entry.path(), modified_at(&entry.path())))
        .collect();
    day_dirs.sort_by(|a, b| b.1.cmp(&a.1));

    day_dirs
        .into_iter()
        .map(|(dir, _)| dir.join(&file_name))
        .find(|candidate| candidate.is_file())
}

/// Newest `.jsonl` directly under `root` or one level below (the day dirs).
fn find_newest_log(root: &Path) -> Option<PathBuf> {
    let mut best: Option<(PathBuf, SystemTime)> = None;
    let mut consider = |path: PathBuf| {
        if path.extension().and_then(|ext| ext.to_str()) != Some(LOG_EXTENSION) {
            return;
        }
        let stamp = modified_at(&path);
        if best.as_ref().is_none_or(|(_, current)| stamp > *current) {
            best = Some((path, stamp));
        }
    };

    for entry in fs::read_dir(root).ok()?.filter_map(|entry| entry.ok()) {
        let path = entry.path();
        if path.is_dir() {
            let Ok(children) = fs::read_dir(&path) else {
                continue;
            };
            for child in children.filter_map(|child| child.ok()) {
                consider(child.path());
            }
        } else {
            consider(path);
        }
    }

    best.map(|(path, _)| path)
}

fn modified_at(path: &Path) -> SystemTime {
    fs::metadata(path)
        .and_then(|meta| meta.modified())
        .unwrap_or(SystemTime::UNIX_EPOCH)
}

/// Read at most `limit` bytes from the end of the file, starting on a line
/// boundary so the caller never sees a half JSONL record or a split codepoint.
fn read_tail(path: &Path, limit: u64) -> Result<(String, bool, u64), String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let total_bytes = file
        .metadata()
        .map_err(|error| error.to_string())?
        .len();

    if total_bytes <= limit {
        let mut content = String::new();
        file.read_to_string(&mut content)
            .map_err(|error| error.to_string())?;
        return Ok((content, false, total_bytes));
    }

    file.seek(SeekFrom::Start(total_bytes - limit))
        .map_err(|error| error.to_string())?;
    let mut buffer = Vec::with_capacity(limit as usize);
    file.read_to_end(&mut buffer)
        .map_err(|error| error.to_string())?;

    let start = buffer
        .iter()
        .position(|byte| *byte == b'\n')
        .map(|index| index + 1)
        .unwrap_or(0);
    let content = String::from_utf8_lossy(&buffer[start..]).to_string();
    Ok((content, true, total_bytes))
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
            "partner-run-log-{label}-{}-{unique}",
            std::process::id()
        ));
        create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn finds_a_task_log_in_a_day_directory_that_is_not_today() {
        let root = temp_root("task");
        create_dir_all(root.join("2026-07-01")).expect("day dir");
        let target = root.join("2026-07-01/abc.jsonl");
        write(&target, "{}\n").expect("log");

        assert_eq!(find_task_log(&root, "abc"), Some(target));
    }

    #[test]
    fn sanitizes_the_task_id_before_matching() {
        let root = temp_root("sanitize");
        create_dir_all(root.join("2026-07-01")).expect("day dir");
        let target = root.join("2026-07-01/task_1.jsonl");
        write(&target, "{}\n").expect("log");

        assert_eq!(find_task_log(&root, "task:1"), Some(target));
    }

    #[test]
    fn missing_task_log_resolves_to_none() {
        let root = temp_root("absent");
        assert_eq!(find_task_log(&root, "nope"), None);
        assert_eq!(find_newest_log(&root), None);
    }

    #[test]
    fn newest_log_prefers_the_most_recently_written_file() {
        let root = temp_root("newest");
        create_dir_all(root.join("2026-07-01")).expect("day dir");
        let older = root.join("2026-07-01/older.jsonl");
        let newer = root.join("2026-07-01/newer.jsonl");
        write(&older, "{}\n").expect("older");
        // Filesystem mtime granularity can collapse two immediate writes.
        let stamp = SystemTime::now() - std::time::Duration::from_secs(60);
        let older_file = File::options().write(true).open(&older).expect("reopen");
        older_file
            .set_times(fs::FileTimes::new().set_modified(stamp))
            .expect("backdate");
        write(&newer, "{}\n").expect("newer");

        assert_eq!(find_newest_log(&root), Some(newer));
    }

    #[test]
    fn newest_log_ignores_non_jsonl_files() {
        let root = temp_root("filter");
        write(root.join("notes.txt"), "nope").expect("txt");
        assert_eq!(find_newest_log(&root), None);
    }

    #[test]
    fn resolve_in_falls_back_to_the_legacy_project_directory() {
        let global = temp_root("global-empty");
        let legacy = temp_root("legacy");
        create_dir_all(legacy.join("2026-07-01")).expect("day dir");
        let target = legacy.join("2026-07-01/abc.jsonl");
        write(&target, "{}\n").expect("log");

        assert_eq!(
            resolve_in(&[&global, &legacy], Some("abc")),
            Some((target, 1))
        );
    }

    #[test]
    fn read_tail_returns_whole_small_files() {
        let root = temp_root("small");
        let path = root.join("a.jsonl");
        write(&path, "{\"a\":1}\n").expect("log");

        let (content, truncated, total) = read_tail(&path, 1_000).expect("read");
        assert_eq!(content, "{\"a\":1}\n");
        assert!(!truncated);
        assert_eq!(total, 8);
    }

    #[test]
    fn read_tail_starts_on_a_line_boundary() {
        let root = temp_root("tail");
        let path = root.join("b.jsonl");
        write(&path, "aaaaaaaaaa\nbbbb\ncccc\n").expect("log");

        let (content, truncated, total) = read_tail(&path, 12).expect("read");
        assert_eq!(content, "bbbb\ncccc\n");
        assert!(truncated);
        assert_eq!(total, 21);
    }

    #[test]
    fn read_tail_never_splits_a_multibyte_codepoint() {
        let root = temp_root("utf8");
        let path = root.join("c.jsonl");
        write(&path, "第一行\n第二行\n").expect("log");

        let (content, truncated, _) = read_tail(&path, 11).expect("read");
        assert_eq!(content, "第二行\n");
        assert!(truncated);
    }
}
