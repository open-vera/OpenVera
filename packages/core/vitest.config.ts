import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    exclude: ["dist/**", "node_modules/**"],
    pool: "forks",
    poolOptions: {
      forks: {
        maxForks: 3,
        minForks: 1,
      },
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**"],
    },
  },
});
