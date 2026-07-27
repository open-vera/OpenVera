/**
 * Extract gateway diagnostic headers from LLM SDK errors.
 * Internal gateways commonly attach `gw-*` / `x-gw-*` response headers on failures.
 */

function isHeadersLike(value: unknown): value is {
  forEach: (callback: (value: string, key: string) => void) => void;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { forEach?: unknown }).forEach === "function"
  );
}

function isGwHeaderName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith("gw-") || lower.startsWith("x-gw-");
}

/** Collect gw-* / x-gw-* headers from an OpenAI/Anthropic APIError (or plain map). */
export function extractGatewayErrorHeaders(
  error: unknown,
): Record<string, string> {
  if (!error || typeof error !== "object") return {};
  const headers = (error as { headers?: unknown }).headers;
  if (!headers) return {};

  const out: Record<string, string> = {};

  if (isHeadersLike(headers)) {
    headers.forEach((value, key) => {
      if (isGwHeaderName(key) && value) {
        out[key] = value;
      }
    });
    return out;
  }

  if (typeof headers === "object") {
    for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
      if (isGwHeaderName(key) && typeof value === "string" && value) {
        out[key] = value;
      }
    }
  }

  return out;
}

/** Format gateway headers for inclusion in user-visible error text. */
export function formatGatewayErrorHeaders(
  headers: Record<string, string>,
): string {
  const entries = Object.entries(headers).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  if (entries.length === 0) return "";
  return [
    "网关 Headers：",
    ...entries.map(([key, value]) => `${key}: ${value}`),
  ].join("\n");
}

/** Append gateway header block to an error message when present. */
export function appendGatewayErrorHeaders(
  message: string,
  error: unknown,
): string {
  const block = formatGatewayErrorHeaders(extractGatewayErrorHeaders(error));
  if (!block) return message;
  if (message.includes("网关 Headers：")) return message;
  return `${message}\n\n${block}`;
}
