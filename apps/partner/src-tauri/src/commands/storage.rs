use std::fs;
use std::path::Path;

use serde_json::Value;

#[tauri::command]
pub async fn storage_ping() -> Result<String, String> {
    // Phase 2: wire tauri-plugin-sql
    Ok("storage-ready".to_string())
}

#[tauri::command]
pub async fn load_partner_sessions(project_root: String) -> Result<Option<Value>, String> {
    let path = partner_sessions_path(&project_root);
    if !path.exists() {
        return Ok(None);
    }

    let content = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    let parsed = serde_json::from_str::<Value>(&content).map_err(|error| error.to_string())?;
    Ok(Some(parsed))
}

#[tauri::command]
pub async fn save_partner_sessions(project_root: String, data: Value) -> Result<(), String> {
    let path = partner_sessions_path(&project_root);
    let parent = path
        .parent()
        .ok_or_else(|| "Invalid partner session path".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;

    let content = serde_json::to_string_pretty(&data).map_err(|error| error.to_string())?;
    fs::write(path, content).map_err(|error| error.to_string())
}

fn partner_sessions_path(project_root: &str) -> std::path::PathBuf {
    Path::new(project_root)
        .join(".vera")
        .join("partner-sessions.json")
}
