import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // `dist/` holds compiled copies of these very tests; collecting them runs
    // stale code against paths that only exist in the source layout.
    // Keep the default node_modules exclusion — nested example projects vendor
    // their own test suites.
    exclude: ["**/dist/**", "**/node_modules/**"],
  },
});
