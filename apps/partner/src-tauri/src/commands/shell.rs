use std::collections::HashSet;
use std::process::Command;

use serde::Serialize;

const MAX_OUTPUT_BYTES: usize = 256 * 1024;

#[derive(Serialize)]
pub struct ShellOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

fn allowed_commands() -> HashSet<&'static str> {
    HashSet::from(["ls", "cat", "echo", "pwd", "git", "node", "pnpm"])
}

pub fn shell_confirmation_reason(cmd: &str) -> Option<String> {
    let risky = ["rm", "sudo", "chmod", "chown", "kill", "pkill"];
    if risky.contains(&cmd) {
        return Some(format!("命令 `{cmd}` 属于高风险命令，需要用户确认"));
    }
    if !allowed_commands().contains(cmd) {
        return Some(format!("命令 `{cmd}` 不在白名单中，需要用户确认"));
    }
    None
}

fn truncate_output(text: String) -> String {
    if text.len() <= MAX_OUTPUT_BYTES {
        return text;
    }
    let truncated = &text[..MAX_OUTPUT_BYTES];
    format!(
        "{truncated}\n[输出过长，已截断 {} 字节]",
        text.len() - MAX_OUTPUT_BYTES
    )
}

#[tauri::command]
pub async fn execute_shell(
    cmd: String,
    args: Vec<String>,
    cwd: Option<String>,
    _timeout_ms: Option<u64>,
    confirmed: bool,
) -> Result<ShellOutput, String> {
    if !confirmed {
        if let Some(reason) = shell_confirmation_reason(&cmd) {
            return Err(reason);
        }
    }

    let cmd_name = cmd.clone();
    let args_clone = args.clone();
    let cwd_clone = cwd.clone();

    let output = tauri::async_runtime::spawn_blocking(move || {
        let mut command = Command::new(&cmd_name);
        command.args(&args_clone);
        if let Some(dir) = cwd_clone {
            command.current_dir(dir);
        }
        command.output()
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())?;

    Ok(ShellOutput {
        stdout: truncate_output(String::from_utf8_lossy(&output.stdout).into_owned()),
        stderr: truncate_output(String::from_utf8_lossy(&output.stderr).into_owned()),
        exit_code: output.status.code().unwrap_or(-1),
    })
}
