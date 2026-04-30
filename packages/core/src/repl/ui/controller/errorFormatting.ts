export function formatRuntimeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("apiKey") || msg.includes("authToken") || msg.includes("authentication") || msg.includes("API key")) {
    return [
      "No API key configured.",
      "  → Set it in .vera/settings.json:  providers.<name>.api_key",
      "  → Or via env var:                 ANTHROPIC_API_KEY=sk-...",
    ].join("\n");
  }
  if (msg.includes("rate_limit") || msg.includes("429")) {
    return "Rate limited — wait a moment and try again.";
  }
  if (msg.includes("ECONNREFUSED") || msg.includes("ENOTFOUND") || msg.includes("fetch")) {
    return "Network error — check your connection or base_url in .vera/settings.json.";
  }
  return `Error: ${msg}`;
}
