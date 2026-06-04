// Debug logger that delegates to the new structured logger.
// Use process.stderr.write so logs are always visible during development.

import { createLogger } from "@open-vera/logger";

const log = createLogger("repl");

export function debugLog(...args: unknown[]): void {
  const msg = args.map(String).join(" ");
  log.debug(msg);
}
