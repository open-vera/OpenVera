use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::commands::shell;

#[derive(Debug, Clone)]
pub struct ToolApprovalRequest {
    pub reason: String,
    pub cmd: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
}

#[derive(Debug, Clone)]
pub enum PartnerToolError {
    Failed(String),
    ApprovalRequired(ToolApprovalRequest),
}

fn project_root(input: &Value) -> Option<PathBuf> {
    input
        .get("projectRoot")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
}

fn resolve_path(input: &Value, key: &str) -> Result<PathBuf, PartnerToolError> {
    let raw = input
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| PartnerToolError::Failed(format!("{key} is required")))?;
    let path = PathBuf::from(raw);
    if path.is_absolute() {
        return Ok(path);
    }
    Ok(project_root(input)
        .unwrap_or_else(|| PathBuf::from("."))
        .join(path))
}

fn path_string(path: PathBuf) -> String {
    path.to_string_lossy().to_string()
}

pub fn execute_partner_tool(
    name: &str,
    input: &Value,
    confirmed: bool,
) -> Result<String, PartnerToolError> {
    match name {
        "read_file" => {
            let path = resolve_path(input, "path")
                .map_err(|_| PartnerToolError::Failed("read_file requires path".to_string()))?;
            fs::read_to_string(path).map_err(|error| PartnerToolError::Failed(error.to_string()))
        }
        "write_file" => {
            let path = resolve_path(input, "path")
                .map_err(|_| PartnerToolError::Failed("write_file requires path".to_string()))?;
            let content = input
                .get("content")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    PartnerToolError::Failed("write_file requires content".to_string())
                })?;
            if let Some(parent) = Path::new(&path).parent() {
                fs::create_dir_all(parent)
                    .map_err(|error| PartnerToolError::Failed(error.to_string()))?;
            }
            fs::write(path, content)
                .map_err(|error| PartnerToolError::Failed(error.to_string()))?;
            Ok("ok".to_string())
        }
        "list_dir" => {
            let path = resolve_path(input, "path")
                .map_err(|_| PartnerToolError::Failed("list_dir requires path".to_string()))?;
            let entries =
                fs::read_dir(path).map_err(|error| PartnerToolError::Failed(error.to_string()))?;
            let mut names = Vec::new();
            for entry in entries {
                let entry = entry.map_err(|error| PartnerToolError::Failed(error.to_string()))?;
                let name = entry.file_name().to_string_lossy().to_string();
                names.push(name);
            }
            names.sort();
            Ok(names.join("\n"))
        }
        "execute_shell" => {
            let cmd = input.get("cmd").and_then(Value::as_str).ok_or_else(|| {
                PartnerToolError::Failed("execute_shell requires cmd".to_string())
            })?;
            let args = input
                .get("args")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let cwd = input
                .get("cwd")
                .and_then(Value::as_str)
                .map(|value| resolve_path(&serde_json::json!({ "path": value, "projectRoot": input.get("projectRoot").cloned().unwrap_or(Value::Null) }), "path"))
                .transpose()?
                .or_else(|| project_root(input))
                .map(path_string);
            if !confirmed {
                if let Some(reason) = shell::shell_confirmation_reason(cmd) {
                    return Err(PartnerToolError::ApprovalRequired(ToolApprovalRequest {
                        reason,
                        cmd: cmd.to_string(),
                        args,
                        cwd,
                    }));
                }
            }
            let output = tauri::async_runtime::block_on(shell::execute_shell(
                cmd.to_string(),
                args,
                cwd,
                None,
                confirmed,
            ))
            .map_err(PartnerToolError::Failed)?;
            if output.exit_code == 0 {
                Ok(output.stdout)
            } else {
                Err(PartnerToolError::Failed(format!(
                    "exit {}: {}",
                    output.exit_code,
                    output.stderr.trim()
                )))
            }
        }
        other => Err(PartnerToolError::Failed(format!(
            "unsupported tool: {other}"
        ))),
    }
}
