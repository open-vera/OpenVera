// /sessions — 列出当前项目的历史 session

import { SessionStore } from "../../session/index.js";
import type { ReplContext } from "../context.js";

function padEnd(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

function padStart(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : " ".repeat(n - s.length) + s;
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function formatCost(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

export async function sessionsCommand(
  args: string[],
  _ctx: ReplContext
): Promise<void> {
  const all = args.includes("--all");
  const sessions = SessionStore.listSessions(all ? undefined : process.cwd());

  if (sessions.length === 0) {
    console.log("No sessions found for this project.");
    console.log("Tip: use /sessions --all to search across all projects.");
    return;
  }

  const header = [
    padStart("#", 3),
    padEnd("SESSION ID", 12),
    padEnd("DATE", 12),
    padEnd("MODEL", 22),
    padStart("TURNS", 6),
    padStart("COST", 10),
  ].join("  ");

  console.log(header);
  console.log("─".repeat(header.length));

  sessions.forEach((s, i) => {
    const label = s.title ? padEnd(s.title, 24) : padEnd("", 24);
    const row = [
      padStart(String(i + 1), 3),
      padEnd(s.sessionId.slice(0, 8), 12),
      padEnd(formatDate(s.startedAt), 12),
      padEnd(s.model, 22),
      padStart(String(s.turnCount), 6),
      padStart(formatCost(s.totalCostUsd), 10),
      ...(s.title ? [label] : []),
    ].join("  ");
    console.log(row);
  });
}
