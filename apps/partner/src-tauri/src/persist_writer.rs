//! Throttled, coalescing writer for the Host app-state document.
//!
//! `~/.vera/partner/app-state.json` grows with session history (22 MB in the
//! field) and every Host mutation used to read-merge-write the whole file while
//! the `HostState` mutex was held, so a single tab activation cost ~1.25 s and a
//! click on the session tree fired two or three of them. Writes now hand a
//! snapshot to a background thread that keeps only the newest pending document
//! and writes it at most once per [`THROTTLE_INTERVAL`].
//!
//! Lives at the crate root rather than under `host/` because `host::persist` is
//! private to the `host` module while the shutdown flush is wired in `lib.rs`.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde_json::Value;

/// Coalescing window: at most one disk write per interval, no matter how many
/// mutations arrive. State that only exists in memory is therefore at most this
/// old, which is why exit paths must call [`flush_now`].
pub const THROTTLE_INTERVAL: Duration = Duration::from_millis(1_500);

/// Reconciles the in-memory document (first argument) with what is already on
/// disk (second argument) immediately before writing.
pub type MergeFn = fn(&mut Value, &Value);

pub struct WriteJob {
    pub path: PathBuf,
    pub document: Value,
    pub merge_with_disk: Option<MergeFn>,
}

struct Inner {
    /// Newest snapshot waiting to be written; older ones are dropped unwritten.
    pending: Option<WriteJob>,
    last_write: Option<Instant>,
    completed: u64,
    stopping: bool,
}

struct Shared {
    interval: Duration,
    inner: Mutex<Inner>,
    /// Signalled when work arrives or the writer should stop.
    ready: Condvar,
    /// Signalled after every completed write.
    done: Condvar,
    /// Serializes the actual file access between the worker and [`flush_now`].
    io: Mutex<()>,
}

pub struct ThrottledWriter {
    shared: Arc<Shared>,
    worker: Option<JoinHandle<()>>,
}

impl ThrottledWriter {
    pub fn new(interval: Duration) -> Self {
        let shared = Arc::new(Shared {
            interval,
            inner: Mutex::new(Inner {
                pending: None,
                last_write: None,
                completed: 0,
                stopping: false,
            }),
            ready: Condvar::new(),
            done: Condvar::new(),
            io: Mutex::new(()),
        });
        let worker_shared = Arc::clone(&shared);
        let worker = thread::Builder::new()
            .name("app-state-writer".to_string())
            .spawn(move || run(&worker_shared))
            .ok();
        Self { shared, worker }
    }

    /// Queue `job`, replacing any snapshot that has not reached the disk yet.
    ///
    /// Callers may hold the `HostState` mutex, so this only touches this
    /// writer's own lock — never the filesystem and never `HostHandle`.
    pub fn schedule(&self, job: WriteJob) {
        lock(&self.shared.inner).pending = Some(job);
        self.shared.ready.notify_all();
    }

    /// Write the pending document on the calling thread; the durability boundary
    /// for app exit and window close.
    pub fn flush_now(&self) -> Result<(), String> {
        let job = {
            let mut inner = lock(&self.shared.inner);
            // Claim the interval as well: the worker must not immediately write
            // the same document again behind us.
            inner.last_write = Some(Instant::now());
            inner.pending.take()
        };
        let Some(job) = job else {
            return Ok(());
        };
        let result = write_job(&self.shared, job);
        lock(&self.shared.inner).completed += 1;
        self.shared.done.notify_all();
        result
    }
}

impl Drop for ThrottledWriter {
    fn drop(&mut self) {
        lock(&self.shared.inner).stopping = true;
        self.shared.ready.notify_all();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

/// A poisoned writer lock means a previous write panicked; the queue itself is
/// still consistent (a job is either pending or taken), so keep persisting
/// rather than taking the whole Host down with it.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn run(shared: &Arc<Shared>) {
    loop {
        let job = {
            let mut inner = lock(&shared.inner);
            loop {
                if inner.pending.is_some() {
                    let wait = remaining(shared, &inner);
                    // Stopping short-circuits the throttle: the last snapshot
                    // must land before the process goes away.
                    if wait.is_zero() || inner.stopping {
                        break;
                    }
                    inner = shared
                        .ready
                        .wait_timeout(inner, wait)
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .0;
                    continue;
                }
                if inner.stopping {
                    return;
                }
                inner = shared
                    .ready
                    .wait(inner)
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
            }
            inner.last_write = Some(Instant::now());
            inner.pending.take().expect("pending job checked above")
        };

        if let Err(error) = write_job(shared, job) {
            // Nothing to report to: `save_from` callers already ignore errors.
            eprintln!("[persist] app-state write failed: {error}");
        }
        lock(&shared.inner).completed += 1;
        shared.done.notify_all();
    }
}

fn remaining(shared: &Shared, inner: &Inner) -> Duration {
    match inner.last_write {
        // Nothing written yet in this process: write straight away instead of
        // making the first mutation wait out a whole interval.
        None => Duration::ZERO,
        Some(at) => shared.interval.saturating_sub(at.elapsed()),
    }
}

fn write_job(shared: &Shared, mut job: WriteJob) -> Result<(), String> {
    let _io = lock(&shared.io);
    if let Some(parent) = job.path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    if let Some(merge) = job.merge_with_disk {
        if let Ok(existing) = fs::read_to_string(&job.path) {
            if let Ok(disk) = serde_json::from_str::<Value>(&existing) {
                merge(&mut job.document, &disk);
            }
        }
    }
    let content = serde_json::to_string_pretty(&job.document).map_err(|error| error.to_string())?;
    write_atomically(&job.path, &content)
}

/// Publish by rename: this now writes while the app may be tearing down, and a
/// truncated document would lose every session instead of the last mutation.
fn write_atomically(path: &Path, content: &str) -> Result<(), String> {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("invalid app-state path: {}", path.display()))?;
    let temp = path.with_file_name(format!("{file_name}.{}.tmp", std::process::id()));
    fs::write(&temp, content).map_err(|error| error.to_string())?;
    fs::rename(&temp, path).map_err(|error| error.to_string())
}

static WRITER: OnceLock<ThrottledWriter> = OnceLock::new();

pub fn writer() -> &'static ThrottledWriter {
    WRITER.get_or_init(|| ThrottledWriter::new(THROTTLE_INTERVAL))
}

/// Force the pending app-state document out to disk now.
pub fn flush_now() -> Result<(), String> {
    writer().flush_now()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Self-cleaning temp directory: tests must never reach the real `~/.vera`.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let path = std::env::temp_dir()
                .join(format!("partner-persist-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&path).expect("temp dir");
            Self(path)
        }

        fn join(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn job(path: &Path, tag: &str) -> WriteJob {
        WriteJob {
            path: path.to_path_buf(),
            document: json!({ "tag": tag }),
            merge_with_disk: None,
        }
    }

    fn read(path: &Path) -> Value {
        let content = fs::read_to_string(path).expect("state file");
        serde_json::from_str(&content).expect("state json")
    }

    fn wait_for_writes(writer: &ThrottledWriter, count: u64, timeout: Duration) -> u64 {
        let deadline = Instant::now() + timeout;
        let mut inner = lock(&writer.shared.inner);
        while inner.completed < count {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            inner = writer
                .shared
                .done
                .wait_timeout(inner, left)
                .expect("writer state")
                .0;
        }
        inner.completed
    }

    #[test]
    fn the_first_write_does_not_wait_out_the_interval() {
        let dir = TempDir::new();
        let path = dir.join("app-state.json");
        let writer = ThrottledWriter::new(Duration::from_secs(30));

        writer.schedule(job(&path, "one"));

        assert_eq!(wait_for_writes(&writer, 1, Duration::from_secs(5)), 1);
        assert_eq!(read(&path)["tag"], json!("one"));
    }

    /// The whole point: a burst of mutations (activate tab, set preview project,
    /// reorder) must cost one write of the newest state, not one per mutation.
    #[test]
    fn rapid_writes_coalesce_into_a_single_disk_write() {
        let dir = TempDir::new();
        let path = dir.join("app-state.json");
        let writer = ThrottledWriter::new(Duration::from_millis(800));

        writer.schedule(job(&path, "warmup"));
        assert_eq!(wait_for_writes(&writer, 1, Duration::from_secs(5)), 1);

        for tag in ["a", "b", "c", "d", "e"] {
            writer.schedule(job(&path, tag));
        }

        assert_eq!(wait_for_writes(&writer, 2, Duration::from_secs(5)), 2);
        assert_eq!(read(&path)["tag"], json!("e"));
        // Nothing is queued behind the coalesced write.
        assert_eq!(wait_for_writes(&writer, 3, Duration::from_millis(400)), 2);
    }

    #[test]
    fn flush_now_writes_the_pending_document_immediately() {
        let dir = TempDir::new();
        let path = dir.join("app-state.json");
        let writer = ThrottledWriter::new(Duration::from_secs(30));

        writer.schedule(job(&path, "first"));
        assert_eq!(wait_for_writes(&writer, 1, Duration::from_secs(5)), 1);
        writer.schedule(job(&path, "second"));
        assert_eq!(read(&path)["tag"], json!("first"));

        writer.flush_now().expect("flush");

        assert_eq!(read(&path)["tag"], json!("second"));
        assert_eq!(lock(&writer.shared.inner).completed, 2);
    }

    #[test]
    fn flush_now_is_a_no_op_without_a_pending_document() {
        let dir = TempDir::new();
        let path = dir.join("app-state.json");
        let writer = ThrottledWriter::new(Duration::from_secs(30));

        writer.flush_now().expect("flush");

        assert!(!path.exists());
        assert_eq!(lock(&writer.shared.inner).completed, 0);
    }

    /// Shutdown durability: whatever is still pending when the writer goes away
    /// is written, ignoring the throttle.
    #[test]
    fn dropping_the_writer_flushes_the_pending_document() {
        let dir = TempDir::new();
        let path = dir.join("app-state.json");

        {
            let writer = ThrottledWriter::new(Duration::from_secs(30));
            writer.schedule(job(&path, "pending"));
        }

        assert_eq!(read(&path)["tag"], json!("pending"));
    }

    /// The read-merge-write that keeps richer on-disk state must survive the move
    /// to the background thread.
    #[test]
    fn the_document_on_disk_is_merged_before_writing() {
        fn keep_disk_extras(document: &mut Value, disk: &Value) {
            let Some(disk_object) = disk.as_object() else {
                return;
            };
            let Some(target) = document.as_object_mut() else {
                return;
            };
            for (key, value) in disk_object {
                target.entry(key.clone()).or_insert_with(|| value.clone());
            }
        }

        let dir = TempDir::new();
        let path = dir.join("app-state.json");
        fs::write(&path, json!({ "tag": "disk", "keep": true }).to_string()).expect("seed");
        let writer = ThrottledWriter::new(Duration::from_millis(0));

        let mut pending = job(&path, "memory");
        pending.merge_with_disk = Some(keep_disk_extras);
        writer.schedule(pending);

        assert_eq!(wait_for_writes(&writer, 1, Duration::from_secs(5)), 1);
        let document = read(&path);
        assert_eq!(document["tag"], json!("memory"));
        assert_eq!(document["keep"], json!(true));
    }

    #[test]
    fn a_failed_write_does_not_stop_the_writer() {
        let dir = TempDir::new();
        let wall = dir.join("wall");
        fs::write(&wall, "not a directory").expect("seed");
        let path = dir.join("app-state.json");
        let writer = ThrottledWriter::new(Duration::ZERO);

        writer.schedule(job(&wall.join("app-state.json"), "boom"));
        assert_eq!(wait_for_writes(&writer, 1, Duration::from_secs(5)), 1);
        writer.schedule(job(&path, "after"));

        assert_eq!(wait_for_writes(&writer, 2, Duration::from_secs(5)), 2);
        assert_eq!(read(&path)["tag"], json!("after"));
    }

    #[test]
    fn temp_files_are_not_left_behind() {
        let dir = TempDir::new();
        let path = dir.join("app-state.json");
        let writer = ThrottledWriter::new(Duration::ZERO);

        writer.schedule(job(&path, "one"));
        assert_eq!(wait_for_writes(&writer, 1, Duration::from_secs(5)), 1);

        let leftovers: Vec<PathBuf> = fs::read_dir(&dir.0)
            .expect("temp dir")
            .filter_map(|entry| entry.ok().map(|entry| entry.path()))
            .filter(|entry| entry.extension().is_some_and(|ext| ext == "tmp"))
            .collect();
        assert!(leftovers.is_empty(), "leftover temp files: {leftovers:?}");
    }
}
