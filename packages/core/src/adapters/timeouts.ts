/**
 * LLM request deadlines.
 *
 * Without a per-request timeout a gateway that accepts the connection and then
 * goes quiet hangs the whole agent run: the only backstop is the harness idle
 * timer, which any tool output can push back indefinitely.
 */
export const DEFAULT_LLM_REQUEST_TIMEOUT_MS = 120_000;

const ENV_KEY = "VERA_LLM_TIMEOUT_MS";

/** Resolve the per-request timeout, allowing an env override for slow gateways. */
export function resolveLlmRequestTimeoutMs(
  env: Record<string, string | undefined> = process.env
): number {
  const raw = env[ENV_KEY];
  if (raw === undefined || raw.trim() === "")
    return DEFAULT_LLM_REQUEST_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0)
    return DEFAULT_LLM_REQUEST_TIMEOUT_MS;
  return Math.floor(parsed);
}
