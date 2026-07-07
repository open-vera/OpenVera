pub mod agent;
pub mod fs;
pub mod keychain;
pub mod lsp;
pub mod shell;
pub mod storage;

#[tauri::command]
pub fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
