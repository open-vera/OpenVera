import { describe, expect, it } from "vitest";
import {
  extractImportSpecifierAt,
  importSpecifierCandidates,
} from "@/preview/import-path";
import { resolveImportPathAtOffset } from "@/preview/resolve-import";

describe("import-path", () => {
  it("extracts specifier under the cursor", () => {
    const doc = `import eslint from "@eslint/js";\nimport globals from "globals";\n`;
    const offset = doc.indexOf('"globals"') + 2;
    expect(extractImportSpecifierAt(doc, offset)).toBe("globals");
  });

  it("builds relative and package candidates", () => {
    const relative = importSpecifierCandidates(
      "/workspace",
      "/workspace/src/app.ts",
      "./util",
    );
    expect(relative).toContain("/workspace/src/util.ts");

    const pkg = importSpecifierCandidates(
      "/workspace",
      "/workspace/eslint.config.js",
      "globals",
    );
    expect(pkg).toContain("/workspace/node_modules/globals/package.json");
    expect(pkg).toContain("/workspace/node_modules/globals/index.js");
  });

  it("resolves the first existing candidate", async () => {
    const doc = `import globals from "globals";\n`;
    const offset = doc.indexOf('"globals"') + 2;
    const path = await resolveImportPathAtOffset({
      doc,
      offset,
      workspaceRoot: "/workspace",
      fromFilePath: "/workspace/eslint.config.js",
      pathExists: async (candidate) =>
        candidate === "/workspace/node_modules/globals/index.js",
    });
    expect(path).toBe("/workspace/node_modules/globals/index.js");
  });
});
