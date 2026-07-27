//! Host IO / LLM / keychain / shell command handlers (no separate invoke surface).

use serde_json::json;
use tauri::{AppHandle, State};

use crate::commands::agent::{
    inspect_llm_config, list_llm_provider_models, list_llm_providers, rename_vera_provider,
    save_vera_llm_config, save_vera_models_routing, VeraModelAliasInput, VeraRoutingInput,
};
use crate::commands::fs::{
    append_file, copy_path, create_dir, delete_path, path_info, read_file, rename_path,
    replace_content, reveal_in_os, search_content, search_files, write_file,
};
use crate::commands::keychain::{
    default_service_name, delete_secret, get_secret, store_secret,
};
use crate::commands::run_log::read_run_log;
use crate::commands::shell::execute_shell;
use crate::commands::storage_usage::scan_storage_usage;
use crate::sidecar::SidecarManager;

use super::protocol::{HostCommand, HostCommandResult};

pub async fn dispatch_io(
    _app: &AppHandle,
    sidecar: &State<'_, SidecarManager>,
    command: HostCommand,
) -> Option<HostCommandResult> {
    let result = match command {
        HostCommand::AppVersion => {
            HostCommandResult::ok(json!(env!("CARGO_PKG_VERSION")))
        }
        HostCommand::SidecarStatus => match sidecar.info() {
            Ok(info) => HostCommandResult::ok(json!(info)),
            Err(error) => HostCommandResult::err(error),
        },
        HostCommand::AgentToolApproval { call_id, approved } => {
            match sidecar.resolve_tool_approval(call_id, approved) {
                Ok(()) => HostCommandResult::empty_ok(),
                Err(error) => HostCommandResult::err(error),
            }
        }
        HostCommand::FsRead { path } => match read_file(path).await {
            Ok(content) => HostCommandResult::ok(json!(content)),
            Err(error) => HostCommandResult::err(error),
        },
        HostCommand::FsWrite { path, content } => match write_file(path, content).await {
            Ok(()) => HostCommandResult::empty_ok(),
            Err(error) => HostCommandResult::err(error),
        },
        HostCommand::FsAppend { path, content } => match append_file(path, content).await {
            Ok(()) => HostCommandResult::empty_ok(),
            Err(error) => HostCommandResult::err(error),
        },
        HostCommand::FsPathInfo { path } => match path_info(path).await {
            Ok(info) => HostCommandResult::ok(json!(info)),
            Err(error) => HostCommandResult::err(error),
        },
        HostCommand::FsSearchFiles {
            root,
            query,
            limit,
            include,
            exclude,
        } => match search_files(root, query, limit, include, exclude).await {
            Ok(items) => HostCommandResult::ok(json!(items)),
            Err(error) => HostCommandResult::err(error),
        },
        HostCommand::FsSearchContent {
            root,
            query,
            limit,
            include,
            exclude,
        } => match search_content(root, query, limit, include, exclude).await {
            Ok(items) => HostCommandResult::ok(json!(items)),
            Err(error) => HostCommandResult::err(error),
        },
        HostCommand::FsReplaceContent {
            root,
            query,
            replacement,
            include,
            exclude,
        } => match replace_content(root, query, replacement, include, exclude).await {
            Ok(count) => HostCommandResult::ok(json!(count)),
            Err(error) => HostCommandResult::err(error),
        },
        HostCommand::FsCreateDir { path } => match create_dir(path).await {
            Ok(()) => HostCommandResult::empty_ok(),
            Err(error) => HostCommandResult::err(error),
        },
        HostCommand::FsRename { from, to } => match rename_path(from, to).await {
            Ok(()) => HostCommandResult::empty_ok(),
            Err(error) => HostCommandResult::err(error),
        },
        HostCommand::FsDelete { path } => match delete_path(path).await {
            Ok(()) => HostCommandResult::empty_ok(),
            Err(error) => HostCommandResult::err(error),
        },
        HostCommand::FsCopy { from, to } => match copy_path(from, to).await {
            Ok(()) => HostCommandResult::empty_ok(),
            Err(error) => HostCommandResult::err(error),
        },
        HostCommand::FsReveal { path } => match reveal_in_os(path).await {
            Ok(()) => HostCommandResult::empty_ok(),
            Err(error) => HostCommandResult::err(error),
        },
        HostCommand::RunLogRead {
            project_root,
            task_id,
            max_bytes,
        } => match read_run_log(project_root, task_id, max_bytes) {
            Ok(view) => HostCommandResult::ok(json!(view)),
            Err(error) => HostCommandResult::err(error),
        },
        HostCommand::StorageUsage { project_root } => {
            // A cold ~/.vera can hold tens of thousands of session files; keep
            // the walk off the async runtime's worker threads.
            match tauri::async_runtime::spawn_blocking(move || scan_storage_usage(project_root))
                .await
            {
                Ok(Ok(report)) => HostCommandResult::ok(json!(report)),
                Ok(Err(error)) => HostCommandResult::err(error),
                Err(error) => HostCommandResult::err(error.to_string()),
            }
        }
        HostCommand::ShellExecute {
            cmd,
            args,
            cwd,
            timeout_ms,
            confirmed,
        } => match execute_shell(cmd, args, cwd, timeout_ms, confirmed.unwrap_or(false)).await
        {
            Ok(output) => HostCommandResult::ok(json!(output)),
            Err(error) => HostCommandResult::err(error),
        },
        HostCommand::KeychainStore {
            service,
            key,
            value,
        } => match store_secret(service, key, value).await {
            Ok(()) => HostCommandResult::empty_ok(),
            Err(error) => HostCommandResult::err(error),
        },
        HostCommand::KeychainGet { service, key } => match get_secret(service, key).await {
            Ok(value) => HostCommandResult::ok(json!(value)),
            Err(error) => HostCommandResult::err(error),
        },
        HostCommand::KeychainDelete { service, key } => match delete_secret(service, key).await {
            Ok(()) => HostCommandResult::empty_ok(),
            Err(error) => HostCommandResult::err(error),
        },
        HostCommand::KeychainDefaultService => {
            HostCommandResult::ok(json!(default_service_name()))
        }
        HostCommand::LlmInspect { project_root } => {
            match inspect_llm_config(project_root, None, Some(false)).await {
                Ok(value) => HostCommandResult::ok(value),
                Err(error) => HostCommandResult::err(error),
            }
        }
        HostCommand::LlmSave {
            project_root,
            config,
        } => {
            let provider = config
                .get("provider")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let protocol = config
                .get("protocol")
                .and_then(|v| v.as_str())
                .unwrap_or("anthropic")
                .to_string();
            let api_base_url = config
                .get("apiBaseUrl")
                .or_else(|| config.get("api_base_url"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let model = config
                .get("model")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let api_key = config
                .get("apiKey")
                .or_else(|| config.get("api_key"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let set_as_default = config
                .get("setAsDefault")
                .or_else(|| config.get("set_as_default"))
                .and_then(|v| v.as_bool());
            match save_vera_llm_config(
                project_root,
                provider,
                protocol,
                api_base_url,
                model,
                api_key,
                set_as_default,
            )
            .await
            {
                Ok(value) => HostCommandResult::ok(value),
                Err(error) => HostCommandResult::err(error),
            }
        }
        HostCommand::LlmRenameProvider {
            project_root,
            from_id,
            to_id,
        } => match rename_vera_provider(project_root, from_id, to_id) {
            Ok(value) => HostCommandResult::ok(value),
            Err(error) => HostCommandResult::err(error),
        },
        HostCommand::LlmSaveModelsRouting {
            project_root,
            models,
            routing,
        } => {
            let parsed_models: Vec<VeraModelAliasInput> =
                serde_json::from_value(models).unwrap_or_default();
            let default_provider = routing
                .get("defaultProvider")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let default_model = routing
                .get("defaultModel")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let parsed_routing: VeraRoutingInput = serde_json::from_value(routing).unwrap_or(
                VeraRoutingInput {
                    enabled: false,
                    classifier: None,
                    l0: None,
                    l1: None,
                    l2: None,
                },
            );
            match save_vera_models_routing(
                project_root,
                parsed_models,
                default_provider,
                default_model,
                parsed_routing,
            ) {
                Ok(value) => HostCommandResult::ok(value),
                Err(error) => HostCommandResult::err(error),
            }
        }
        HostCommand::LlmListProviders { project_root } => match list_llm_providers(project_root) {
            Ok(value) => HostCommandResult::ok(value),
            Err(error) => HostCommandResult::err(error),
        },
        HostCommand::LlmListProviderModels {
            project_root,
            provider_id,
        } => match list_llm_provider_models(project_root, provider_id) {
            Ok(value) => HostCommandResult::ok(value),
            Err(error) => HostCommandResult::err(error),
        },
        HostCommand::LlmRefreshProviderModels {
            project_root,
            provider_id,
            protocol,
        } => {
            let root = project_root.unwrap_or_else(crate::sidecar::resolve_project_root);
            match sidecar.call_rpc(
                "llm.listProviderModels",
                json!({
                    "projectRoot": root,
                    "providerId": provider_id,
                    "protocol": protocol,
                }),
            ) {
                Ok(value) => HostCommandResult::ok(value),
                Err(error) => HostCommandResult::err(error),
            }
        }
        HostCommand::LlmTestConnection {
            project_root,
            config,
        } => {
            let root = project_root.unwrap_or_else(crate::sidecar::resolve_project_root);
            let provider_id = config
                .get("providerId")
                .or_else(|| config.get("provider"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let protocol = config
                .get("protocol")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            match sidecar.call_rpc(
                "llm.testConnection",
                json!({
                    "projectRoot": root,
                    "providerId": provider_id,
                    "protocol": protocol,
                }),
            ) {
                Ok(value) => HostCommandResult::ok(value),
                Err(error) => HostCommandResult::err(error),
            }
        }
        _ => return None,
    };
    Some(result)
}
