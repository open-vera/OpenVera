//! Host-owned agent orchestration (queue / abort). Sidecar remains Extension Host.

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::sidecar::SidecarManager;

use super::protocol::{HostDomainEvent, HOST_EVENT};
use super::state::{now_ms, HostState, QueuedTask, SessionRecord};
use super::HostHandle;

pub fn create_session(
    state: &mut HostState,
    project_id: Option<String>,
    title: Option<String>,
) -> String {
    let id = Uuid::new_v4().to_string();
    let now = now_ms();
    let title = title.unwrap_or_else(|| "New chat".to_string());
    state.sessions.insert(
        id.clone(),
        SessionRecord {
            id: id.clone(),
            project_id,
            title,
            messages: Vec::new(),
            last_error: None,
            last_task_id: None,
            created_at: now,
            updated_at: now,
        },
    );
    if !state.open_tab_ids.contains(&id) {
        state.open_tab_ids.push(id.clone());
    }
    state.active_tab_id = Some(id.clone());
    state.bump();
    id
}

pub fn send_message(
    app: &AppHandle,
    host: &HostHandle,
    sidecar: &SidecarManager,
    session_id: &str,
    text: &str,
    project_root: Option<String>,
    llm_config: Option<Value>,
    agent_mode: Option<String>,
) -> Result<Value, String> {
    let task_id = Uuid::new_v4().to_string();
    let user_msg = json!({
        "id": task_id,
        "role": "user",
        "content": text,
        "timestamp": now_ms(),
    });

    let maybe_task = host.with_mut(|state| {
        if !state.sessions.contains_key(session_id) {
            return Err(format!("unknown session: {session_id}"));
        }
        if let Some(session) = state.sessions.get_mut(session_id) {
            session.messages.push(user_msg);
            session.updated_at = now_ms();
            // Persisted so "open run log" still resolves after a restart.
            session.last_task_id = Some(task_id.clone());
            if session.title == "New chat" || session.title.is_empty() {
                let trimmed = text.trim();
                session.title = if trimmed.chars().count() > 40 {
                    format!("{}…", trimmed.chars().take(40).collect::<String>())
                } else if trimmed.is_empty() {
                    session.title.clone()
                } else {
                    trimmed.to_string()
                };
            }
        }

        let task = QueuedTask {
            id: task_id.clone(),
            session_id: session_id.to_string(),
            text: text.to_string(),
            project_root,
            llm_config,
            agent_mode,
            created_at: now_ms(),
        };

        if state.orchestrator.running_session_id.is_some() {
            state.orchestrator.queue.push_back(task);
            state.bump();
            return Ok(None);
        }
        Ok(Some(task))
    })?;

    if let Some(task) = maybe_task {
        start_task(app, host, sidecar, task)?;
        Ok(json!({ "queued": false, "taskId": task_id }))
    } else {
        Ok(json!({ "queued": true, "taskId": task_id }))
    }
}

fn start_task(
    app: &AppHandle,
    host: &HostHandle,
    sidecar: &SidecarManager,
    task: QueuedTask,
) -> Result<(), String> {
    let request_id = Uuid::new_v4().to_string();
    let instance_id = format!("host-{}", &task.session_id);

    let (mut history, root) = host.with_mut(|state| {
        let history: Vec<Value> = state
            .sessions
            .get(&task.session_id)
            .map(|s| {
                s.messages
                    .iter()
                    .filter_map(|msg| {
                        let role = msg.get("role")?.as_str()?;
                        let content = msg
                            .get("agentContent")
                            .or_else(|| msg.get("content"))?
                            .as_str()?;
                        if role == "user" || role == "assistant" {
                            Some(json!({ "role": role, "content": content }))
                        } else {
                            None
                        }
                    })
                    .collect()
            })
            .unwrap_or_default();

        let root = task
            .project_root
            .clone()
            .or_else(|| {
                state
                    .sessions
                    .get(&task.session_id)
                    .and_then(|s| s.project_id.as_ref())
                    .and_then(|pid| {
                        state
                            .projects
                            .iter()
                            .find(|p| p.id == *pid)
                            .map(|p| p.root_path.clone())
                    })
            })
            .unwrap_or_else(crate::sidecar::resolve_project_root);

        (history, root)
    });

    if history
        .last()
        .and_then(|m| m.get("role"))
        .and_then(|r| r.as_str())
        == Some("user")
    {
        history.pop();
    }

    let payload = json!({
        "id": request_id,
        "method": "agent.run",
        "params": {
            "sessionId": task.session_id,
            "instanceId": instance_id,
            "message": task.text,
            "history": history,
            "projectRoot": root,
            "llmConfig": task.llm_config,
            "taskId": task.id,
            "agentMode": task.agent_mode,
        }
    });

    sidecar.write_json(&payload)?;
    host.with_mut(|state| {
        state.orchestrator.running_session_id = Some(task.session_id.clone());
        state.orchestrator.running_request_id = Some(request_id.clone());
        state.bump();
    });

    let _ = app.emit(
        HOST_EVENT,
        HostDomainEvent::AgentStream {
            session_id: task.session_id,
            event: json!({ "type": "run_started", "requestId": request_id, "taskId": task.id }),
        },
    );
    Ok(())
}

pub fn abort_session(
    host: &HostHandle,
    sidecar: &SidecarManager,
    session_id: &str,
) -> Result<(), String> {
    host.with_mut(|state| {
        state.orchestrator.queue.retain(|t| t.session_id != session_id);
        if state.orchestrator.running_session_id.as_deref() == Some(session_id) {
            state.orchestrator.running_session_id = None;
            state.orchestrator.running_request_id = None;
        }
        state.bump();
    });

    // Always forward the abort, even when the host no longer believes this
    // session is running: after a sidecar restart or a lost `done` event the
    // bookkeeping drifts, and a stop click must still reach the agent. The
    // sidecar side is idempotent (unknown session is a no-op).
    let request_id = Uuid::new_v4().to_string();
    sidecar.write_json(&json!({
        "id": request_id,
        "method": "agent.abort",
        "params": { "sessionId": session_id },
    }))?;
    Ok(())
}

pub async fn on_agent_done_unlocked(
    app: &AppHandle,
    host: &HostHandle,
    sidecar: &SidecarManager,
    session_id: &str,
) -> Result<(), String> {
    let next = host.with_mut(|state| {
        if state.orchestrator.running_session_id.as_deref() == Some(session_id) {
            state.orchestrator.running_session_id = None;
            state.orchestrator.running_request_id = None;
        }
        let next = state.orchestrator.queue.pop_front();
        if next.is_none() {
            state.bump();
        }
        next
    });
    if let Some(next) = next {
        start_task(app, host, sidecar, next)?;
    }
    Ok(())
}
