//! LLM config inspect/save lives in Rust (Host-owned). Runtime agent runs are
//! dispatched via `host::orchestrator` → sidecar, and the IO/LLM handlers in
//! `host::io` are the only callers of this module.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::sidecar::resolve_project_root;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmRuntimeConfig {
    pub provider: String,
    pub protocol: String,
    pub api_base_url: String,
    pub model: String,
    pub api_key: String,
}

#[tauri::command]
pub fn list_llm_providers(project_root: Option<String>) -> Result<Value, String> {
    let root = project_root.unwrap_or_else(resolve_project_root);
    list_configured_providers(&root)
}

#[tauri::command]
pub fn list_llm_provider_models(
    project_root: Option<String>,
    provider_id: String,
) -> Result<Value, String> {
    let root = project_root.unwrap_or_else(resolve_project_root);
    list_configured_provider_models(&root, &provider_id)
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
        let paths = config_path_bundle(&root);
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
            "configScope": paths.scope,
            "projectConfigPath": paths.project_path.to_string_lossy().to_string(),
            "globalConfigPath": paths.global_path.to_string_lossy().to_string(),
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
    set_as_default: Option<bool>,
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

    if !model.trim().is_empty() {
        if !config.get("models").is_some_and(Value::is_object) {
            config["models"] = json!({});
        }
        config["models"][&model] = json!({
            "provider": provider,
        });
    }

    let make_default = set_as_default.unwrap_or(true);
    if make_default {
        config["default_provider"] = Value::String(provider.clone());
        if !model.trim().is_empty() {
            config["default_model"] = Value::String(model);
        }
    }

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

#[tauri::command]
pub fn rename_vera_provider(
    project_root: Option<String>,
    old_id: String,
    new_id: String,
) -> Result<Value, String> {
    let root = project_root.unwrap_or_else(resolve_project_root);
    let path = writable_config_path(&root);
    let mut config = read_writable_config(&path)?;
    rename_provider_in_config(&mut config, &old_id, &new_id)?;
    write_config_file(&path, &config)?;
    inspect_vera_config(&root, false)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VeraModelAliasInput {
    pub alias: String,
    pub provider: String,
    pub model: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VeraRoutingInput {
    pub enabled: bool,
    pub classifier: Option<String>,
    pub l0: Option<String>,
    pub l1: Option<String>,
    pub l2: Option<String>,
}

#[tauri::command]
pub fn save_vera_models_routing(
    project_root: Option<String>,
    models: Vec<VeraModelAliasInput>,
    default_provider: Option<String>,
    default_model: Option<String>,
    routing: VeraRoutingInput,
) -> Result<Value, String> {
    let root = project_root.unwrap_or_else(resolve_project_root);
    let path = writable_config_path(&root);
    let mut config = read_writable_config(&path)?;
    apply_models_routing(
        &mut config,
        &models,
        default_provider.as_deref(),
        default_model.as_deref(),
        &routing,
    );
    write_config_file(&path, &config)?;
    inspect_vera_config(&root, false)
}

fn load_vera_config(root: &str) -> Result<Value, String> {
    let location = resolve_config_location(root);
    if !location.exists {
        return Ok(json!({}));
    }
    let raw = fs::read_to_string(&location.path).map_err(|error| error.to_string())?;
    serde_json::from_str::<Value>(&raw).map_err(|error| error.to_string())
}

fn protocol_for_adapter(adapter: &str) -> &str {
    match adapter {
        "openai" => "openai-compatible",
        "openai-responses" => "openai-responses",
        "gemini" => "gemini",
        _ => "anthropic",
    }
}

fn provider_has_api_key(config: &Value, provider_id: &str, adapter: &str) -> bool {
    let configured_key = config
        .pointer(&format!("/providers/{provider_id}/api_key"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if configured_key.is_some() {
        return true;
    }
    resolve_env_key(adapter, provider_id).is_some()
}

fn first_model_for_provider(config: &Value, provider_id: &str) -> Option<String> {
    match config.get("models") {
        Some(Value::Object(items)) => {
            for (alias, model_config) in items {
                if model_config.get("provider").and_then(Value::as_str) == Some(provider_id) {
                    return Some(
                        model_config
                            .get("model")
                            .and_then(Value::as_str)
                            .unwrap_or(alias)
                            .to_string(),
                    );
                }
            }
            None
        }
        Some(Value::Array(items)) => {
            if resolve_default_provider(config) == provider_id {
                items.iter().find_map(|item| item.as_str().map(str::to_string))
            } else {
                None
            }
        }
        _ => None,
    }
}

fn list_configured_providers(root: &str) -> Result<Value, String> {
    let config = load_vera_config(root)?;
    let default_provider = resolve_default_provider(&config);
    let Some(providers) = config.get("providers").and_then(Value::as_object) else {
        return Ok(json!({ "providers": [] }));
    };

    let default_model = config
        .get("default_model")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    let mut entries: Vec<Value> = providers
        .iter()
        .map(|(id, provider_config)| {
            let adapter = provider_config
                .get("adapter")
                .and_then(Value::as_str)
                .unwrap_or("anthropic");
            let has_api_key = provider_has_api_key(&config, id, adapter);
            let model = if id == &default_provider {
                default_model.clone()
            } else {
                first_model_for_provider(&config, id).unwrap_or_default()
            };
            json!({
                "id": id,
                "adapter": adapter,
                "protocol": protocol_for_adapter(adapter),
                "apiBaseUrl": provider_config.get("base_url").and_then(Value::as_str).unwrap_or(""),
                "hasApiKey": has_api_key,
                "isDefault": id == &default_provider,
                "model": model,
            })
        })
        .collect();

    entries.sort_by(|left, right| {
        let left_default = left.get("isDefault").and_then(Value::as_bool) == Some(true);
        let right_default = right.get("isDefault").and_then(Value::as_bool) == Some(true);
        if left_default != right_default {
            return left_default.cmp(&right_default).reverse();
        }
        left.get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .cmp(right.get("id").and_then(Value::as_str).unwrap_or_default())
    });

    Ok(json!({ "providers": entries }))
}

fn list_configured_provider_models(root: &str, provider_id: &str) -> Result<Value, String> {
    let config = load_vera_config(root)?;
    let mut models: Vec<Value> = Vec::new();

    match config.get("models") {
        Some(Value::Array(items)) => {
            let default_provider = resolve_default_provider(&config);
            if default_provider == provider_id {
                for item in items {
                    let Some(alias) = item.as_str() else {
                        continue;
                    };
                    models.push(json!({
                        "id": alias,
                        "displayName": alias,
                        "source": "config",
                    }));
                }
            }
        }
        Some(Value::Object(items)) => {
            for (alias, model_config) in items {
                if model_config.get("provider").and_then(Value::as_str) != Some(provider_id) {
                    continue;
                }
                let upstream = model_config
                    .get("model")
                    .and_then(Value::as_str)
                    .unwrap_or(alias);
                models.push(json!({
                    "id": alias,
                    "displayName": alias,
                    "upstreamId": if upstream == alias.as_str() {
                        Value::Null
                    } else {
                        Value::String(upstream.to_string())
                    },
                    "source": "config",
                }));
            }
        }
        _ => {}
    }

    models.sort_by(|left, right| {
        left.get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .cmp(right.get("id").and_then(Value::as_str).unwrap_or_default())
    });

    Ok(json!({ "models": models }))
}

fn inspect_vera_config(root: &str, reveal: bool) -> Result<Value, String> {
    let location = resolve_config_location(root);
    let paths = config_path_bundle(root);
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
        "projectConfigPath": paths.project_path.to_string_lossy().to_string(),
        "globalConfigPath": paths.global_path.to_string_lossy().to_string(),
        "defaultProvider": config.get("default_provider").and_then(Value::as_str),
        "defaultModel": config.get("default_model").and_then(Value::as_str),
        "models": list_model_aliases_json(&config),
        "routing": routing_snapshot(&config),
    }))
}

fn read_writable_config(path: &Path) -> Result<Value, String> {
    if path.exists() {
        let raw = fs::read_to_string(path).map_err(|error| error.to_string())?;
        serde_json::from_str::<Value>(&raw).map_err(|error| error.to_string())
    } else {
        Ok(json!({}))
    }
}

fn write_config_file(path: &Path, config: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(
        path,
        serde_json::to_string_pretty(config).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}

fn normalize_provider_id(id: &str) -> String {
    id.trim().split_whitespace().collect::<Vec<_>>().join("-")
}

fn is_valid_provider_id(id: &str) -> bool {
    let mut chars = id.chars();
    match chars.next() {
        Some(first) if first.is_ascii_alphanumeric() => {}
        _ => return false,
    }
    chars.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | ':' | '-'))
}

fn rename_provider_in_config(config: &mut Value, old_id: &str, new_id_raw: &str) -> Result<(), String> {
    let old_key = old_id.trim();
    let new_id = normalize_provider_id(new_id_raw);
    if old_key.is_empty() {
        return Err("Provider id is required".to_string());
    }
    if !is_valid_provider_id(&new_id) {
        return Err(format!("Invalid provider id: {new_id}"));
    }
    if old_key == new_id {
        return Ok(());
    }

    let providers = config
        .get_mut("providers")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| format!("Provider not found: {old_key}"))?;
    if !providers.contains_key(old_key) {
        return Err(format!("Provider not found: {old_key}"));
    }
    if providers.contains_key(&new_id) {
        return Err(format!("Provider already exists: {new_id}"));
    }
    let entry = providers
        .remove(old_key)
        .ok_or_else(|| format!("Provider not found: {old_key}"))?;
    providers.insert(new_id.clone(), entry);

    if let Some(models) = config.get_mut("models").and_then(Value::as_object_mut) {
        for (_alias, value) in models.iter_mut() {
            if let Some(obj) = value.as_object_mut() {
                if obj.get("provider").and_then(Value::as_str) == Some(old_key) {
                    obj.insert("provider".to_string(), Value::String(new_id.clone()));
                }
            }
        }
    }

    if config.get("default_provider").and_then(Value::as_str) == Some(old_key) {
        config["default_provider"] = Value::String(new_id.clone());
    }

    rewrite_routing_provider_refs(config, old_key, &new_id);
    rewrite_session_provider_refs(config, old_key, &new_id);
    Ok(())
}

fn rewrite_model_reference(reference: &mut Value, old_id: &str, new_id: &str) {
    if let Some(obj) = reference.as_object_mut() {
        if obj.get("provider").and_then(Value::as_str) == Some(old_id) {
            obj.insert("provider".to_string(), Value::String(new_id.to_string()));
        }
    }
}

fn rewrite_routing_provider_refs(config: &mut Value, old_id: &str, new_id: &str) {
    let Some(routing) = config.get_mut("routing").and_then(Value::as_object_mut) else {
        return;
    };
    for key in ["classifier", "l0", "l1", "l2"] {
        if let Some(reference) = routing.get_mut(key) {
            rewrite_model_reference(reference, old_id, new_id);
        }
    }
}

fn rewrite_session_provider_refs(config: &mut Value, old_id: &str, new_id: &str) {
    let Some(session) = config.get_mut("session").and_then(Value::as_object_mut) else {
        return;
    };
    for key in ["ai_title", "compact"] {
        if let Some(block) = session.get_mut(key).and_then(Value::as_object_mut) {
            if block.get("provider").and_then(Value::as_str) == Some(old_id) {
                block.insert("provider".to_string(), Value::String(new_id.to_string()));
            }
        }
    }
}

fn apply_models_routing(
    config: &mut Value,
    models: &[VeraModelAliasInput],
    default_provider: Option<&str>,
    default_model: Option<&str>,
    routing: &VeraRoutingInput,
) {
    let mut models_obj = serde_json::Map::new();
    for item in models {
        let alias = item.alias.trim();
        if alias.is_empty() {
            continue;
        }
        let provider = normalize_provider_id(&item.provider);
        if provider.is_empty() {
            continue;
        }
        let mut entry = serde_json::Map::new();
        entry.insert("provider".to_string(), Value::String(provider));
        if let Some(upstream) = item.model.as_deref().map(str::trim).filter(|value| !value.is_empty())
        {
            if upstream != alias {
                entry.insert("model".to_string(), Value::String(upstream.to_string()));
            }
        }
        models_obj.insert(alias.to_string(), Value::Object(entry));
    }
    config["models"] = Value::Object(models_obj);

    if let Some(provider) = default_provider.map(str::trim).filter(|value| !value.is_empty()) {
        config["default_provider"] = Value::String(normalize_provider_id(provider));
    }
    match default_model.map(str::trim).filter(|value| !value.is_empty()) {
        Some(model) => config["default_model"] = Value::String(model.to_string()),
        None => {
            if let Some(obj) = config.as_object_mut() {
                obj.remove("default_model");
            }
        }
    }

    let mut routing_obj = serde_json::Map::new();
    routing_obj.insert("enabled".to_string(), Value::Bool(routing.enabled));
    for (key, value) in [
        ("classifier", routing.classifier.as_deref()),
        ("l0", routing.l0.as_deref()),
        ("l1", routing.l1.as_deref()),
        ("l2", routing.l2.as_deref()),
    ] {
        if let Some(text) = value.map(str::trim).filter(|item| !item.is_empty()) {
            routing_obj.insert(key.to_string(), Value::String(text.to_string()));
        }
    }
    config["routing"] = Value::Object(routing_obj);
}

fn list_model_aliases_json(config: &Value) -> Value {
    let mut items = Vec::new();
    match config.get("models") {
        Some(Value::Object(map)) => {
            for (alias, value) in map {
                let provider = value
                    .get("provider")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| resolve_default_provider(config));
                let model = value
                    .get("model")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                items.push(json!({
                    "alias": alias,
                    "provider": provider,
                    "model": model,
                }));
            }
        }
        Some(Value::Array(list)) => {
            let provider = resolve_default_provider(config);
            for item in list {
                if let Some(alias) = item.as_str() {
                    items.push(json!({
                        "alias": alias,
                        "provider": provider,
                        "model": alias,
                    }));
                }
            }
        }
        _ => {}
    }
    items.sort_by(|left, right| {
        left.get("alias")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .cmp(right.get("alias").and_then(Value::as_str).unwrap_or_default())
    });
    Value::Array(items)
}

fn routing_snapshot(config: &Value) -> Value {
    let routing = config.get("routing").and_then(Value::as_object);
    let pick = |key: &str| -> Value {
        match routing.and_then(|map| map.get(key)) {
            Some(Value::String(text)) => Value::String(text.clone()),
            Some(Value::Object(obj)) => {
                if let (Some(provider), Some(model)) = (
                    obj.get("provider").and_then(Value::as_str),
                    obj.get("model").and_then(Value::as_str),
                ) {
                    json!({ "provider": provider, "model": model })
                } else {
                    Value::Null
                }
            }
            _ => Value::Null,
        }
    };
    json!({
        "enabled": routing
            .and_then(|map| map.get("enabled"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        "classifier": pick("classifier"),
        "l0": pick("l0"),
        "l1": pick("l1"),
        "l2": pick("l2"),
    })
}

struct ConfigPathBundle {
    project_path: PathBuf,
    global_path: PathBuf,
    scope: &'static str,
}

fn config_path_bundle(root: &str) -> ConfigPathBundle {
    let project_path = Path::new(root).join(".vera/settings.json");
    let global_path = std::env::var("HOME")
        .map(|home| PathBuf::from(home).join(".vera/settings.json"))
        .unwrap_or_else(|_| PathBuf::from(".vera/settings.json"));

    if let Ok(config_dir) = std::env::var("VERA_CONFIG_DIR") {
        return ConfigPathBundle {
            project_path,
            global_path: PathBuf::from(config_dir).join("settings.json"),
            scope: "env",
        };
    }

    let scope = if project_path.exists() {
        "project"
    } else {
        "global"
    };

    ConfigPathBundle {
        project_path,
        global_path,
        scope,
    }
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
        "openai-responses" => "openai-responses",
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
        "openai" | "openai-responses" => "OPENAI_API_KEY".to_string(),
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
        "openai" | "openai-responses" => "OPENAI_API_KEY",
        "gemini" => "GEMINI_API_KEY",
        _ => "ANTHROPIC_API_KEY",
    };
    std::env::var(fallback)
        .ok()
        .filter(|value| !value.is_empty())
}
