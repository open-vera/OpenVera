use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::sidecar::SidecarManager;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspStartResponse {
    pub ws_url: String,
    pub language_id: String,
    pub server_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspSymbolSearchEntry {
    pub name: String,
    pub kind: String,
    pub path: String,
}

#[tauri::command]
pub async fn lsp_start(
    sidecar: State<'_, SidecarManager>,
    language_id: String,
    workspace_root: String,
    file_path: String,
) -> Result<LspStartResponse, String> {
    let _ = file_path;
    let data = sidecar.call_rpc(
        "lsp.start",
        serde_json::json!({
            "languageId": language_id,
            "workspaceRoot": workspace_root,
        }),
    )?;

    Ok(LspStartResponse {
        ws_url: data
            .get("wsUrl")
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .to_string(),
        language_id: data
            .get("languageId")
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .to_string(),
        server_id: data
            .get("serverId")
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .to_string(),
    })
}

#[tauri::command]
pub async fn lsp_stop(sidecar: State<'_, SidecarManager>, server_id: String) -> Result<(), String> {
    sidecar.call_rpc(
        "lsp.stop",
        serde_json::json!({
            "serverId": server_id,
        }),
    )?;
    Ok(())
}

#[tauri::command]
pub async fn lsp_symbol_search(
    sidecar: State<'_, SidecarManager>,
    workspace_root: String,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<LspSymbolSearchEntry>, String> {
    let data = sidecar.call_rpc(
        "lsp.symbolSearch",
        serde_json::json!({
            "workspaceRoot": workspace_root,
            "query": query,
            "limit": limit.unwrap_or(80),
        }),
    )?;

    let results = data
        .get("results")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    Ok(results
        .into_iter()
        .map(|item| LspSymbolSearchEntry {
            name: item
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            kind: item
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or("Symbol")
                .to_string(),
            path: item
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        })
        .collect())
}
