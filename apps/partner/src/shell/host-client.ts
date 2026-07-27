import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  HostCommand,
  HostCommandResult,
  HostPatch,
  HostState,
} from "./types";
import { HOST_EVENT, HOST_PATCH_EVENT } from "./types";

export async function hostBoot(): Promise<HostState> {
  return invoke<HostState>("host_boot");
}

export async function hostDispatch<T = unknown>(
  command: HostCommand,
): Promise<T> {
  const result = await invoke<HostCommandResult>("host_dispatch", { command });
  if (!result.ok) {
    throw new Error(result.error || "host_dispatch failed");
  }
  return result.data as T;
}

export async function subscribeHostPatch(
  onPatch: (patch: HostPatch) => void,
): Promise<UnlistenFn> {
  return listen<HostPatch>(HOST_PATCH_EVENT, (event) => {
    onPatch(event.payload);
  });
}

export async function subscribeHostEvent(
  onEvent: (event: unknown) => void,
): Promise<UnlistenFn> {
  return listen(HOST_EVENT, (event) => {
    onEvent(event.payload);
  });
}
