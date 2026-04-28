use std::io::BufRead;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use tauri::Manager;

struct PythonServer {
    child: Mutex<Option<Child>>,
    port: Mutex<u16>,
}

/// 查找 veralabel 可执行路径（优先 venv → sidecar → PATH）
fn find_audio_label() -> String {
    // 1. 开发模式：相对于 gui/src-tauri/ 的 venv
    if let Some(path) = std::env::current_dir().ok().and_then(|d| {
        for ancestor in d.ancestors() {
            let candidate = ancestor.join(".venv/bin/veralabel");
            if candidate.exists() {
                return Some(candidate.to_string_lossy().to_string());
            }
        }
        None
    }) {
        return path;
    }

    // 2. Release 模式：sidecar 在同目录（Tauri externalBin 放在 Contents/MacOS/）
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            // Tauri sidecar 命名约定：veralabel-{target-triple}
            let candidates = [
                "veralabel-aarch64-apple-darwin",
                "veralabel-x86_64-apple-darwin",
                "veralabel",
            ];
            for name in candidates {
                let p = exe_dir.join(name);
                if p.exists() {
                    return p.to_string_lossy().to_string();
                }
            }
        }
    }

    // 3. fallback：PATH 中查找
    "veralabel".to_string()
}

fn spawn_python_server() -> (Child, u16) {
    let bin = find_audio_label();
    eprintln!("[tauri] spawning python server: {} serve --port 0", bin);

    let mut cmd = Command::new(&bin);
    cmd.args(["serve", "--port", "0"])
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());

    // Release 模式下告诉 Python 服务使用 bundled 路径
    // 判断依据：venv 路径不存在（即非开发模式）
    let is_dev = std::env::current_dir().ok().map_or(false, |d| {
        d.ancestors().any(|a| a.join(".venv/bin/veralabel").exists())
    });
    if !is_dev {
        cmd.env("AUDIO_LABEL_BUNDLED", "1");
        if let Some(home) = std::env::var_os("HOME") {
            let app_support = std::path::PathBuf::from(home)
                .join("Library/Application Support/com.vera.veralabel");
            cmd.env("AUDIO_LABEL_DATA_DIR", &app_support);
        }
    }

    let mut child = cmd.spawn()
        .unwrap_or_else(|e| panic!("无法启动 Python 服务 ({}): {}", bin, e));

    // 从 stdout 读取 AUDIO_LABEL_PORT=XXXX
    let stdout = child.stdout.take().expect("failed to capture stdout");
    let reader = std::io::BufReader::new(stdout);
    let mut port: u16 = 0;

    for line in reader.lines() {
        let line = line.expect("failed to read stdout line");
        eprintln!("[python] {}", line);
        if let Some(p) = line.strip_prefix("AUDIO_LABEL_PORT=") {
            port = p.trim().parse().expect("invalid port number");
            break;
        }
    }

    if port == 0 {
        panic!("Python 服务未输出端口号");
    }

    eprintln!("[tauri] python server started on port {}", port);
    (child, port)
}

#[tauri::command]
fn get_server_port(state: tauri::State<PythonServer>) -> u16 {
    *state.port.lock().unwrap()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![get_server_port])
        .setup(|app| {
            // 启动 Python 服务
            let (child, port) = spawn_python_server();
            app.manage(PythonServer {
                child: Mutex::new(Some(child)),
                port: Mutex::new(port),
            });

            #[cfg(debug_assertions)]
            {
                let window = app.get_webview_window("main").unwrap();
                window.open_devtools();
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                // 窗口关闭时停止 Python 进程 + 释放 Ollama
                if let Some(state) = window.try_state::<PythonServer>() {
                    if let Ok(mut guard) = state.child.lock() {
                        if let Some(ref mut child) = *guard {
                            eprintln!("[tauri] shutting down python server");

                            // 1. SIGTERM → 让 Python 优雅退出（释放资源）
                            let pid = child.id();
                            let _ = Command::new("kill")
                                .args(["-TERM", &pid.to_string()])
                                .spawn();

                            // 2. 等待最多 2s 后 SIGKILL 兜底
                            std::thread::sleep(std::time::Duration::from_millis(2000));
                            let _ = child.kill();
                        }
                    }
                }

                // 3. 卸载 Ollama 中已加载的模型，释放显存/内存
                //    pkill 只在 VeraLabel 启动的 Ollama 实例存在时生效
                eprintln!("[tauri] stopping ollama");
                let _ = Command::new("pkill").args(["-x", "ollama"]).spawn();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
