// Debug logger that bypasses console capture in captureCommandOutput.
// Use process.stderr.write so logs are always visible during development.

const ENABLED = !!process.env["VERA_DEBUG_RESUME"];

export function debugLog(...args: unknown[]): void {
  if (!ENABLED) return;
  const msg = args.map(String).join(" ") + "\n";
  process.stderr.write(msg);
}
