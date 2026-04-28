import { useEffect, useRef, useState } from "react";
import { useStdout } from "ink";
import type { ChatMessage } from "../types.js";

export interface RecentSummary {
  awayMs: number;
  lastTask: string;
  toolsDone: number;
  status: string;
}

function formatAway(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分钟`;
  return `${Math.floor(m / 60)}小时${m % 60 ? `${m % 60}分` : ""}`;
}

function buildSummary(
  messages: ChatMessage[],
  streamStatus: string,
  awayMs: number,
): RecentSummary {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const raw = lastUser?.content ?? "";
  const lastTask = raw.length > 72 ? raw.slice(0, 72) + "…" : raw || "（无任务）";

  const toolsDone = messages.reduce((n, m) => n + (m.toolUses?.length ?? 0), 0);

  const statusLabel =
    streamStatus === "idle" ? "空闲" :
    streamStatus === "streaming" ? "正在生成…" :
    streamStatus === "waiting_tool" ? "工具执行中" : streamStatus;

  return { awayMs, lastTask, toolsDone, status: statusLabel };
}

export function formatRecentLine(s: RecentSummary): string {
  const parts = [`↩ 离开了 ${formatAway(s.awayMs)}`];
  if (s.lastTask) parts.push(`刚在做: "${s.lastTask}"`);
  if (s.toolsDone > 0) parts.push(`已完成 ${s.toolsDone} 次工具调用`);
  parts.push(`当前 ${s.status}`);
  return parts.join("  ·  ");
}

const MIN_AWAY_MS = 30_000;
const AUTO_DISMISS_MS = 15_000;

export function useFocusRecent(opts: {
  messages: ChatMessage[];
  streamStatus: string;
}): { summary: RecentSummary | null; dismiss: () => void } {
  const { stdout } = useStdout();
  const [summary, setSummary] = useState<RecentSummary | null>(null);
  const awayStartRef = useRef<number | null>(null);
  const messagesRef = useRef(opts.messages);
  const statusRef = useRef(opts.streamStatus);

  // Keep refs fresh every render — avoid stale closure in the data handler
  useEffect(() => {
    messagesRef.current = opts.messages;
    statusRef.current = opts.streamStatus;
  });

  // Auto-dismiss after timeout
  useEffect(() => {
    if (!summary) return;
    const t = setTimeout(() => setSummary(null), AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, [summary]);

  useEffect(() => {
    if (!process.stdin.isTTY) return;

    stdout.write("\x1b[?1004h"); // enable focus-in/out reporting

    const onData = (chunk: Buffer | string) => {
      const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (s.includes("\x1b[O")) {
        // focus lost
        awayStartRef.current = Date.now();
      } else if (s.includes("\x1b[I")) {
        // focus gained
        if (awayStartRef.current !== null) {
          const elapsed = Date.now() - awayStartRef.current;
          awayStartRef.current = null;
          if (elapsed >= MIN_AWAY_MS) {
            setSummary(buildSummary(messagesRef.current, statusRef.current, elapsed));
          }
        }
      }
    };

    process.stdin.on("data", onData);
    return () => {
      stdout.write("\x1b[?1004l"); // disable focus reporting
      process.stdin.off("data", onData);
    };
  }, [stdout]);

  return { summary, dismiss: () => setSummary(null) };
}
