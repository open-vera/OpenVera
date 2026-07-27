import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // `dist/` holds compiled copies of these very tests; running both copies in
    // one process makes them fight over shared stores and fixture paths.
    exclude: ["**/dist/**", "**/node_modules/**"],
  },
});
