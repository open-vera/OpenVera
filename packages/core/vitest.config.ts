import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    exclude: ["dist/**", "node_modules/**"],
    pool: "forks",
    poolOptions: {
      forks: {
        maxForks: process.env.CI ? 2 : undefined,
        minForks: 1,
      },
    },
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**"],
    },
  },
});
