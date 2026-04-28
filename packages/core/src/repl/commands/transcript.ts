import { SessionStore } from "../../session/index.js";
import type { SessionPreviewMessage, SessionPreviewToolUse } from "../../session/index.js";
import type { ReplContext } from "../context.js";

const DEFAULT_LIMIT = 20;
const CONTENT_LIMIT = 500;
const TOOL_RESULT_LIMIT = 260;

export async function subCommand(args: string[], ctx: ReplContext): Promise<void> {
  const prefix = args.find((arg) => !arg.startsWith("--"));
  const all = args.includes("--all");
  const limit = parseNumberFlag(args, "--limit") ?? DEFAULT_LIMIT;

  if (!prefix) {
    console.log("Usage: /sub <session-id-prefix> [--all] [--limit N]");
    console.log("Tip: use the Transcript id returned by a subagent result.");
    return;
  }

  const sessions = SessionStore.listSessions(all ? undefined : ctx.cwd);
  const matches = sessions.filter((session) => session.sessionId.startsWith(prefix));

  if (matches.length === 0) {
    console.log(`No session found with prefix "${prefix}".`);
    return;
  }
  if (matches.length > 1) {
    console.log(`Ambiguous prefix "${prefix}" — ${matches.length} sessions match:`);
    for (const session of matches.slice(0, 10)) {
      console.log(`  ${session.sessionId.slice(0, 8)}  ${session.model}`);
    }
    return;
  }

  const target = matches[0]!;
  try {
    const preview = SessionStore.loadTranscriptPreview(target.sessionId, all ? undefined : ctx.cwd);
    const summary = preview.summary;
    const title = summary?.summary ?? summary?.branch?.title ?? "Transcript";
    console.log(`Transcript ${preview.sessionId.slice(0, 8)} — ${title}`);
    if (summary?.branch) {
      console.log(`Branch: ${summary.branch.title ?? "(untitled)"} · ${summary.branch.status}`);
    }
    if (summary) {
      console.log(`Turns: ${summary.turnCount} · Cost: $${summary.totalCostUsd.toFixed(4)} · Model: ${summary.model}`);
    }

    const messages = preview.messages.slice(-Math.max(1, limit));
    for (const message of messages) {
      renderMessage(message);
    }

    if (preview.messages.length > messages.length) {
      console.log(`… ${preview.messages.length - messages.length} earlier messages hidden. Use --limit ${preview.messages.length} to show all.`);
    }
  } catch (err) {
    console.log(`Failed to load transcript: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const transcriptCommand = subCommand;

function renderMessage(message: SessionPreviewMessage): void {
  const label = message.role === "user" ? "User" : "Assistant";
  console.log(`\n${label}: ${truncate(message.content || "(empty)", CONTENT_LIMIT)}`);

  for (const toolUse of message.toolUses ?? []) {
    renderToolUse(toolUse);
  }
}

function renderToolUse(toolUse: SessionPreviewToolUse): void {
  const args = JSON.stringify(toolUse.args);
  console.log(`  Tool: ${toolUse.name}${args && args !== "{}" ? ` ${truncate(args, 120)}` : ""}`);
  console.log(`    → ${truncate(toolUse.result.content, TOOL_RESULT_LIMIT)}`);
}

function truncate(value: string, max: number): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  return singleLine.length <= max ? singleLine : `${singleLine.slice(0, Math.max(0, max - 3))}...`;
}

function parseNumberFlag(args: string[], flag: string): number | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = Number(args[index + 1]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}
