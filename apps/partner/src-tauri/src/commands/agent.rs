use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;

use crate::sidecar::{resolve_project_root, SidecarManager};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmRuntimeConfig {
    pub provider: String,
    pub protocol: String,
    pub api_base_url: String,
    pub model: String,
    pub api_key: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunResponse {
    pub request_id: String,
}

#[tauri::command]
pub async fn agent_run(
    sidecar: State<'_, SidecarManager>,
    request_id: String,
    instance_id: String,
    session_id: String,
    message: String,
    history: Vec<HistoryMessage>,
    project_root: Option<String>,
    llm_config: Option<LlmRuntimeConfig>,
) -> Result<AgentRunResponse, String> {
    let root = project_root.unwrap_or_else(resolve_project_root);
    let payload = serde_json::json!({
        "id": request_id,
        "method": "agent.run",
        "params": {
            "sessionId": session_id,
            "instanceId": instance_id,
            "message": message,
            "history": history,
            "projectRoot": root,
            "llmConfig": llm_config,
        }
    });
    sidecar.write_json(&payload)?;
    Ok(AgentRunResponse { request_id })
}

#[tauri::command]
pub async fn agent_abort(
    sidecar: State<'_, SidecarManager>,
    session_id: String,
) -> Result<(), String> {
    let request_id = uuid::Uuid::new_v4().to_string();
    let payload = serde_json::json!({
        "id": request_id,
        "method": "agent.abort",
        "params": {
            "sessionId": session_id,
        }
    });
    sidecar.write_json(&payload)
}

#[tauri::command]
pub async fn agent_tool_approval(
    sidecar: State<'_, SidecarManager>,
    call_id: String,
    approved: bool,
) -> Result<(), String> {
    sidecar.resolve_tool_approval(call_id, approved)
}

#[tauri::command]
pub fn sidecar_status(sidecar: State<'_, SidecarManager>) -> Result<bool, String> {
    sidecar.is_running()
}

#[tauri::command]
pub async fn inspect_llm_config(
    project_root: Option<String>,
    llm_config: Option<LlmRuntimeConfig>,
    reveal_secrets: Option<bool>,
) -> Result<Value, String> {
    let root = project_root.unwrap_or_else(resolve_project_root);
    let reveal = reveal_secrets.unwrap_or(false);
    if let Some(config) = llm_config {
        let adapter = adapter_for_protocol(&config.protocol);
        return Ok(json!({
            "source": "partner-settings",
            "sourceLabel": "Partner settings keychain",
            "projectRoot": root,
            "provider": config.provider,
            "adapter": adapter,
            "protocol": config.protocol,
            "model": config.model,
            "apiBaseUrl": config.api_base_url,
            "apiKeyAvailable": !config.api_key.is_empty(),
            "apiKeySource": "partner-keychain",
            "apiKeySourceLabel": "Partner keychain",
            "apiKeyValue": if reveal { Some(config.api_key) } else { None },
            "configPath": Value::Null,
            "configExists": false,
        }));
    }

    inspect_vera_config(&root, reveal)
}

#[tauri::command]
pub async fn save_vera_llm_config(
    project_root: Option<String>,
    provider: String,
    protocol: String,
    api_base_url: String,
    model: String,
    api_key: Option<String>,
) -> Result<Value, String> {
    let root = project_root.unwrap_or_else(resolve_project_root);
    let path = writable_config_path(&root);
    let mut config = if path.exists() {
        let raw = fs::read_to_string(&path).map_err(|error| error.to_string())?;
        serde_json::from_str::<Value>(&raw).map_err(|error| error.to_string())?
    } else {
        json!({})
    };

    let adapter = adapter_for_protocol(&protocol);
    let provider_config = config
        .pointer_mut(&format!("/providers/{provider}"))
        .and_then(Value::as_object_mut);

    if provider_config.is_none() {
        if !config.get("providers").is_some_and(Value::is_object) {
            config["providers"] = json!({});
        }
        config["providers"][&provider] = json!({});
    }

    let provider_config = config
        .pointer_mut(&format!("/providers/{provider}"))
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "Failed to prepare provider config".to_string())?;
    provider_config.insert("adapter".to_string(), Value::String(adapter.to_string()));
    if api_base_url.trim().is_empty() {
        provider_config.remove("base_url");
    } else {
        provider_config.insert("base_url".to_string(), Value::String(api_base_url));
    }
    if let Some(next_key) = api_key.map(|value| value.trim().to_string()) {
        if next_key.is_empty() {
            provider_config.remove("api_key");
        } else {
            provider_config.insert("api_key".to_string(), Value::String(next_key));
        }
    }

    if !config.get("models").is_some_and(Value::is_object) {
        config["models"] = json!({});
    }
    config["models"][&model] = json!({
        "provider": provider,
    });
    config["default_provider"] = Value::String(provider);
    config["default_model"] = Value::String(model);

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(
        &path,
        serde_json::to_string_pretty(&config).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;

    inspect_vera_config(&root, false)
}

fn inspect_vera_config(root: &str, reveal: bool) -> Result<Value, String> {
    let location = resolve_config_location(root);
    let config = if location.exists {
        let raw = fs::read_to_string(&location.path).map_err(|error| error.to_string())?;
        serde_json::from_str::<Value>(&raw).map_err(|error| error.to_string())?
    } else {
        json!({})
    };
    let target = resolve_default_target(&config);
    let provider_config = provider_config_for(&config, &target.provider, &target.model);
    let adapter = provider_config
        .get("adapter")
        .and_then(Value::as_str)
        .unwrap_or("anthropic")
        .to_string();
    let api_base_url = provider_config
        .get("base_url")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let configured_key = provider_config
        .get("api_key")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let env_key_name = env_var_for(&adapter, &target.provider);
    let env_key = resolve_env_key(&adapter, &target.provider);
    let key_value = configured_key.clone().or(env_key.clone());
    let api_key_available = key_value.is_some();

    Ok(json!({
        "source": if location.exists { "vera-config" } else if env_key.is_some() { "environment" } else { "missing" },
        "sourceLabel": if location.exists { "Vera config" } else if env_key.is_some() { "Environment" } else { "Not configured" },
        "projectRoot": root,
        "provider": target.provider,
        "adapter": adapter,
        "protocol": adapter,
        "model": target.model,
        "apiBaseUrl": api_base_url,
        "apiKeyAvailable": api_key_available,
        "apiKeySource": if configured_key.is_some() { "vera-config" } else if env_key.is_some() { "environment" } else { "missing" },
        "apiKeySourceLabel": if configured_key.is_some() { "Vera config api_key".to_string() } else if env_key.is_some() { env_key_name.clone() } else { "Not found".to_string() },
        "apiKeyValue": if reveal { key_value } else { None },
        "envKeyName": env_key_name,
        "configPath": location.path.to_string_lossy().to_string(),
        "configScope": location.scope,
        "configExists": location.exists,
    }))
}

fn writable_config_path(root: &str) -> PathBuf {
    if let Ok(config_dir) = std::env::var("VERA_CONFIG_DIR") {
        return PathBuf::from(config_dir).join("settings.json");
    }

    let project_path = Path::new(root).join(".vera/settings.json");
    if project_path.exists() {
        return project_path;
    }

    std::env::var("HOME")
        .map(|home| PathBuf::from(home).join(".vera/settings.json"))
        .unwrap_or_else(|_| PathBuf::from(".vera/settings.json"))
}

struct ConfigLocation {
    path: PathBuf,
    scope: &'static str,
    exists: bool,
}

struct Target {
    provider: String,
    model: String,
}

fn resolve_config_location(root: &str) -> ConfigLocation {
    if let Ok(config_dir) = std::env::var("VERA_CONFIG_DIR") {
        let path = PathBuf::from(config_dir).join("settings.json");
        let exists = path.exists();
        return ConfigLocation {
            path,
            scope: "env",
            exists,
        };
    }

    let project_path = Path::new(root).join(".vera/settings.json");
    if project_path.exists() {
        return ConfigLocation {
            path: project_path,
            scope: "project",
            exists: true,
        };
    }

    let global_path = std::env::var("HOME")
        .map(|home| PathBuf::from(home).join(".vera/settings.json"))
        .unwrap_or_else(|_| PathBuf::from(".vera/settings.json"));
    let exists = global_path.exists();
    ConfigLocation {
        path: global_path,
        scope: "global",
        exists,
    }
}

fn resolve_default_target(config: &Value) -> Target {
    if config.pointer("/routing/enabled").and_then(Value::as_bool) == Some(true) {
        if let Some(route) = config.pointer("/routing/l1") {
            return resolve_model_reference(config, route);
        }
    }
    if let Some(model) = config.get("default_model").and_then(Value::as_str) {
        return resolve_model_reference(config, &Value::String(model.to_string()));
    }
    Target {
        provider: resolve_default_provider(config),
        model: "claude-opus-4-6".to_string(),
    }
}

fn resolve_model_reference(config: &Value, reference: &Value) -> Target {
    if let Some(route) = reference.as_object() {
        if let (Some(provider), Some(model)) = (
            route.get("provider").and_then(Value::as_str),
            route.get("model").and_then(Value::as_str),
        ) {
            return Target {
                provider: provider.to_string(),
                model: model.to_string(),
            };
        }
    }

    let alias = reference.as_str().unwrap_or("claude-opus-4-6");
    if let Some(model_config) = config
        .pointer(&format!("/models/{alias}"))
        .and_then(Value::as_object)
    {
        if let Some(provider) = model_config.get("provider").and_then(Value::as_str) {
            let model = model_config
                .get("model")
                .and_then(Value::as_str)
                .unwrap_or(alias)
                .to_string();
            return Target {
                provider: provider.to_string(),
                model,
            };
        }
    }

    Target {
        provider: resolve_default_provider(config),
        model: alias.to_string(),
    }
}

fn resolve_default_provider(config: &Value) -> String {
    if let Some(provider) = config.get("default_provider").and_then(Value::as_str) {
        return provider.to_string();
    }
    let providers = config.get("providers").and_then(Value::as_object);
    if let Some(providers) = providers {
        if providers.len() == 1 {
            if let Some(name) = providers.keys().next() {
                return name.to_string();
            }
        }
        if providers.contains_key("anthropic") {
            return "anthropic".to_string();
        }
    }
    "anthropic".to_string()
}

fn provider_config_for(config: &Value, provider: &str, model: &str) -> Value {
    let mut merged = config
        .pointer(&format!("/providers/{provider}"))
        .cloned()
        .unwrap_or_else(|| json!({ "adapter": "anthropic" }));
    if merged.get("adapter").is_none() {
        merged["adapter"] = Value::String("anthropic".to_string());
    }

    if let Some(models) = config.get("models").and_then(Value::as_object) {
        for (alias, model_config) in models {
            let matches_provider =
                model_config.get("provider").and_then(Value::as_str) == Some(provider);
            let configured_model = model_config
                .get("model")
                .and_then(Value::as_str)
                .unwrap_or(alias);
            if matches_provider && configured_model == model {
                for key in ["adapter", "api_key", "base_url", "headers"] {
                    if let Some(value) = model_config.get(key) {
                        merged[key] = value.clone();
                    }
                }
                break;
            }
        }
    }
    merged
}

fn adapter_for_protocol(protocol: &str) -> &str {
    match protocol {
        "openai-compatible" => "openai",
        "gemini" => "gemini",
        _ => "anthropic",
    }
}

fn env_var_for(adapter: &str, provider: &str) -> String {
    let provider_key = format!(
        "{}_API_KEY",
        provider
            .to_uppercase()
            .replace(|c: char| !c.is_ascii_alphanumeric(), "_")
    );
    if std::env::var(&provider_key)
        .ok()
        .filter(|value| !value.is_empty())
        .is_some()
    {
        return provider_key;
    }
    match adapter {
        "openai" => "OPENAI_API_KEY".to_string(),
        "gemini" => "GEMINI_API_KEY".to_string(),
        _ => "ANTHROPIC_API_KEY".to_string(),
    }
}

fn resolve_env_key(adapter: &str, provider: &str) -> Option<String> {
    let provider_key = format!(
        "{}_API_KEY",
        provider
            .to_uppercase()
            .replace(|c: char| !c.is_ascii_alphanumeric(), "_")
    );
    if let Ok(value) = std::env::var(provider_key) {
        if !value.is_empty() {
            return Some(value);
        }
    }
    let fallback = match adapter {
        "openai" => "OPENAI_API_KEY",
        "gemini" => "GEMINI_API_KEY",
        _ => "ANTHROPIC_API_KEY",
    };
    std::env::var(fallback)
        .ok()
        .filter(|value| !value.is_empty())
}
