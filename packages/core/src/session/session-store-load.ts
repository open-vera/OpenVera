/**
 * Load session history and transcript previews from JSONL.
 */
import { readFileSync } from "node:fs";
import type { Message } from "../types/message.js";
import { calculateCost } from "./cost.js";
import type {
  LoadedSession,
  SessionPreviewMessage,
  SessionPreviewToolUse,
  SessionTranscriptPreview,
  ToolCallEntry,
  ToolResultEntry,
} from "./types.js";
import { getSessionBackend } from "./session-backend.js";
import { addUsage, parseJsonlLines, readSessionSummary } from "./jsonl-session-io.js";
import { resolveSessionFilePath } from "./store-paths.js";
import type { Usage } from "../types/index.js";

export function loadSession(sessionId: string, cwd?: string): LoadedSession {
  const backend = getSessionBackend();
  if (backend) {
    return backend.loadSession(sessionId, cwd);
  }
  const filePath = resolveSessionFilePath(sessionId, cwd ?? process.cwd());
  const raw = readFileSync(filePath, "utf8");
  const entries = parseJsonlLines(raw);

  const history: Message[] = [];
  let totalUsage: Usage = { input_tokens: 0, output_tokens: 0 };
  let totalCostUsd = 0;
  let turnCount = 0;
  let model = "";
  let provider = "";
  let loadedCwd = cwd ?? process.cwd();

  for (const entry of entries) {
    if (entry.type === "session_start") {
      if (!model) model = entry.model;
      if (!provider) provider = entry.provider;
      if (entry.cwd) loadedCwd = entry.cwd;
    } else if (entry.type === "user") {
      history.push({ role: "user", content: entry.content });
    } else if (entry.type === "assistant") {
      history.push({ role: "assistant", content: entry.content });
      totalUsage = addUsage(totalUsage, entry.usage);
      totalCostUsd += calculateCost(entry.usage, entry.model);
      turnCount++;
      model = entry.model;
      provider = entry.provider;
    } else if (entry.type === "session_end") {
      totalCostUsd = entry.totalCostUsd;
    }
  }

  return { sessionId, filePath, cwd: loadedCwd, history, totalUsage, totalCostUsd, turnCount, model, provider };
}

export function loadTranscriptPreview(sessionId: string, cwd?: string): SessionTranscriptPreview {
  const backend = getSessionBackend();
  if (backend) {
    return backend.loadTranscriptPreview(sessionId, cwd);
  }
  const filePath = resolveSessionFilePath(sessionId, cwd);
  const raw = readFileSync(filePath, "utf8");
  const entries = parseJsonlLines(raw);
  const messages: SessionPreviewMessage[] = [];
  const toolCallsByParent = new Map<string, ToolCallEntry[]>();
  const toolResultsByCallUuid = new Map<string, ToolResultEntry>();

  for (const entry of entries) {
    if (entry.type === "tool_call") {
      const existing = toolCallsByParent.get(entry.parentUuid) ?? [];
      existing.push(entry);
      toolCallsByParent.set(entry.parentUuid, existing);
    } else if (entry.type === "tool_result") {
      toolResultsByCallUuid.set(entry.parentUuid, entry);
    }
  }

  for (const entry of entries) {
    if (entry.type === "user") {
      messages.push({ role: "user", content: entry.content });
    } else if (entry.type === "assistant") {
      const toolUses = (toolCallsByParent.get(entry.parentUuid) ?? []).map((toolCall): SessionPreviewToolUse => {
        const result = toolResultsByCallUuid.get(toolCall.uuid);
        return {
          name: toolCall.toolName,
          args: toolCall.arguments,
          result: {
            ok: Boolean(result),
            content: result?.content ?? "(no tool result recorded)",
          },
        };
      });
      messages.push({
        role: "assistant",
        content: entry.content,
        ...(toolUses.length ? { toolUses } : {}),
      });
    }
  }

  const summary = readSessionSummary(filePath) ?? undefined;
  return {
    sessionId,
    messages,
    ...(summary ? { summary } : {}),
  };
}
