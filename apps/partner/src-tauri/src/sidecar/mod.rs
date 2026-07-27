pub mod tools;

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{path::BaseDirectory, AppHandle, Emitter, Manager};

use tools::{execute_partner_tool, PartnerToolError};

#[derive(Clone)]
pub struct SidecarLaunch {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarInfo {
    pub running: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub needs_node_install: bool,
}

pub struct SidecarManager {
    child: Mutex<Option<Child>>,
    stdin: Arc<Mutex<Option<std::process::ChildStdin>>>,
    rpc_pending: Arc<Mutex<HashMap<String, mpsc::Sender<Value>>>>,
    tool_approvals: Arc<Mutex<HashMap<String, mpsc::Sender<bool>>>>,
    app: Option<AppHandle>,
    launch: Option<SidecarLaunch>,
    startup_error: Option<String>,
    needs_node_install: bool,
}

impl SidecarManager {
    pub fn try_spawn(app: &AppHandle) -> Self {
        match Self::spawn(app) {
            Ok(manager) => manager,
            Err(error) => {
                let needs_node_install = error.contains("未检测到 Node.js");
                eprintln!("[partner] sidecar unavailable: {error}");
                Self {
                    child: Mutex::new(None),
                    stdin: Arc::new(Mutex::new(None)),
                    rpc_pending: Arc::new(Mutex::new(HashMap::new())),
                    tool_approvals: Arc::new(Mutex::new(HashMap::new())),
                    app: None,
                    launch: None,
                    startup_error: Some(error),
                    needs_node_install,
                }
            }
        }
    }

    pub fn spawn(app: &AppHandle) -> Result<Self, String> {
        let launch = find_sidecar_entry(app)?;
        eprintln!(
            "[partner] spawning sidecar: {} {:?} (cwd={:?})",
            launch.program, launch.args, launch.cwd
        );

        let (child, stdout, child_stdin) = spawn_sidecar_process(&launch)?;
        let stdin = Arc::new(Mutex::new(child_stdin));

        let rpc_pending = Arc::new(Mutex::new(HashMap::<String, mpsc::Sender<Value>>::new()));
        let tool_approvals = Arc::new(Mutex::new(HashMap::<String, mpsc::Sender<bool>>::new()));
        let manager = Self {
            child: Mutex::new(Some(child)),
            stdin: Arc::clone(&stdin),
            rpc_pending: Arc::clone(&rpc_pending),
            tool_approvals: Arc::clone(&tool_approvals),
            app: Some(app.clone()),
            launch: Some(launch),
            startup_error: None,
            needs_node_install: false,
        };

        spawn_stdout_reader(stdout, app.clone(), stdin, rpc_pending, tool_approvals);

        Ok(manager)
    }

    pub fn write_json(&self, value: &Value) -> Result<(), String> {
        let line = serde_json::to_string(value).map_err(|error| error.to_string())?;
        self.write_line(&line)
    }

    fn ensure_connected(&self) -> Result<(), String> {
        let guard = self.stdin.lock().map_err(|error| error.to_string())?;
        if guard.is_none() {
            if let Some(error) = &self.startup_error {
                return Err(error.clone());
            }
            return Err("Sidecar 未就绪，请重启 Partner。".to_string());
        }
        Ok(())
    }

    pub fn write_line(&self, line: &str) -> Result<(), String> {
        match self.try_write_line(line) {
            Ok(()) => Ok(()),
            Err(error) if is_recoverable_pipe_error(&error) => {
                eprintln!("[partner] sidecar write failed, restarting: {error}");
                self.restart()?;
                self.try_write_line(line)
            }
            Err(error) => Err(error),
        }
    }

    fn try_write_line(&self, line: &str) -> Result<(), String> {
        let mut guard = self.stdin.lock().map_err(|error| error.to_string())?;
        let stdin = guard
            .as_mut()
            .ok_or_else(|| "sidecar stdin unavailable".to_string())?;
        writeln!(stdin, "{line}").map_err(|error| error.to_string())?;
        stdin.flush().map_err(|error| error.to_string())
    }

    fn restart(&self) -> Result<(), String> {
        let launch = self
            .launch
            .clone()
            .ok_or_else(|| "Sidecar 未就绪，请重启 Partner。".to_string())?;
        let app = self
            .app
            .clone()
            .ok_or_else(|| "Sidecar 未就绪，请重启 Partner。".to_string())?;

        let (child, stdout, child_stdin) = spawn_sidecar_process(&launch)?;
        {
            let mut child_guard = self.child.lock().map_err(|error| error.to_string())?;
            if let Some(mut stale_child) = child_guard.take() {
                let _ = stale_child.kill();
            }
            *child_guard = Some(child);
        }
        {
            let mut stdin_guard = self.stdin.lock().map_err(|error| error.to_string())?;
            *stdin_guard = child_stdin;
        }

        spawn_stdout_reader(
            stdout,
            app,
            Arc::clone(&self.stdin),
            Arc::clone(&self.rpc_pending),
            Arc::clone(&self.tool_approvals),
        );
        Ok(())
    }

    pub fn is_running(&self) -> Result<bool, String> {
        let guard = self.child.lock().map_err(|error| error.to_string())?;
        Ok(guard.is_some())
    }

    pub fn info(&self) -> Result<SidecarInfo, String> {
        let running = self.is_running()?;
        Ok(SidecarInfo {
            running,
            error: if running {
                None
            } else {
                self.startup_error.clone()
            },
            needs_node_install: !running && self.needs_node_install,
        })
    }

    pub fn call_rpc(&self, method: &str, params: Value) -> Result<Value, String> {
        self.ensure_connected()?;
        let request_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = mpsc::channel();
        self.rpc_pending
            .lock()
            .map_err(|error| error.to_string())?
            .insert(request_id.clone(), tx);

        let payload = json!({
            "id": request_id,
            "method": method,
            "params": params,
        });
        if let Err(error) = self.write_json(&payload) {
            self.rpc_pending
                .lock()
                .map_err(|error| error.to_string())?
                .remove(&request_id);
            return Err(error);
        }

        let response = rx
            .recv_timeout(Duration::from_secs(30))
            .map_err(|_| "sidecar rpc timed out".to_string())?;

        let event_type = response
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if event_type == "error" {
            let message = response
                .pointer("/data/message")
                .and_then(Value::as_str)
                .unwrap_or("sidecar rpc failed");
            return Err(message.to_string());
        }

        response
            .get("data")
            .cloned()
            .ok_or_else(|| "sidecar rpc returned empty data".to_string())
    }

    pub fn resolve_tool_approval(&self, call_id: String, approved: bool) -> Result<(), String> {
        let notified_via_channel = self
            .tool_approvals
            .lock()
            .map_err(|error| error.to_string())?
            .remove(&call_id)
            .map(|sender| sender.send(approved).is_ok())
            .unwrap_or(false);

        if notified_via_channel {
            return Ok(());
        }

        self.write_json(&json!({
            "type": "tool_approval",
            "data": {
                "callId": call_id,
                "approved": approved,
            }
        }))
    }
}

#[derive(Clone)]
struct SidecarWriter {
    stdin: Arc<Mutex<Option<std::process::ChildStdin>>>,
}

impl SidecarWriter {
    fn write_json(&self, value: &Value) -> Result<(), String> {
        let line = serde_json::to_string(value).map_err(|error| error.to_string())?;
        let mut guard = self.stdin.lock().map_err(|error| error.to_string())?;
        let stdin = guard
            .as_mut()
            .ok_or_else(|| "sidecar stdin unavailable".to_string())?;
        writeln!(stdin, "{line}").map_err(|error| error.to_string())?;
        stdin.flush().map_err(|error| error.to_string())
    }
}

fn spawn_sidecar_process(
    launch: &SidecarLaunch,
) -> Result<(Child, ChildStdout, Option<ChildStdin>), String> {
    let mut child = Command::new(&launch.program)
        .args(&launch.args)
        .current_dir(&launch.cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .env("PARTNER_PROJECT_ROOT", resolve_project_root())
        .spawn()
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                if launch.program == "node" {
                    return NODE_NOT_FOUND_MESSAGE.to_string();
                }
                return format!("Sidecar 运行时未找到：{}", launch.program);
            }
            format!("failed to spawn sidecar: {error}")
        })?;

    let child_stdin = child.stdin.take();
    let stdout = child.stdout.take().ok_or("sidecar stdout unavailable")?;
    Ok((child, stdout, child_stdin))
}

fn spawn_stdout_reader(
    stdout: ChildStdout,
    app: AppHandle,
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    rpc_pending: Arc<Mutex<HashMap<String, mpsc::Sender<Value>>>>,
    tool_approvals: Arc<Mutex<HashMap<String, mpsc::Sender<bool>>>>,
) {
    let writer = SidecarWriter { stdin };
    std::thread::spawn(move || {
        read_stdout_loop(stdout, app, writer, rpc_pending, tool_approvals);
    });
}

fn is_recoverable_pipe_error(error: &str) -> bool {
    error.contains("Broken pipe")
        || error.contains("os error 32")
        || error.contains("sidecar stdin unavailable")
}

fn read_stdout_loop(
    stdout: std::process::ChildStdout,
    app: AppHandle,
    writer: SidecarWriter,
    rpc_pending: Arc<Mutex<HashMap<String, mpsc::Sender<Value>>>>,
    tool_approvals: Arc<Mutex<HashMap<String, mpsc::Sender<bool>>>>,
) {
    let reader = BufReader::new(stdout);
    for line in reader.lines() {
        let line = match line {
            Ok(value) => value,
            Err(error) => {
                eprintln!("[partner] sidecar stdout closed: {error}");
                break;
            }
        };
        if let Err(error) =
            dispatch_sidecar_line(&app, &writer, &line, &rpc_pending, &tool_approvals)
        {
            eprintln!("[partner] sidecar dispatch error: {error}");
        }
    }
}

fn dispatch_sidecar_line(
    app: &AppHandle,
    writer: &SidecarWriter,
    line: &str,
    rpc_pending: &Arc<Mutex<HashMap<String, mpsc::Sender<Value>>>>,
    tool_approvals: &Arc<Mutex<HashMap<String, mpsc::Sender<bool>>>>,
) -> Result<(), String> {
    let event: Value = serde_json::from_str(line).map_err(|error| error.to_string())?;
    let request_id = event
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let event_type = event
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();

    if event_type == "result" || event_type == "error" {
        let mut handled_pending = false;
        if let Ok(mut pending) = rpc_pending.lock() {
            if let Some(tx) = pending.remove(&request_id) {
                let _ = tx.send(event.clone());
                handled_pending = true;
            }
        }
        if handled_pending || event_type == "result" {
            return Ok(());
        }
    }
    let instance_id = event
        .pointer("/data/instanceId")
        .and_then(Value::as_str)
        .unwrap_or_default();

    match event_type {
        "delta" => {
            let delta = event
                .pointer("/data/text")
                .and_then(Value::as_str)
                .unwrap_or_default();
            app.emit(
                "agent:stream:delta",
                json!({
                    "requestId": request_id,
                    "instanceId": instance_id,
                    "delta": delta,
                }),
            )
            .map_err(|error| error.to_string())?;
        }
        "thinking" => {
            let text = event
                .pointer("/data/text")
                .and_then(Value::as_str)
                .unwrap_or_default();
            app.emit(
                "agent:stream:thinking",
                json!({
                    "requestId": request_id,
                    "instanceId": instance_id,
                    "text": text,
                }),
            )
            .map_err(|error| error.to_string())?;
        }
        "tool_call" => {
            let call_id = event
                .pointer("/data/callId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let name = event
                .pointer("/data/name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let input = event
                .pointer("/data/input")
                .cloned()
                .unwrap_or_else(|| json!({}));

            app.emit(
                "agent:stream:tool_call",
                json!({
                    "requestId": request_id,
                    "instanceId": instance_id,
                    "callId": call_id,
                    "name": name,
                    "input": input,
                }),
            )
            .map_err(|error| error.to_string())?;

            if event
                .pointer("/data/handledBySidecar")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                return Ok(());
            }

            let tool_result = execute_tool_call(
                app,
                &request_id,
                instance_id,
                &call_id,
                &name,
                &input,
                tool_approvals,
            )?;
            let mut tool_result_payload = json!({
                "requestId": request_id,
                "instanceId": instance_id,
                "callId": call_id,
                "output": tool_result.pointer("/data/output").and_then(Value::as_str).unwrap_or_default(),
                "isError": tool_result.pointer("/data/isError").and_then(Value::as_bool).unwrap_or(false),
            });
            if let Some(file_change) = tool_result.pointer("/data/fileChange").cloned() {
                tool_result_payload["fileChange"] = file_change;
            }
            app.emit("agent:stream:tool_result", tool_result_payload)
                .map_err(|error| error.to_string())?;
            writer.write_json(&tool_result)?;
        }
        "tool_result" => {
            let mut tool_result_payload = json!({
                "requestId": request_id,
                "instanceId": instance_id,
                "callId": event.pointer("/data/callId").and_then(Value::as_str).unwrap_or_default(),
                "output": event.pointer("/data/output").and_then(Value::as_str).unwrap_or_default(),
                "isError": event.pointer("/data/isError").and_then(Value::as_bool).unwrap_or(false),
            });
            if let Some(file_change) = event.pointer("/data/fileChange").cloned() {
                tool_result_payload["fileChange"] = file_change;
            }
            app.emit("agent:stream:tool_result", tool_result_payload)
                .map_err(|error| error.to_string())?;
        }
        "tool_approval_required" => {
            let call_id = event
                .pointer("/data/callId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let name = event
                .pointer("/data/name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let input = event
                .pointer("/data/input")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let reason = event
                .pointer("/data/reason")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let allow_dir = event
                .pointer("/data/allowDir")
                .and_then(Value::as_str)
                .map(str::to_string);

            app.emit(
                "agent:tool_approval_required",
                json!({
                    "requestId": request_id,
                    "instanceId": instance_id,
                    "callId": call_id,
                    "name": name,
                    "input": input,
                    "reason": reason,
                    "allowDir": allow_dir,
                }),
            )
            .map_err(|error| error.to_string())?;
        }
        "usage" => {
            app.emit(
                "agent:stream:usage",
                json!({
                    "requestId": request_id,
                    "instanceId": instance_id,
                    "usage": event.pointer("/data/usage").cloned(),
                }),
            )
            .map_err(|error| error.to_string())?;
        }
        "done" => {
            app.emit(
                "agent:stream:done",
                json!({
                    "requestId": request_id,
                    "instanceId": instance_id,
                    "text": event.pointer("/data/text").and_then(Value::as_str),
                    "usage": event.pointer("/data/usage").cloned(),
                }),
            )
            .map_err(|error| error.to_string())?;
        }
        "error" => {
            app.emit(
                "agent:stream:error",
                json!({
                    "requestId": request_id,
                    "instanceId": instance_id,
                    "message": event
                        .pointer("/data/message")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown error"),
                }),
            )
            .map_err(|error| error.to_string())?;
        }
        "ready" => {
            app.emit(
                "agent:stream:ready",
                json!({
                    "requestId": request_id,
                    "instanceId": instance_id,
                }),
            )
            .map_err(|error| error.to_string())?;
        }
        other => {
            eprintln!("[partner] ignored sidecar event: {other}");
        }
    }

    Ok(())
}

fn tool_result_message(request_id: &str, call_id: &str, output: String, is_error: bool) -> Value {
    json!({
        "id": request_id,
        "type": "tool_result",
        "data": {
            "callId": call_id,
            "output": output,
            "isError": is_error,
        }
    })
}

fn execute_tool_call(
    app: &AppHandle,
    request_id: &str,
    instance_id: &str,
    call_id: &str,
    name: &str,
    input: &Value,
    tool_approvals: &Arc<Mutex<HashMap<String, mpsc::Sender<bool>>>>,
) -> Result<Value, String> {
    match execute_partner_tool(name, input, false) {
        Ok(output) => Ok(tool_result_message(request_id, call_id, output, false)),
        Err(PartnerToolError::Failed(message)) => {
            Ok(tool_result_message(request_id, call_id, message, true))
        }
        Err(PartnerToolError::ApprovalRequired(approval)) => {
            let (tx, rx) = mpsc::channel();
            tool_approvals
                .lock()
                .map_err(|error| error.to_string())?
                .insert(call_id.to_string(), tx);

            app.emit(
                "agent:tool_approval_required",
                json!({
                    "requestId": request_id,
                    "instanceId": instance_id,
                    "callId": call_id,
                    "name": name,
                    "input": input,
                    "reason": approval.reason,
                    "cmd": approval.cmd,
                    "args": approval.args,
                    "cwd": approval.cwd,
                }),
            )
            .map_err(|error| error.to_string())?;

            let approved = rx.recv_timeout(Duration::from_secs(300));
            let _ = tool_approvals
                .lock()
                .map_err(|error| error.to_string())?
                .remove(call_id);
            let approved = match approved {
                Ok(value) => value,
                Err(_) => {
                    return Ok(tool_result_message(
                        request_id,
                        call_id,
                        "用户未在 5 分钟内完成命令授权".to_string(),
                        true,
                    ));
                }
            };

            if !approved {
                return Ok(tool_result_message(
                    request_id,
                    call_id,
                    "用户拒绝授权执行该命令".to_string(),
                    true,
                ));
            }

            match execute_partner_tool(name, input, true) {
                Ok(output) => Ok(tool_result_message(request_id, call_id, output, false)),
                Err(PartnerToolError::Failed(message)) => {
                    Ok(tool_result_message(request_id, call_id, message, true))
                }
                Err(PartnerToolError::ApprovalRequired(approval)) => Ok(tool_result_message(
                    request_id,
                    call_id,
                    approval.reason,
                    true,
                )),
            }
        }
    }
}

fn find_repo_root() -> Result<PathBuf, String> {
    if let Ok(cwd) = std::env::current_dir() {
        for ancestor in cwd.ancestors() {
            if ancestor.join("pnpm-workspace.yaml").exists() {
                return Ok(ancestor.to_path_buf());
            }
        }
    }
    Err("monorepo root not found".to_string())
}

pub fn find_sidecar_entry(app: &AppHandle) -> Result<SidecarLaunch, String> {
    let program = resolve_node_program(app)?;

    if let Ok(script) = std::env::var("PARTNER_SIDECAR_SCRIPT") {
        let path = PathBuf::from(&script);
        let cwd = path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."));
        return Ok(SidecarLaunch {
            program,
            args: vec![script],
            cwd,
        });
    }

    for rel in [
        "sidecar/partner-sidecar.mjs",
        "sidecar/partner-sidecar.cjs",
        "sidecar/index.js",
    ] {
        if let Ok(path) = app.path().resolve(rel, BaseDirectory::Resource) {
            if path.exists() {
                let cwd = path
                    .parent()
                    .map(Path::to_path_buf)
                    .unwrap_or_else(|| PathBuf::from("."));
                return Ok(SidecarLaunch {
                    program,
                    args: vec![path.to_string_lossy().to_string()],
                    cwd,
                });
            }
        }
    }

    if let Ok(repo_root) = find_repo_root() {
        let dist = repo_root.join("apps/partner/sidecar/dist/index.js");
        if dist.exists() {
            return Ok(SidecarLaunch {
                program: resolve_node_program(app)?,
                args: vec![dist.to_string_lossy().to_string()],
                cwd: repo_root.join("apps/partner/sidecar"),
            });
        }

        let bundle = repo_root.join("apps/partner/sidecar/dist/partner-sidecar.mjs");
        if bundle.exists() {
            return Ok(SidecarLaunch {
                program: resolve_node_program(app)?,
                args: vec![bundle.to_string_lossy().to_string()],
                cwd: repo_root.join("apps/partner/sidecar"),
            });
        }

        let legacy_bundle = repo_root.join("apps/partner/sidecar/dist/partner-sidecar.cjs");
        if legacy_bundle.exists() {
            return Ok(SidecarLaunch {
                program: resolve_node_program(app)?,
                args: vec![legacy_bundle.to_string_lossy().to_string()],
                cwd: repo_root.join("apps/partner/sidecar"),
            });
        }

        return Ok(SidecarLaunch {
            program: "pnpm".to_string(),
            args: vec![
                "--filter".to_string(),
                "@vera/partner-sidecar".to_string(),
                "dev".to_string(),
            ],
            cwd: repo_root,
        });
    }

    Err("sidecar entry not found (no bundled resource or monorepo dev path)".to_string())
}

const NODE_NOT_FOUND_MESSAGE: &str =
    "未检测到 Node.js。请安装 Node.js 20 或更高版本后重启 Partner。\n下载地址：https://nodejs.org/";

const BUNDLED_NODE_MISSING_MESSAGE: &str =
    "内置 Node.js 运行时缺失或无法启动。请重新安装 Partner，或改用 Partner-SystemNode 版本。";

fn read_sidecar_node_mode(app: &AppHandle) -> Option<String> {
    let path = app.path().resolve("sidecar/runtime.json", BaseDirectory::Resource).ok()?;
    let raw = std::fs::read_to_string(path).ok()?;
    let value = serde_json::from_str::<Value>(&raw).ok()?;
    value
        .get("nodeMode")
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn bundled_node_path(app: &AppHandle) -> Option<PathBuf> {
    let relatives: &[&str] = if cfg!(target_os = "windows") {
        &[
            "sidecar/node.exe",
            "sidecar/bin/node.exe",
            "sidecar/node",
            "sidecar/bin/node",
        ]
    } else {
        &[
            "sidecar/node",
            "sidecar/bin/node",
            "sidecar/node.exe",
            "sidecar/bin/node.exe",
        ]
    };
    for rel in relatives {
        if let Ok(path) = app.path().resolve(rel, BaseDirectory::Resource) {
            if path.is_file() {
                return Some(path);
            }
        }
    }
    None
}

fn system_node_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    #[cfg(target_os = "macos")]
    {
        candidates.push(PathBuf::from("/opt/homebrew/bin/node"));
        candidates.push(PathBuf::from("/usr/local/bin/node"));

        if let Ok(home) = std::env::var("HOME") {
            let nvm_root = PathBuf::from(home).join(".nvm/versions/node");
            if let Ok(entries) = std::fs::read_dir(&nvm_root) {
                let mut versions: Vec<PathBuf> = entries
                    .filter_map(Result::ok)
                    .map(|entry| entry.path().join("bin/node"))
                    .filter(|path| path.is_file())
                    .collect();
                versions.sort();
                candidates.extend(versions);
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        candidates.push(PathBuf::from("node.exe"));
        if let Ok(program_files) = std::env::var("ProgramFiles") {
            candidates.push(PathBuf::from(program_files).join("nodejs\\node.exe"));
        }
        if let Ok(program_files_x86) = std::env::var("ProgramFiles(x86)") {
            candidates.push(PathBuf::from(program_files_x86).join("nodejs\\node.exe"));
        }
        if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
            candidates.push(PathBuf::from(local_app_data).join("Programs\\nodejs\\node.exe"));
        }
    }

    candidates.push(PathBuf::from("node"));
    candidates
}

fn node_command_available(program: &Path) -> bool {
    Command::new(program)
        .arg("-v")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn resolve_node_program(app: &AppHandle) -> Result<String, String> {
    if let Ok(node) = std::env::var("PARTNER_NODE") {
        if node == "node"
            || node == "node.exe"
            || Path::new(&node).is_file()
            || node_command_available(Path::new(&node))
        {
            return Ok(node);
        }
    }

    if let Some(path) = bundled_node_path(app) {
        return Ok(path.to_string_lossy().to_string());
    }

    for candidate in system_node_candidates() {
        if candidate.is_file() || node_command_available(&candidate) {
            return Ok(candidate.to_string_lossy().to_string());
        }
    }

    match read_sidecar_node_mode(app).as_deref() {
        Some("bundled") => Err(BUNDLED_NODE_MISSING_MESSAGE.to_string()),
        _ => Err(NODE_NOT_FOUND_MESSAGE.to_string()),
    }
}

pub fn resolve_project_root() -> String {
    if let Ok(root) = std::env::var("PARTNER_PROJECT_ROOT") {
        return root;
    }
    if let Ok(cwd) = std::env::current_dir() {
        for ancestor in cwd.ancestors() {
            if ancestor.join(".vera/settings.json").exists() {
                return ancestor.to_string_lossy().to_string();
            }
            if ancestor.join("pnpm-workspace.yaml").exists() {
                return ancestor.to_string_lossy().to_string();
            }
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        let home_path = PathBuf::from(&home);
        if home_path.join(".vera/settings.json").exists() {
            return home;
        }
        let open_vera = home_path.join("workspace/open-vera");
        if open_vera.join(".vera/settings.json").exists() {
            return open_vera.to_string_lossy().to_string();
        }
    }
    std::env::var("HOME").unwrap_or_else(|_| ".".to_string())
}
