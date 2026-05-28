import type { ToolResult } from "../../../tools/types.js";
import type { ToolUse } from "../types.js";

export type RenderableToolUse = {
  name: string;
  args: Record<string, unknown>;
  result: {
    ok: boolean;
    content: string;
  };
};

export interface ToolDisplayModel {
  name: string;
  label: string;
  ok: boolean;
  compactSummary?: string;
  renderHintType?: string;
  preface?: string;
}

export function toolArgsLabel(_toolName: string, args: Record<string, unknown>, maxChars = 50): string {
  const value = args.path ?? args.command ?? args.pattern ?? args.query;
  if (typeof value !== "string") return "";
  return value.length > maxChars ? `${value.slice(0, maxChars)}…` : value;
}

export function compactToolSummary(toolName: string, result: ToolResult): string | undefined {
  if (!result.ok) return result.error?.message ?? result.content.split("\n")[0];
  if (toolName === "read_file") {
    const firstLine = result.content.split("\n")[0] ?? "";
    const match = firstLine.match(/\((\d+) lines?\)/);
    return match ? `Read ${match[1]} ${match[1] === "1" ? "line" : "lines"}` : firstLine;
  }
  if (toolName === "grep") {
    const firstLine = result.content.split("\n")[0] ?? "";
    const matchCount = firstLine.match(/^(\d+) match/);
    if (matchCount) return `Found ${matchCount[1]} ${matchCount[1] === "1" ? "match" : "matches"}`;
    if (firstLine.startsWith("No matches")) return firstLine;
    return undefined;
  }
  if (result.metadata?.renderHint?.type === "file-list") {
    const count = result.content.split("\n").filter(Boolean).length;
    return `${count} ${count === 1 ? "entry" : "entries"}`;
  }
  return undefined;
}

export function projectToolUse(tool: ToolUse): ToolDisplayModel {
  return {
    name: tool.name,
    label: toolArgsLabel(tool.name, tool.args),
    ok: tool.result.ok,
    compactSummary: compactToolSummary(tool.name, tool.result),
    renderHintType: tool.result.metadata?.renderHint?.type,
    preface: tool.preface,
  };
}

export function groupToolDisplays(tools: ToolUse[]): ToolDisplayModel[] {
  return tools.map(projectToolUse);
}

export function isLowSignalToolUse(toolUse: RenderableToolUse): boolean {
  if (!toolUse.result.ok) return false;
  const content = toolUse.result.content.trim();
  return content === "" || content === "(no output)";
}

export function compactLowSignalToolUses<T extends RenderableToolUse>(toolUses: T[]): T[] {
  const display: T[] = [];
  let pendingLowSignal: T | undefined;

  for (const toolUse of toolUses) {
    if (isLowSignalToolUse(toolUse)) {
      pendingLowSignal = toolUse;
      continue;
    }
    pendingLowSignal = undefined;
    display.push(toolUse);
  }

  if (pendingLowSignal) display.push(pendingLowSignal);
  return display;
}

const GROUPABLE_TOOL_NAMES = new Set(["read_file", "list_dir", "grep", "glob"]);

export function compactGroupedToolUses<T extends RenderableToolUse>(toolUses: T[]): T[] {
  const result: T[] = [];
  let group: T[] = [];

  function flushGroup(): void {
    if (group.length === 0) return;
    if (group.length === 1) {
      result.push(group[0]!);
    } else {
      const counts = new Map<string, number>();
      for (const item of group) counts.set(item.name, (counts.get(item.name) ?? 0) + 1);
      const summary = [...counts.entries()]
        .map(([name, count]) => `${count} ${name}`)
        .join(", ");
      result.push({
        name: "tool_group",
        args: {},
        result: {
          ok: true,
          content: `Grouped ${group.length} read/search/list tool calls: ${summary}`,
        },
      } as T);
    }
    group = [];
  }

  for (const toolUse of toolUses) {
    if (toolUse.result.ok && GROUPABLE_TOOL_NAMES.has(toolUse.name)) {
      group.push(toolUse);
    } else {
      flushGroup();
      result.push(toolUse);
    }
  }
  flushGroup();
  return result;
}

export function toolUsesForDisplay<T extends RenderableToolUse>(toolUses: T[], expanded?: boolean): T[] {
  return expanded ? toolUses : compactGroupedToolUses(compactLowSignalToolUses(toolUses));
}
