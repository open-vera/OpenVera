import sonarjs from "eslint-plugin-sonarjs";
import tsParser from "@typescript-eslint/parser";

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/*.d.ts",
    ],
  },
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    plugins: { sonarjs },
    languageOptions: {
      parser: tsParser,
      // no projectService — pure AST, no type resolution, 10-20x faster
    },
    rules: {
      "sonarjs/cognitive-complexity": ["warn", 15],
      "sonarjs/no-identical-functions": "warn",
      "sonarjs/no-duplicated-branches": "warn",
    },
  },
];
