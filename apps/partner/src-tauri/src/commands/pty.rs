use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;

use portable_pty::{CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

const EVENT_DATA: &str = "pty:data";
const EVENT_EXIT: &str = "pty:exit";

pub struct PtyManager {
    sessions: Mutex<HashMap<String, PtySession>>,
}

struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn portable_pty::ChildKiller + Send + Sync>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtySpawnResult {
    pub id: String,
    pub title: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PtyDataPayload {
    id: String,
    data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PtyExitPayload {
    id: String,
    code: Option<i32>,
}

impl Default for PtyManager {
    fn default() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }
}

fn default_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| {
        if cfg!(windows) {
            "powershell.exe".to_string()
        } else {
            "/bin/zsh".to_string()
        }
    })
}

fn session_title() -> String {
    let user = std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_else(|_| "shell".to_string());
    let host = std::fs::read_to_string("/etc/hostname")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| std::env::var("HOSTNAME").ok())
        .or_else(|| std::env::var("COMPUTERNAME").ok())
        .unwrap_or_else(|| "local".to_string());
    format!("{user}@{host}")
}

fn build_shell_command(cwd: Option<&str>) -> Result<CommandBuilder, String> {
    let shell = default_shell();
    let mut cmd = CommandBuilder::new(&shell);
    if !cfg!(windows) {
        cmd.arg("-l");
    }
    if let Some(dir) = cwd {
        if !dir.is_empty() {
            cmd.cwd(dir);
        }
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    Ok(cmd)
}

#[tauri::command]
pub async fn pty_spawn(
    app: AppHandle,
    state: State<'_, Arc<PtyManager>>,
    cwd: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<PtySpawnResult, String> {
    let id = Uuid::new_v4().to_string();
    let cols = cols.unwrap_or(80).max(20);
    let rows = rows.unwrap_or(24).max(5);
    let title = session_title();

    let manager = Arc::clone(&state);
    let app_handle = app.clone();
    let spawn_id = id.clone();
    let cwd_owned = cwd;

    tauri::async_runtime::spawn_blocking(move || {
        let pty_system = NativePtySystem::default();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| error.to_string())?;

        let cmd = build_shell_command(cwd_owned.as_deref())?;
        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|error| error.to_string())?;
        drop(pair.slave);

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| error.to_string())?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| error.to_string())?;
        let killer = child
            .clone_killer();

        {
            let mut sessions = manager
                .sessions
                .lock()
                .map_err(|_| "pty manager poisoned".to_string())?;
            sessions.insert(
                spawn_id.clone(),
                PtySession {
                    master: pair.master,
                    writer: Mutex::new(writer),
                    killer: Mutex::new(killer),
                },
            );
        }

        let read_id = spawn_id.clone();
        let read_app = app_handle.clone();
        thread::spawn(move || {
            let mut buffer = [0u8; 8192];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(n) => {
                        let data = String::from_utf8_lossy(&buffer[..n]).to_string();
                        let _ = read_app.emit(
                            EVENT_DATA,
                            PtyDataPayload {
                                id: read_id.clone(),
                                data,
                            },
                        );
                    }
                    Err(_) => break,
                }
            }
        });

        let wait_id = spawn_id.clone();
        let wait_app = app_handle.clone();
        let wait_manager = Arc::clone(&manager);
        thread::spawn(move || {
            let code = child.wait().ok().map(|status| status.exit_code() as i32);
            let _ = wait_app.emit(
                EVENT_EXIT,
                PtyExitPayload {
                    id: wait_id.clone(),
                    code,
                },
            );
            if let Ok(mut sessions) = wait_manager.sessions.lock() {
                sessions.remove(&wait_id);
            }
        });

        Ok::<(), String>(())
    })
    .await
    .map_err(|error| error.to_string())??;

    Ok(PtySpawnResult { id, title })
}

#[tauri::command]
pub async fn pty_write(state: State<'_, Arc<PtyManager>>, id: String, data: String) -> Result<(), String> {
    let manager = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || {
        let sessions = manager
            .sessions
            .lock()
            .map_err(|_| "pty manager poisoned".to_string())?;
        let session = sessions
            .get(&id)
            .ok_or_else(|| format!("pty session not found: {id}"))?;
        let mut writer = session
            .writer
            .lock()
            .map_err(|_| "pty writer poisoned".to_string())?;
        writer
            .write_all(data.as_bytes())
            .map_err(|error| error.to_string())?;
        writer.flush().map_err(|error| error.to_string())?;
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn pty_resize(
    state: State<'_, Arc<PtyManager>>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let manager = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || {
        let sessions = manager
            .sessions
            .lock()
            .map_err(|_| "pty manager poisoned".to_string())?;
        let session = sessions
            .get(&id)
            .ok_or_else(|| format!("pty session not found: {id}"))?;
        session
            .master
            .resize(PtySize {
                rows: rows.max(1),
                cols: cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn pty_kill(state: State<'_, Arc<PtyManager>>, id: String) -> Result<(), String> {
    let manager = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || {
        let mut sessions = manager
            .sessions
            .lock()
            .map_err(|_| "pty manager poisoned".to_string())?;
        let Some(session) = sessions.remove(&id) else {
            return Ok(());
        };
        let mut killer = session
            .killer
            .lock()
            .map_err(|_| "pty killer poisoned".to_string())?;
        let _ = killer.kill();
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}
