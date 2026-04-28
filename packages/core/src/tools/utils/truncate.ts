// 输出截断 — 防止工具返回超大内容撑爆上下文

export const DEFAULT_MAX_LINES = 500;
export const DEFAULT_MAX_CHARS = 80_000;

export interface TruncateResult {
  content: string;
  truncated: boolean;
  totalLines: number;
}

/**
 * 按行数截断文本。
 * 超出时在末尾追加提示，告知总行数和如何获取剩余内容。
 */
export function truncateLines(
  text: string,
  maxLines = DEFAULT_MAX_LINES,
  hintMsg?: string
): TruncateResult {
  const lines = text.split("\n");
  const totalLines = lines.length;
  if (totalLines <= maxLines) {
    return { content: text, truncated: false, totalLines };
  }
  const kept = lines.slice(0, maxLines);
  const remaining = totalLines - maxLines;
  const hint = hintMsg ?? `[... ${remaining} more lines — use offset/limit to read more]`;
  return { content: kept.join("\n") + "\n" + hint, truncated: true, totalLines };
}

/**
 * 按字符数截断（用于 bash 输出等无结构文本）。
 */
export function truncateChars(
  text: string,
  maxChars = DEFAULT_MAX_CHARS
): TruncateResult {
  const lines = text.split("\n");
  if (text.length <= maxChars) {
    return { content: text, truncated: false, totalLines: lines.length };
  }
  const truncated = text.slice(0, maxChars);
  const remaining = text.length - maxChars;
  return {
    content: truncated + `\n[... ${remaining} more characters truncated]`,
    truncated: true,
    totalLines: truncated.split("\n").length,
  };
}
