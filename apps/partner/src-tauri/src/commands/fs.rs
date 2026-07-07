use std::fs;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;
use std::process::Command;

use serde::Serialize;

#[derive(Serialize)]
pub struct DirEntry {
    pub name: String,
    pub is_dir: bool,
}

#[derive(Serialize)]
pub struct FileSearchEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

#[derive(Serialize)]
pub struct FileContentSearchEntry {
    pub name: String,
    pub path: String,
    pub line_number: usize,
    pub line: String,
}

#[derive(Serialize)]
pub struct GitChange {
    pub path: String,
    pub status: String,
}

#[derive(Serialize)]
pub struct PathInfo {
    pub path: String,
    pub is_dir: bool,
    pub is_file: bool,
}

struct SearchFilters {
    include: Vec<String>,
    exclude: Vec<String>,
}

impl SearchFilters {
    fn new(include: Option<String>, exclude: Option<String>) -> Self {
        Self {
            include: parse_patterns(include),
            exclude: parse_patterns(exclude),
        }
    }

    fn matches(&self, root: &Path, path: &Path, is_dir: bool) -> bool {
        let relative = path.strip_prefix(root).unwrap_or(path).to_string_lossy();
        let normalized = relative.replace('\\', "/");

        if self
            .exclude
            .iter()
            .any(|pattern| path_matches_pattern(&normalized, pattern))
        {
            return false;
        }
        is_dir
            || self.include.is_empty()
            || self
                .include
                .iter()
                .any(|pattern| path_matches_pattern(&normalized, pattern))
    }
}

fn parse_patterns(value: Option<String>) -> Vec<String> {
    value
        .unwrap_or_default()
        .split([',', ' ', '\n'])
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(|part| part.to_lowercase().replace("**/", ""))
        .collect()
}

fn path_matches_pattern(path: &str, pattern: &str) -> bool {
    let path = path.to_lowercase();
    if pattern.contains('*') {
        wildcard_match(&path, pattern)
    } else {
        path.contains(pattern)
    }
}

fn wildcard_match(value: &str, pattern: &str) -> bool {
    let parts = pattern.split('*').collect::<Vec<_>>();
    if parts.len() == 1 {
        return value == pattern;
    }

    let mut remainder = value;
    if let Some(first) = parts.first().filter(|part| !part.is_empty()) {
        if !remainder.starts_with(first) {
            return false;
        }
        remainder = &remainder[first.len()..];
    }

    for part in parts.iter().skip(1).take(parts.len().saturating_sub(2)) {
        if part.is_empty() {
            continue;
        }
        let Some(index) = remainder.find(part) else {
            return false;
        };
        remainder = &remainder[index + part.len()..];
    }

    if let Some(last) = parts.last().filter(|part| !part.is_empty()) {
        return remainder.ends_with(last) || remainder.contains(last);
    }
    true
}

#[tauri::command]
pub async fn read_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn write_file(path: String, content: String) -> Result<(), String> {
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(&path, content).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn append_file(path: String, content: String) -> Result<(), String> {
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| error.to_string())?;
    file.write_all(content.as_bytes())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn path_info(path: String) -> Result<PathInfo, String> {
    let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
    Ok(PathInfo {
        path,
        is_dir: metadata.is_dir(),
        is_file: metadata.is_file(),
    })
}

#[tauri::command]
pub async fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let entries = fs::read_dir(&path).map_err(|error| error.to_string())?;
    let mut result = Vec::new();

    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        result.push(DirEntry {
            name,
            // pnpm/node_modules entries are often symlinks to directories.
            // `Path::is_dir` follows symlinks, unlike `DirEntry::file_type`.
            is_dir: path.is_dir(),
        });
    }

    result.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));
    Ok(result)
}

#[tauri::command]
pub async fn search_files(
    root: String,
    query: String,
    limit: Option<usize>,
    include: Option<String>,
    exclude: Option<String>,
) -> Result<Vec<FileSearchEntry>, String> {
    let query = query.trim().to_lowercase();
    if query.is_empty() {
        return Ok(Vec::new());
    }

    let root_path = Path::new(&root);
    let max_results = limit.unwrap_or(80).clamp(1, 200);
    let filters = SearchFilters::new(include, exclude);
    let mut results = Vec::new();
    search_dir(
        root_path,
        root_path,
        &query,
        &filters,
        max_results,
        &mut results,
    )?;
    Ok(results)
}

#[tauri::command]
pub async fn search_content(
    root: String,
    query: String,
    limit: Option<usize>,
    include: Option<String>,
    exclude: Option<String>,
) -> Result<Vec<FileContentSearchEntry>, String> {
    let query = query.trim().to_lowercase();
    if query.is_empty() {
        return Ok(Vec::new());
    }

    let root_path = Path::new(&root);
    let max_results = limit.unwrap_or(80).clamp(1, 200);
    let filters = SearchFilters::new(include, exclude);
    let mut results = Vec::new();
    search_content_dir(
        root_path,
        root_path,
        &query,
        &filters,
        max_results,
        &mut results,
    )?;
    Ok(results)
}

#[tauri::command]
pub async fn replace_content(
    root: String,
    query: String,
    replacement: String,
    include: Option<String>,
    exclude: Option<String>,
) -> Result<usize, String> {
    if query.is_empty() {
        return Ok(0);
    }

    let root_path = Path::new(&root);
    let filters = SearchFilters::new(include, exclude);
    let mut replacements = 0;
    replace_content_dir(
        root_path,
        root_path,
        &query,
        &replacement,
        &filters,
        &mut replacements,
    )?;
    Ok(replacements)
}

fn search_dir(
    root: &Path,
    dir: &Path,
    query: &str,
    filters: &SearchFilters,
    limit: usize,
    results: &mut Vec<FileSearchEntry>,
) -> Result<(), String> {
    if results.len() >= limit {
        return Ok(());
    }

    let entries = fs::read_dir(dir).map_err(|error| error.to_string())?;
    let mut entries = entries
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    entries.sort_by(|a, b| {
        let a_type = a.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
        let b_type = b.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
        b_type.cmp(&a_type).then(a.file_name().cmp(&b.file_name()))
    });

    for entry in entries {
        if results.len() >= limit {
            break;
        }
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        if should_skip_search_entry(&name, file_type.is_dir()) {
            continue;
        }
        let path = entry.path();
        if !filters.matches(root, &path, file_type.is_dir()) {
            continue;
        }
        if name.to_lowercase().contains(query) {
            results.push(FileSearchEntry {
                name: name.clone(),
                path: path.to_string_lossy().to_string(),
                is_dir: file_type.is_dir(),
            });
        }
        if file_type.is_dir() {
            search_dir(root, &path, query, filters, limit, results)?;
        }
    }

    Ok(())
}

fn search_content_dir(
    root: &Path,
    dir: &Path,
    query: &str,
    filters: &SearchFilters,
    limit: usize,
    results: &mut Vec<FileContentSearchEntry>,
) -> Result<(), String> {
    if results.len() >= limit {
        return Ok(());
    }

    let entries = fs::read_dir(dir).map_err(|error| error.to_string())?;
    let mut entries = entries
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    entries.sort_by_key(|entry| entry.file_name());

    for entry in entries {
        if results.len() >= limit {
            break;
        }
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        if should_skip_search_entry(&name, file_type.is_dir()) {
            continue;
        }

        let path = entry.path();
        if !filters.matches(root, &path, file_type.is_dir()) {
            continue;
        }
        if file_type.is_dir() {
            search_content_dir(root, &path, query, filters, limit, results)?;
            continue;
        }
        if !is_searchable_text_file(&path) {
            continue;
        }

        let Ok(content) = fs::read_to_string(&path) else {
            continue;
        };
        for (index, line) in content.lines().enumerate() {
            if results.len() >= limit {
                break;
            }
            if line_matches_query(line, query) {
                results.push(FileContentSearchEntry {
                    name: name.clone(),
                    path: path.to_string_lossy().to_string(),
                    line_number: index + 1,
                    line: line.trim().chars().take(240).collect(),
                });
            }
        }
    }

    Ok(())
}

fn replace_content_dir(
    root: &Path,
    dir: &Path,
    query: &str,
    replacement: &str,
    filters: &SearchFilters,
    replacements: &mut usize,
) -> Result<(), String> {
    let entries = fs::read_dir(dir).map_err(|error| error.to_string())?;
    let mut entries = entries
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    entries.sort_by_key(|entry| entry.file_name());

    for entry in entries {
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        if should_skip_search_entry(&name, file_type.is_dir()) {
            continue;
        }

        let path = entry.path();
        if !filters.matches(root, &path, file_type.is_dir()) {
            continue;
        }
        if file_type.is_dir() {
            replace_content_dir(root, &path, query, replacement, filters, replacements)?;
            continue;
        }
        if !is_searchable_text_file(&path) {
            continue;
        }

        let Ok(content) = fs::read_to_string(&path) else {
            continue;
        };
        let count = content.matches(query).count();
        if count == 0 {
            continue;
        }
        fs::write(&path, content.replace(query, replacement)).map_err(|error| error.to_string())?;
        *replacements += count;
    }

    Ok(())
}

fn should_skip_search_entry(name: &str, is_dir: bool) -> bool {
    is_dir
        && matches!(
            name,
            "node_modules" | "target" | "dist" | "build" | "coverage" | ".git"
        )
}

fn is_searchable_text_file(path: &Path) -> bool {
    const MAX_FILE_SIZE: u64 = 2 * 1024 * 1024;
    const BINARY_EXTENSIONS: &[&str] = &[
        "bmp", "gif", "icns", "ico", "jpeg", "jpg", "mov", "mp3", "mp4", "pdf", "png", "tar",
        "webp", "zip",
    ];

    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    if metadata.len() > MAX_FILE_SIZE {
        return false;
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_lowercase);
    !extension
        .as_deref()
        .is_some_and(|ext| BINARY_EXTENSIONS.contains(&ext))
}

fn line_matches_query(line: &str, query: &str) -> bool {
    line.to_lowercase().contains(query)
}

#[tauri::command]
pub async fn git_status(path: String) -> Result<Vec<GitChange>, String> {
    let output = Command::new("git")
        .args([
            "-C",
            &path,
            "status",
            "--porcelain=v1",
            "--untracked-files=all",
        ])
        .output()
        .map_err(|error| format!("failed to run git status: {error}"))?;

    if !output.status.success() {
        return Ok(Vec::new());
    }

    let stdout = String::from_utf8(output.stdout).map_err(|error| error.to_string())?;
    Ok(stdout.lines().filter_map(parse_git_status_line).collect())
}

fn parse_git_status_line(line: &str) -> Option<GitChange> {
    if line.len() < 4 {
        return None;
    }

    let raw_status = line.get(0..2)?.trim();
    let status = if raw_status.is_empty() {
        line.get(0..2)?.to_string()
    } else {
        raw_status.to_string()
    };
    let path = line
        .get(3..)?
        .rsplit_once(" -> ")
        .map(|(_, renamed_to)| renamed_to)
        .unwrap_or_else(|| line.get(3..).unwrap_or_default())
        .to_string();

    Some(GitChange { path, status })
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{
        line_matches_query, parse_git_status_line, should_skip_search_entry, SearchFilters,
    };

    #[test]
    fn parses_modified_file() {
        let change = parse_git_status_line(" M src/main.ts").expect("change");
        assert_eq!(change.status, "M");
        assert_eq!(change.path, "src/main.ts");
    }

    #[test]
    fn parses_untracked_file() {
        let change = parse_git_status_line("?? apps/partner/package.json").expect("change");
        assert_eq!(change.status, "??");
        assert_eq!(change.path, "apps/partner/package.json");
    }

    #[test]
    fn parses_renamed_file_target() {
        let change = parse_git_status_line("R  old-name.ts -> new-name.ts").expect("change");
        assert_eq!(change.status, "R");
        assert_eq!(change.path, "new-name.ts");
    }

    #[test]
    fn matches_content_search_case_insensitively() {
        assert!(line_matches_query(
            "`CheckpointStore`** — JSONL-based persistent checkpoint store",
            "jsonl-based persistent ch"
        ));
    }

    #[test]
    fn filters_paths_by_include_and_exclude_patterns() {
        let filters = SearchFilters::new(Some("docs/**/*.md".to_string()), Some("zh".to_string()));
        let root = Path::new("/workspace");

        assert!(filters.matches(root, Path::new("/workspace/docs/platform/plugin.md"), false));
        assert!(!filters.matches(root, Path::new("/workspace/docs/zh/partner.md"), false));
        assert!(!filters.matches(root, Path::new("/workspace/src/main.ts"), false));
    }

    #[test]
    fn allows_dotfiles_and_dot_directories_in_search() {
        assert!(!should_skip_search_entry(".env", false));
        assert!(!should_skip_search_entry(".vera", true));
    }

    #[test]
    fn skips_heavy_generated_directories() {
        assert!(should_skip_search_entry(".git", true));
        assert!(should_skip_search_entry("node_modules", true));
        assert!(should_skip_search_entry("target", true));
    }
}
