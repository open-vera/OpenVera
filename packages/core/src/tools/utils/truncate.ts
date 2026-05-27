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

// ── Token-budget truncation (head/tail preservation) ──────────────────────────

export interface TruncatedOutput {
  truncated: string;
  originalLength: number;
  wasTruncated: boolean;
}

/**
 * Truncate long output preserving the beginning and end.
 *
 * Strategy: keep the first 60% and last 40% of the character budget,
 * inserting a `[...truncated N chars...]` marker in between.
 *
 * @param output  The full output string.
 * @param maxTokens  Approximate token budget (1 token ≈ 4 chars). Default 4000.
 */
export function truncateOutput(
  output: string,
  maxTokens = 4000
): TruncatedOutput {
  const maxChars = maxTokens * 4;

  if (output.length <= maxChars) {
    return {
      truncated: output,
      originalLength: output.length,
      wasTruncated: false,
    };
  }

  const headRatio = 0.6;
  const headLen = Math.floor(maxChars * headRatio);
  const tailLen = maxChars - headLen;

  const head = output.slice(0, headLen);
  const tail = output.slice(output.length - tailLen);
  const removedChars = output.length - headLen - tailLen;

  return {
    truncated: `${head}[...truncated ${removedChars} chars...]${tail}`,
    originalLength: output.length,
    wasTruncated: true,
  };
}
