// 执行辅助 — timeout、重试

import { errorResult } from "./types.js";
import type { ToolResult } from "./types.js";

export async function executeWithTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        Object.assign(
          errorResult("TIMEOUT", `Tool execution timed out after ${timeoutMs}ms`) as unknown as Error,
          { name: "TimeoutError" }
        )
      );
    }, timeoutMs);

    fn().then(
      (result) => { clearTimeout(timer); resolve(result); },
      (err)    => { clearTimeout(timer); reject(err); }
    );
  });
}

/**
 * Simple retry wrapper. Retries only on retryable errors.
 */
export async function retryWithPolicy(
  fn: () => Promise<ToolResult>,
  retries: number
): Promise<ToolResult> {
  let last: ToolResult | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    last = await fn();
    if (last.ok || !last.error?.retryable) return last;
    // Exponential backoff: 200ms, 400ms, 800ms…
    if (attempt < retries) await sleep(200 * Math.pow(2, attempt));
  }
  return last!;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
