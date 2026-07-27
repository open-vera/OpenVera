//! Shared filesystem locations for Partner (global `~/.vera`, run logs).

use std::path::PathBuf;

pub const VERA_DIRNAME: &str = ".vera";
pub const RUN_LOG_DIRNAME: &str = "partner-runs";
pub const PROJECTS_DIRNAME: &str = "projects";

const MAX_DIR_LEN: usize = 80;
const MAX_SEGMENT_LENGTH: usize = 120;

pub fn vera_home() -> Result<PathBuf, String> {
    if let Ok(home) = std::env::var("VERA_HOME") {
        if !home.is_empty() {
            return Ok(PathBuf::from(home));
        }
    }
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(PathBuf::from)
        .map_err(|_| "HOME / USERPROFILE is not set".to_string())
}

pub fn global_vera_dir() -> Result<PathBuf, String> {
    Ok(vera_home()?.join(VERA_DIRNAME))
}

pub fn run_log_root() -> Result<PathBuf, String> {
    Ok(global_vera_dir()?.join(RUN_LOG_DIRNAME))
}

pub fn run_log_project_dir(project_root: &str) -> Result<PathBuf, String> {
    Ok(run_log_root()?.join(project_slug(project_root)))
}

/// Per-project directory name derived from an absolute project root.
///
/// Mirrors `projectSlug` in `packages/core/src/session/store-paths.ts`: every
/// non-alphanumeric character becomes `-` (runs are *not* collapsed, so
/// `/a__b` and `/a-b` stay distinct), and paths longer than 80 characters get a
/// djb2 suffix for uniqueness. The sidecar writes these paths and the host
/// resolves them, so the two implementations must agree byte for byte.
pub fn project_slug(project_root: &str) -> String {
    // Iterate UTF-16 units, not chars: the JS regex substitutes per code unit,
    // so an astral character yields two dashes there and must here too.
    let sanitized: String = project_root
        .encode_utf16()
        .map(|unit| match char::from_u32(u32::from(unit)) {
            Some(ch) if ch.is_ascii_alphanumeric() => ch,
            _ => '-',
        })
        .collect();

    if sanitized.len() <= MAX_DIR_LEN {
        return sanitized;
    }
    format!(
        "{}-{}",
        &sanitized[..MAX_DIR_LEN],
        hash_path(project_root)
    )
}

/// djb2 over UTF-16 code units, truncated to i32 like JavaScript's `| 0`.
fn hash_path(value: &str) -> String {
    let mut hash: i32 = 5381;
    for unit in value.encode_utf16() {
        // charCodeAt yields an unsigned 16-bit value.
        hash = hash
            .wrapping_shl(5)
            .wrapping_add(hash)
            .wrapping_add(i32::from(unit));
    }
    to_base36(i64::from(hash).unsigned_abs())
}

fn to_base36(mut value: u64) -> String {
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if value == 0 {
        return "0".to_string();
    }
    let mut out = Vec::new();
    while value > 0 {
        out.push(DIGITS[(value % 36) as usize]);
        value /= 36;
    }
    out.reverse();
    String::from_utf8(out).expect("base36 digits are ascii")
}

/// Filename-safe single path segment; mirrors `runLogSegment` in the sidecar.
pub fn run_log_segment(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
                ch
            } else {
                '_'
            }
        })
        .take(MAX_SEGMENT_LENGTH)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // These vectors are duplicated in
    // apps/partner/tests/unit/sidecar/run-log.test.ts — both sides must agree
    // or the host cannot find what the sidecar wrote.
    #[test]
    fn slug_flattens_an_absolute_posix_path() {
        assert_eq!(
            project_slug("/Users/dev/workspace/open-vera"),
            "-Users-dev-workspace-open-vera"
        );
    }

    #[test]
    fn slug_replaces_dots_too() {
        assert_eq!(
            project_slug("/Users/yang.zhou/workspace/open-vera"),
            "-Users-yang-zhou-workspace-open-vera"
        );
    }

    #[test]
    fn slug_does_not_collapse_separator_runs() {
        assert_eq!(project_slug("/a//b"), "-a--b");
        assert_eq!(project_slug("/a-b"), "-a-b");
    }

    #[test]
    fn slug_replaces_non_ascii_per_utf16_unit() {
        assert_eq!(project_slug("/a/项目"), "-a---");
        assert_eq!(project_slug("C:\\work\\app"), "C--work-app");
    }

    #[test]
    fn slug_is_empty_for_an_empty_path() {
        assert_eq!(project_slug(""), "");
    }

    #[test]
    fn slug_hashes_paths_longer_than_the_directory_limit() {
        let long = format!("/{}", "a".repeat(120));
        let slug = project_slug(&long);

        assert_eq!(slug.len(), 87);
        assert!(slug.ends_with("-xt6otw"));
        // Distinct long paths must stay distinct after truncation.
        let other = format!("/{}b", "a".repeat(119));
        assert_ne!(slug, project_slug(&other));
    }

    #[test]
    fn hash_matches_the_javascript_djb2() {
        // Reference values from hashPath in packages/core/src/session/store-paths.ts.
        assert_eq!(hash_path(""), "45h");
        assert_eq!(hash_path("/a"), "3hmt1");
        assert_eq!(hash_path(&format!("/{}", "a".repeat(120))), "xt6otw");
    }

    #[test]
    fn base36_encodes_like_number_to_string() {
        assert_eq!(to_base36(0), "0");
        assert_eq!(to_base36(35), "z");
        assert_eq!(to_base36(36), "10");
        assert_eq!(to_base36(2_147_483_648), "zik0zk");
    }

    #[test]
    fn segment_sanitizes_task_ids() {
        assert_eq!(run_log_segment("task:1"), "task_1");
        assert_eq!(run_log_segment("a/b"), "a_b");
        assert_eq!(run_log_segment(&"x".repeat(200)).len(), MAX_SEGMENT_LENGTH);
    }
}
