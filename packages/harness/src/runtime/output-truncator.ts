// Output truncator — truncate long tool/shell output with summary preservation

export interface TruncatedOutput {
  /** The (possibly truncated) output string. */
  truncated: string;
  /** Original output length in characters. */
  originalLength: number;
  /** Whether truncation was applied. */
  wasTruncated: boolean;
}

/**
 * Truncate long output preserving the beginning and end.
 *
 * Strategy:
 * - If output fits within the character budget, return as-is.
 * - Otherwise keep the first 60% and last 40% of the budget,
 *   inserting a `[...truncated N chars...]` marker in between.
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
