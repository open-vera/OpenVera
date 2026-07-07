import { appendFile } from "@/bridge";

export interface PartnerRunLogEntry {
  event: string;
  [key: string]: unknown;
}

function sanitizeRunLogSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
}

export function buildPartnerRunLogPath(
  rootPath: string,
  date = new Date(),
  taskId?: string | null,
): string {
  const normalizedRoot = rootPath.replace(/\/$/, "");
  const day = date.toISOString().slice(0, 10);
  if (taskId) {
    return `${normalizedRoot}/.vera/partner-runs/${day}/${sanitizeRunLogSegment(taskId)}.jsonl`;
  }
  return `${normalizedRoot}/.vera/partner-runs/${day}.jsonl`;
}

export function formatPartnerRunLogEntry(entry: PartnerRunLogEntry, date = new Date()): string {
  return `${JSON.stringify({
    timestamp: date.toISOString(),
    ...entry,
  })}\n`;
}

export async function appendPartnerRunLogEntry(
  rootPath: string,
  entry: PartnerRunLogEntry,
  taskId?: string | null,
): Promise<void> {
  await appendFile(
    buildPartnerRunLogPath(rootPath, new Date(), taskId),
    formatPartnerRunLogEntry(entry),
  );
}

export function formatRunLogPlaceholder(path: string, error?: unknown): string {
  const message =
    error instanceof Error ? error.message : error == null ? "" : String(error);
  const details = message
    ? [
        "",
        "底层读取信息：",
        message,
        "",
      ]
    : [""];

  return [
    "日志文件尚未生成。",
    "",
    `路径：${path}`,
    "",
    "Agent 开始写入后会在这里生成运行日志；如果刚刚启动任务，请稍后再点一次日志。",
    ...details,
  ].join("\n");
}

export function formatRunLogReadFailure(path: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return [
    "日志文件读取失败。",
    "",
    `路径：${path}`,
    "",
    "可能原因：当前工作区路径不正确，或日志文件权限异常。",
    "",
    `错误：${message}`,
    "",
  ].join("\n");
}
