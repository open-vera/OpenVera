import { invoke } from "@tauri-apps/api/core";
import { emit, listen, TauriEvent, type UnlistenFn } from "@tauri-apps/api/event";
import { isCodeFilePath, usePreviewStore } from "@/stores/preview";
import type { TokenUsage, ToolApprovalRequest, ToolCall, ToolResult } from "@/types";

interface StreamPayload {
  requestId: string;
  instanceId: string;
}

interface RawPathInfo {
  path: string;
  isDir?: boolean;
  is_dir?: boolean;
  isFile?: boolean;
  is_file?: boolean;
}

interface DragDropPayload {
  paths?: string[];
}

interface DroppedPathInfo {
  path: string;
  isDir: boolean;
  isFile: boolean;
}

export interface PartnerAppEventHandlers {
  onOpenSettings: () => void;
  onSidecarUnavailable?: (info: { running: boolean; error?: string; needsNodeInstall?: boolean }) => void;
}

async function getPathInfo(path: string): Promise<DroppedPathInfo> {
  const info = await invoke<RawPathInfo>("path_info", { path });
  return {
    path: info.path,
    isDir: info.isDir ?? info.is_dir ?? false,
    isFile: info.isFile ?? info.is_file ?? false,
  };
}

async function readDroppedFile(path: string): Promise<string> {
  return invoke<string>("read_file", { path });
}

async function openDroppedFile(path: string): Promise<void> {
  if (!isCodeFilePath(path)) return;
  const preview = usePreviewStore();
  const content = await readDroppedFile(path);
  preview.openCodeFile(path, content);
}

async function openDroppedPaths(paths: string[]): Promise<void> {
  const infos = await Promise.allSettled(paths.map((path) => getPathInfo(path)));
  const validInfos = infos
    .filter((result): result is PromiseFulfilledResult<DroppedPathInfo> => result.status === "fulfilled")
    .map((result) => result.value);
  const folder = validInfos.find((info) => info.isDir);
  if (folder) {
    await emit("workspace:open-folder", { path: folder.path });
    return;
  }

  await Promise.all(
    validInfos
      .filter((info) => info.isFile)
      .map((info) =>
        openDroppedFile(info.path).catch((error: unknown) => {
          console.warn("[DragDrop] failed to open dropped file:", error);
        }),
      ),
  );
}

export function registerPartnerAppEvents(
  handlers: PartnerAppEventHandlers,
): Promise<() => void> {
  return Promise.all([
    listen("app:open-settings", handlers.onOpenSettings),
    listen<{ error?: string; needsNodeInstall?: boolean }>("sidecar:unavailable", (event) => {
      handlers.onSidecarUnavailable?.({
        running: false,
        error: event.payload.error,
        needsNodeInstall: event.payload.needsNodeInstall,
      });
    }),
    listen<DragDropPayload>(TauriEvent.DRAG_DROP, (event) => {
      const paths = event.payload.paths?.filter(Boolean) ?? [];
      if (paths.length === 0) return;
      void openDroppedPaths(paths).catch((error: unknown) => {
        console.warn("[DragDrop] failed to handle dropped paths:", error);
      });
    }),
  ]).then((unlisteners) => {
    return () => {
      for (const unlisten of unlisteners) {
        unlisten();
      }
    };
  });
}

export function onAgentDelta(
  requestId: string,
  instanceId: string,
  cb: (delta: string) => void,
): Promise<UnlistenFn> {
  return listen<StreamPayload & { delta: string }>(
    "agent:stream:delta",
    (event) => {
      if (
        event.payload.requestId === requestId &&
        event.payload.instanceId === instanceId
      ) {
        cb(event.payload.delta);
      }
    },
  );
}

export function onAgentReady(
  requestId: string,
  instanceId: string,
  cb: () => void,
): Promise<UnlistenFn> {
  return listen<StreamPayload>(
    "agent:stream:ready",
    (event) => {
      if (
        event.payload.requestId === requestId &&
        event.payload.instanceId === instanceId
      ) {
        cb();
      }
    },
  );
}

export function onAgentDone(
  requestId: string,
  instanceId: string,
  cb: (payload: { text?: string; usage?: TokenUsage }) => void,
): Promise<UnlistenFn> {
  return listen<StreamPayload & { text?: string; usage?: TokenUsage }>(
    "agent:stream:done",
    (event) => {
      if (
        event.payload.requestId === requestId &&
        event.payload.instanceId === instanceId
      ) {
        cb(event.payload);
      }
    },
  );
}

export function onAgentError(
  requestId: string,
  instanceId: string,
  cb: (payload: { message: string }) => void,
): Promise<UnlistenFn> {
  return listen<StreamPayload & { message: string }>(
    "agent:stream:error",
    (event) => {
      if (
        event.payload.requestId === requestId &&
        event.payload.instanceId === instanceId
      ) {
        cb({ message: event.payload.message });
      }
    },
  );
}

export function onAgentToolCall(
  requestId: string,
  cb: (payload: ToolCall) => void,
): Promise<UnlistenFn> {
  return listen<
    StreamPayload & {
      callId: string;
      name: string;
      input: Record<string, unknown>;
    }
  >("agent:stream:tool_call", (event) => {
    if (event.payload.requestId !== requestId) return;
    cb({
      id: event.payload.callId,
      name: event.payload.name,
      input: event.payload.input,
    });
  });
}

export function onAgentToolApprovalRequired(
  requestId: string,
  instanceId: string,
  cb: (payload: ToolApprovalRequest) => void,
): Promise<UnlistenFn> {
  return listen<
    StreamPayload & {
      callId: string;
      name: string;
      input?: Record<string, unknown>;
      reason: string;
      cmd?: string;
      args?: string[];
      cwd?: string;
      allowDir?: string;
    }
  >("agent:tool_approval_required", (event) => {
    if (
      event.payload.requestId !== requestId ||
      event.payload.instanceId !== instanceId
    ) {
      return;
    }
    cb({
      callId: event.payload.callId,
      name: event.payload.name,
      input: event.payload.input ?? {},
      reason: event.payload.reason,
      cmd: event.payload.cmd,
      args: event.payload.args,
      cwd: event.payload.cwd,
      allowDir: event.payload.allowDir,
    });
  });
}

export function onAgentToolResult(
  requestId: string,
  cb: (payload: ToolResult) => void,
): Promise<UnlistenFn> {
  return listen<
    StreamPayload & {
      callId: string;
      output: string;
      isError?: boolean;
    }
  >("agent:stream:tool_result", (event) => {
    if (event.payload.requestId !== requestId) return;
    cb({
      id: event.payload.callId,
      output: event.payload.output,
      isError: event.payload.isError,
    });
  });
}

export function onAgentThinking(
  requestId: string,
  instanceId: string,
  cb: () => void,
): Promise<UnlistenFn> {
  return listen<StreamPayload & { text: string }>(
    "agent:stream:thinking",
    (event) => {
      if (
        event.payload.requestId === requestId &&
        event.payload.instanceId === instanceId
      ) {
        cb();
      }
    },
  );
}

export function onAgentUsage(
  requestId: string,
  cb: (usage: TokenUsage) => void,
): Promise<UnlistenFn> {
  return listen<StreamPayload & { usage?: TokenUsage }>(
    "agent:stream:usage",
    (event) => {
      if (event.payload.requestId !== requestId || !event.payload.usage) return;
      cb(event.payload.usage);
    },
  );
}

export function subscribeAgentStream(options: {
  requestId: string;
  instanceId: string;
  onReady?: () => void;
  onDelta: (delta: string) => void;
  onError?: (payload: { message: string }) => void;
  onToolCall?: (toolCall: ToolCall) => void;
  onToolResult?: (toolResult: ToolResult) => void;
  onToolApprovalRequired?: (approval: ToolApprovalRequest) => void;
  onThinking?: () => void;
  onUsage?: (usage: TokenUsage) => void;
}): Promise<() => void> {
  const unlisteners: UnlistenFn[] = [];

  return Promise.all([
    options.onReady
      ? onAgentReady(options.requestId, options.instanceId, options.onReady)
      : Promise.resolve(() => {}),
    onAgentDelta(options.requestId, options.instanceId, options.onDelta),
    options.onToolCall
      ? onAgentToolCall(options.requestId, options.onToolCall)
      : Promise.resolve(() => {}),
    options.onToolResult
      ? onAgentToolResult(options.requestId, options.onToolResult)
      : Promise.resolve(() => {}),
    options.onToolApprovalRequired
      ? onAgentToolApprovalRequired(
          options.requestId,
          options.instanceId,
          options.onToolApprovalRequired,
        )
      : Promise.resolve(() => {}),
    options.onThinking
      ? onAgentThinking(options.requestId, options.instanceId, options.onThinking)
      : Promise.resolve(() => {}),
    options.onUsage
      ? onAgentUsage(options.requestId, options.onUsage)
      : Promise.resolve(() => {}),
    options.onError
      ? onAgentError(options.requestId, options.instanceId, options.onError)
      : Promise.resolve(() => {}),
  ]).then((listeners) => {
    unlisteners.push(...listeners);
    return () => {
      for (const unlisten of unlisteners) {
        unlisten();
      }
    };
  });
}
