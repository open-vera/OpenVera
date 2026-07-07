/**
 * Normalize provider base URLs before passing them to SDK clients.
 *
 * OpenAI SDK appends `/chat/completions` to baseURL, so compatible gateways
 * usually require a `/v1` suffix. Anthropic SDK appends `/v1/messages` itself,
 * so user-provided `/v1` should be stripped to avoid `/v1/v1/messages`.
 */

export function normalizeOpenAiBaseUrl(baseUrl?: string): string | undefined {
  if (!baseUrl?.trim()) return undefined;
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (/\/v\d+(?:\/|$)/.test(trimmed)) return trimmed;
  if (trimmed.includes("/deployments/")) return trimmed;
  return `${trimmed}/v1`;
}

export function normalizeAnthropicBaseUrl(baseUrl?: string): string | undefined {
  if (!baseUrl?.trim()) return undefined;
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (trimmed.endsWith("/v1")) return trimmed.slice(0, -3);
  return trimmed;
}
