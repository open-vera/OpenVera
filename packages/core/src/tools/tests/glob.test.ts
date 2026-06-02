/**
 * Tests for glob tool (glob.ts)
 *
 * Verifies: glob pattern matching via globRegex/matchGlob, directory walking
 * via walkDir (with skip dirs and inaccessible entries), error handling (ENOENT,
 * unknown errors), result formatting (sorted relative paths), custom base path,
 * and tool registration metadata.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readdirSync, statSync } from "node:fs";
import type { Stats } from "node:fs";
import type { ToolContext } from "../types.js";
import { globTool } from "../glob.js";

vi.mock("node:fs", () => ({
  readdirSync: vi.fn(),
  statSync: vi.fn(),
}));

const mockCtx: ToolContext = {
  cwd: "/tmp",
  sessionId: "test-session",
};

function makeFile(): Stats {
  return { isDirectory: () => false } as unknown as Stats;
}

function makeDir(): Stats {
  return { isDirectory: () => true } as unknown as Stats;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Tool Registration ─────────────────────────────────────────────────────────

describe("globTool registration", () => {
  it("registers with name 'glob'", async () => {
    const tool = globTool;
    expect(tool.name).toBe("glob");
  });

  it("has a description mentioning glob pattern matching", async () => {
    const tool = globTool;
    expect(tool.description).toContain("glob");
    expect(tool.description.toLowerCase()).toContain("pattern");
  });

  it("requires pattern parameter and makes path optional", async () => {
    const tool = globTool;
    expect(tool.parameters.required).toEqual(["pattern"]);
    expect(tool.parameters.properties).toHaveProperty("pattern");
    expect(tool.parameters.properties).toHaveProperty("path");
  });

  it("is idempotent", async () => {
    const tool = globTool;
    expect(tool.options?.idempotent).toBe(true);
  });

  it("has low risk level", async () => {
    const tool = globTool;
    expect(tool.options?.riskLevel).toBe("low");
  });

  it("has a 15-second timeout", async () => {
    const tool = globTool;
    expect(tool.options?.timeoutMs).toBe(15_000);
  });
});

// ── globRegex — basic pattern types ───────────────────────────────────────────

describe("globRegex: * wildcard", () => {
  it("matches any characters within a single path segment", async () => {
    vi.mocked(readdirSync).mockImplementation((dir: string) => {
      if (dir === "/tmp") return ["foo.ts", "subdir"] as any;
      if (dir === "/tmp/subdir") return ["bar.ts"] as any;
      return [] as any;
    });
    vi.mocked(statSync).mockImplementation((path: string) => {
      if (path === "/tmp/foo.ts" || path === "/tmp/subdir/bar.ts") return makeFile();
      if (path === "/tmp/subdir") return makeDir();
      throw new Error("ENOENT");
    });

    const tool = globTool;
    const result = await tool.execute({ pattern: "*.ts" }, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("foo.ts");
    expect(result.content).not.toContain("subdir");
    expect(result.content).not.toContain("bar.ts");
  });

  it("does not cross directory boundaries with *", async () => {
    vi.mocked(readdirSync).mockImplementation((dir: string) => {
      if (dir === "/tmp") return ["src"] as any;
      if (dir === "/tmp/src") return ["lib.ts", "util.ts"] as any;
      return [] as any;
    });
    vi.mocked(statSync).mockImplementation((path: string) => {
      if (path === "/tmp/src") return makeDir();
      if (path === "/tmp/src/lib.ts" || path === "/tmp/src/util.ts") return makeFile();
      throw new Error("ENOENT");
    });

    const tool = globTool;
    const result = await tool.execute({ pattern: "*.ts" }, mockCtx);

    // *.ts should only match files directly in cwd, not in subdirectories
    expect(result.ok).toBe(true);
    expect(result.content).toContain("No files matching");
  });
});

describe("globRegex: ** globstar", () => {
  it("matches across directory boundaries", async () => {
    vi.mocked(readdirSync).mockImplementation((dir: string) => {
      if (dir === "/tmp") return ["a.ts", "subdir"] as any;
      if (dir === "/tmp/subdir") return ["b.ts", "nested"] as any;
      if (dir === "/tmp/subdir/nested") return ["c.ts"] as any;
      return [] as any;
    });
    vi.mocked(statSync).mockImplementation((path: string) => {
      if (path === "/tmp/a.ts" || path === "/tmp/subdir/b.ts" || path === "/tmp/subdir/nested/c.ts") return makeFile();
      if (path === "/tmp/subdir" || path === "/tmp/subdir/nested") return makeDir();
      throw new Error("ENOENT");
    });

    const tool = globTool;
    const result = await tool.execute({ pattern: "**/*.ts" }, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("a.ts");
    expect(result.content).toContain("subdir/b.ts");
    expect(result.content).toContain("subdir/nested/c.ts");
    expect(result.content).toContain("3 file(s)");
  });

  it("**/ prefix matches files at any depth", async () => {
    vi.mocked(readdirSync).mockImplementation((dir: string) => {
      if (dir === "/tmp") return ["deep"] as any;
      if (dir === "/tmp/deep") return ["nested"] as any;
      if (dir === "/tmp/deep/nested") return ["target.txt"] as any;
      return [] as any;
    });
    vi.mocked(statSync).mockImplementation((path: string) => {
      if (path === "/tmp/deep" || path === "/tmp/deep/nested") return makeDir();
      if (path === "/tmp/deep/nested/target.txt") return makeFile();
      throw new Error("ENOENT");
    });

    const tool = globTool;
    const result = await tool.execute({ pattern: "**/target.txt" }, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("deep/nested/target.txt");
  });
});

describe("globRegex: ? wildcard", () => {
  it("matches exactly one non-slash character", async () => {
    vi.mocked(readdirSync).mockImplementation((dir: string) => {
      if (dir === "/tmp") return ["file1.ts", "file12.ts", "file.ts"] as any;
      return [] as any;
    });
    vi.mocked(statSync).mockImplementation((path: string) => {
      if (path === "/tmp/file1.ts" || path === "/tmp/file12.ts" || path === "/tmp/file.ts") return makeFile();
      throw new Error("ENOENT");
    });

    const tool = globTool;
    const result = await tool.execute({ pattern: "file?.ts" }, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("file1.ts");
    expect(result.content).not.toContain("file12.ts");
    expect(result.content).not.toContain("file.ts");
  });

  it("multiple ? match multiple characters", async () => {
    vi.mocked(readdirSync).mockImplementation((dir: string) => {
      if (dir === "/tmp") return ["ab.ts", "abc.ts", "a.ts"] as any;
      return [] as any;
    });
    vi.mocked(statSync).mockReturnValue(makeFile());

    const tool = globTool;
    const result = await tool.execute({ pattern: "??.ts" }, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("ab.ts");
    expect(result.content).not.toContain("abc.ts");
    expect(result.content).not.toContain("a.ts");
  });
});

describe("globRegex: literal characters and escaping", () => {
  it("matches literal characters exactly", async () => {
    vi.mocked(readdirSync).mockImplementation((dir: string) => {
      if (dir === "/tmp") return ["index.ts", "indx.ts"] as any;
      return [] as any;
    });
    vi.mocked(statSync).mockReturnValue(makeFile());

    const tool = globTool;
    const result = await tool.execute({ pattern: "index.ts" }, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("index.ts");
    expect(result.content).not.toContain("indx.ts");
  });

  it("escapes dot so pattern.ts does not match patternXts", async () => {
    vi.mocked(readdirSync).mockImplementation((dir: string) => {
      if (dir === "/tmp") return ["test.ts", "testXts"] as any;
      return [] as any;
    });
    vi.mocked(statSync).mockReturnValue(makeFile());

    const tool = globTool;
    const result = await tool.execute({ pattern: "test.ts" }, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("test.ts");
    expect(result.content).not.toContain("testXts");
  });

  it("escapes plus sign as literal character", async () => {
    vi.mocked(readdirSync).mockImplementation((dir: string) => {
      if (dir === "/tmp") return ["helper+.ts", "helper.ts"] as any;
      return [] as any;
    });
    vi.mocked(statSync).mockReturnValue(makeFile());

    const tool = globTool;
    const result = await tool.execute({ pattern: "helper+.ts" }, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("helper+.ts");
    expect(result.content).not.toContain("helper.ts");
  });

  it("escapes caret and dollar as literal characters", async () => {
    vi.mocked(readdirSync).mockImplementation((dir: string) => {
      if (dir === "/tmp") return ["^start$.txt", "start.txt"] as any;
      return [] as any;
    });
    vi.mocked(statSync).mockReturnValue(makeFile());

    const tool = globTool;
    const result = await tool.execute({ pattern: "^start$.txt" }, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("^start$.txt");
    expect(result.content).not.toContain("start.txt");
  });

  it("escapes square brackets as literal characters", async () => {
    vi.mocked(readdirSync).mockImplementation((dir: string) => {
      if (dir === "/tmp") return ["test[1].ts", "test1.ts"] as any;
      return [] as any;
    });
    vi.mocked(statSync).mockReturnValue(makeFile());

    const tool = globTool;
    const result = await tool.execute({ pattern: "test[1].ts" }, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("test[1].ts");
    expect(result.content).not.toContain("test1.ts");
  });

  it("escapes curly braces and pipe as literal characters", async () => {
    vi.mocked(readdirSync).mockImplementation((dir: string) => {
      if (dir === "/tmp") return ["{a|b}.ts", "a.ts"] as any;
      return [] as any;
    });
    vi.mocked(statSync).mockReturnValue(makeFile());

    const tool = globTool;
    const result = await tool.execute({ pattern: "{a|b}.ts" }, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("{a|b}.ts");
    expect(result.content).not.toContain("a.ts");
  });

  it("escapes parentheses as literal characters", async () => {
    vi.mocked(readdirSync).mockImplementation((dir: string) => {
      if (dir === "/tmp") return ["file(1).ts", "file1.ts"] as any;
      return [] as any;
    });
    vi.mocked(statSync).mockReturnValue(makeFile());

    const tool = globTool;
    const result = await tool.execute({ pattern: "file(1).ts" }, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("file(1).ts");
    expect(result.content).not.toContain("file1.ts");
  });

  it("normalizes backslash in both pattern and path to forward slash", async () => {
    vi.mocked(readdirSync).mockImplementation((dir: string) => {
      if (dir === "/tmp") return ["path\\file.ts"] as any;
      return [] as any;
    });
    vi.mocked(statSync).mockReturnValue(makeFile());

    const tool = globTool;
    // Both pattern and filename use a single backslash, which matchGlob
    // normalizes to forward slashes. The backslash itself is in the escaped
    // regex-special set, so it is treated as a literal char (then normalized).
    const result = await tool.execute({ pattern: "path\\file.ts" }, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("path\\file.ts");
  });
});

// ── globTool execute — results and error handling ──────────────────────────────

describe("globTool execute: results", () => {
  it("returns sorted relative paths for matched files", async () => {
    vi.mocked(readdirSync).mockImplementation((dir: string) => {
      if (dir === "/tmp") return ["z.ts", "a.ts", "m.ts"] as any;
      return [] as any;
    });
    vi.mocked(statSync).mockReturnValue(makeFile());

    const tool = globTool;
    const result = await tool.execute({ pattern: "*.ts" }, mockCtx);

    expect(result.ok).toBe(true);
    const content = result.content;
    const aIdx = content.indexOf("a.ts");
    const mIdx = content.indexOf("m.ts");
    const zIdx = content.indexOf("z.ts");
    expect(aIdx).toBeLessThan(mIdx);
    expect(mIdx).toBeLessThan(zIdx);
    expect(result.content).toContain("3 file(s)");
  });

  it("includes match count in the result content", async () => {
    vi.mocked(readdirSync).mockImplementation((dir: string) => {
      if (dir === "/tmp") return ["one.ts", "two.ts"] as any;
      return [] as any;
    });
    vi.mocked(statSync).mockReturnValue(makeFile());

    const tool = globTool;
    const result = await tool.execute({ pattern: "*.ts" }, mockCtx);

    expect(result.content).toContain("2 file(s) matching *.ts:");
  });

  it("sets renderHint to file-list on success", async () => {
    vi.mocked(readdirSync).mockImplementation((dir: string) => {
      if (dir === "/tmp") return ["ok.ts"] as any;
      return [] as any;
    });
    vi.mocked(statSync).mockReturnValue(makeFile());

    const tool = globTool;
    const result = await tool.execute({ pattern: "*.ts" }, mockCtx);

    expect(result.metadata?.renderHint).toEqual({ type: "file-list" });
  });
});

describe("globTool execute: no matches", () => {
  it("returns ok but empty-style message when no files match", async () => {
    vi.mocked(readdirSync).mockImplementation((dir: string) => {
      if (dir === "/tmp") return ["unrelated.txt"] as any;
      return [] as any;
    });
    vi.mocked(statSync).mockReturnValue(makeFile());

    const tool = globTool;
    const result = await tool.execute({ pattern: "*.ts" }, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("No files matching: *.ts");
    expect(result.metadata?.renderHint).toEqual({ type: "file-list" });
  });

  it("returns empty result for an empty directory", async () => {
    vi.mocked(readdirSync).mockReturnValue([] as any);

    const tool = globTool;
    const result = await tool.execute({ pattern: "*.ts" }, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("No files matching");
  });
});

describe("globTool execute: custom base path", () => {
  it("uses custom base path via path arg", async () => {
    vi.mocked(readdirSync).mockImplementation((dir: string) => {
      if (dir === "/tmp/src") return ["main.ts", "lib"] as any;
      if (dir === "/tmp/src/lib") return ["helper.ts"] as any;
      return [] as any;
    });
    vi.mocked(statSync).mockImplementation((path: string) => {
      if (path === "/tmp/src/lib") return makeDir();
      if (path === "/tmp/src/main.ts" || path === "/tmp/src/lib/helper.ts") return makeFile();
      throw new Error("ENOENT");
    });

    const tool = globTool;
    const result = await tool.execute({ pattern: "**/*.ts", path: "src" }, mockCtx);

    expect(result.ok).toBe(true);
    // Results should be relative to cwd, so they include "src/" prefix
    expect(result.content).toContain("src/main.ts");
    expect(result.content).toContain("src/lib/helper.ts");
  });

  it("uses default cwd when no path arg given", async () => {
    vi.mocked(readdirSync).mockImplementation((dir: string) => {
      if (dir === "/tmp") return ["root.ts"] as any;
      return [] as any;
    });
    vi.mocked(statSync).mockReturnValue(makeFile());

    const tool = globTool;
    const result = await tool.execute({ pattern: "*.ts" }, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("root.ts");
  });
});

// ── Error handling ────────────────────────────────────────────────────────────

describe("globTool execute: error handling", () => {
  it("returns NOT_FOUND when base directory does not exist (ENOENT)", async () => {
    vi.mocked(readdirSync).mockImplementation(() => {
      const err = new Error("ENOENT: no such file or directory, scandir '/tmp/missing'") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });

    const tool = globTool;
    const result = await tool.execute({ pattern: "*.ts", path: "missing" }, mockCtx);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("NOT_FOUND");
    expect(result.content).toContain("Directory not found");
  });

  it("includes the path arg in the NOT_FOUND message", async () => {
    vi.mocked(readdirSync).mockImplementation(() => {
      const err = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });

    const tool = globTool;
    const result = await tool.execute({ pattern: "*.ts", path: "nope" }, mockCtx);

    expect(result.content).toContain("nope");
  });

  it("returns UNKNOWN when readdir fails with a non-ENOENT error", async () => {
    vi.mocked(readdirSync).mockImplementation(() => {
      const err = new Error("EIO: input/output error") as NodeJS.ErrnoException;
      err.code = "EIO";
      throw err;
    });

    const tool = globTool;
    const result = await tool.execute({ pattern: "*.ts" }, mockCtx);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("UNKNOWN");
    expect(result.content).toContain("EIO");
  });

  it("handles non-Error thrown values as UNKNOWN", async () => {
    vi.mocked(readdirSync).mockImplementation(() => {
      throw "raw string error";
    });

    const tool = globTool;
    const result = await tool.execute({ pattern: "*.ts" }, mockCtx);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("UNKNOWN");
    expect(result.content).toBe("raw string error");
  });

  it("handles Error with EACCES code as UNKNOWN", async () => {
    vi.mocked(readdirSync).mockImplementation(() => {
      const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
      err.code = "EACCES";
      throw err;
    });

    const tool = globTool;
    const result = await tool.execute({ pattern: "*.ts" }, mockCtx);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("UNKNOWN");
    expect(result.content).toContain("EACCES");
  });
});

// ── Directory walking ─────────────────────────────────────────────────────────

describe("globTool: walkDir skip directories", () => {
  it("skips node_modules, .git, .vera, dist, build, .next, .turbo", async () => {
    vi.mocked(readdirSync).mockImplementation((dir: string) => {
      if (dir === "/tmp") {
        return ["src", "node_modules", ".git", ".vera", "dist", "build", ".next", ".turbo"] as any;
      }
      if (dir === "/tmp/src") return ["main.ts"] as any;
      // These should never be reached because walkDir skips them
      if (dir === "/tmp/node_modules") return ["should-not-read.ts"] as any;
      if (dir === "/tmp/.git") return ["config"] as any;
      if (dir === "/tmp/.vera") return ["settings.json"] as any;
      if (dir === "/tmp/dist") return ["bundle.js"] as any;
      if (dir === "/tmp/build") return ["output.js"] as any;
      if (dir === "/tmp/.next") return ["cache.js"] as any;
      if (dir === "/tmp/.turbo") return ["turbo.json"] as any;
      return [] as any;
    });
    vi.mocked(statSync).mockImplementation((path: string) => {
      if (path === "/tmp/src") return makeDir();
      if (path === "/tmp/src/main.ts") return makeFile();
      throw new Error("ENOENT: unexpected stat call");
    });

    const tool = globTool;
    const result = await tool.execute({ pattern: "**/*" }, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("src/main.ts");
    // Verify none of the skipped directory contents appear
    for (const skip of ["node_modules", ".git/", ".vera/", "dist/", "build/", ".next/", ".turbo/"]) {
      expect(result.content).not.toContain(skip);
    }
  });

  it("does not enter skipped directories even if readdir was called", async () => {
    // readdirSync for skipped dirs should never be invoked
    vi.mocked(readdirSync).mockImplementation((dir: string) => {
      if (dir === "/tmp") return ["src", "node_modules"] as any;
      if (dir === "/tmp/src") return ["app.ts"] as any;
      // This mock branch should NOT be called — walkDir skips node_modules
      if (dir === "/tmp/node_modules") {
        throw new Error("readdirSync should not be called for node_modules");
      }
      return [] as any;
    });
    vi.mocked(statSync).mockImplementation((path: string) => {
      if (path === "/tmp/src") return makeDir();
      if (path === "/tmp/src/app.ts") return makeFile();
      throw new Error("ENOENT");
    });

    const tool = globTool;
    const result = await tool.execute({ pattern: "**/*" }, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("src/app.ts");
    expect(result.content).not.toContain("node_modules");
  });
});

describe("globTool: walkDir inaccessible entries", () => {
  it("skips entries when statSync throws", async () => {
    vi.mocked(readdirSync).mockImplementation((dir: string) => {
      if (dir === "/tmp") return ["readable.ts", "broken.ts"] as any;
      return [] as any;
    });
    vi.mocked(statSync).mockImplementation((path: string) => {
      if (path === "/tmp/readable.ts") return makeFile();
      // statSync throws for broken.ts — simulating a broken symlink
      throw new Error("ENOENT: broken symlink");
    });

    const tool = globTool;
    const result = await tool.execute({ pattern: "*.ts" }, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("readable.ts");
    expect(result.content).not.toContain("broken.ts");
    expect(result.content).toContain("1 file(s)");
  });

  it("continues walking despite statSync failures in subdirectories", async () => {
    vi.mocked(readdirSync).mockImplementation((dir: string) => {
      if (dir === "/tmp") return ["subdir"] as any;
      if (dir === "/tmp/subdir") return ["good.ts", "bad.ts"] as any;
      return [] as any;
    });
    vi.mocked(statSync).mockImplementation((path: string) => {
      if (path === "/tmp/subdir") return makeDir();
      if (path === "/tmp/subdir/good.ts") return makeFile();
      if (path === "/tmp/subdir/bad.ts") throw new Error("EACCES: permission denied");
      throw new Error("ENOENT");
    });

    const tool = globTool;
    const result = await tool.execute({ pattern: "**/*.ts" }, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("subdir/good.ts");
    expect(result.content).not.toContain("bad.ts");
  });
});

// ── Pattern matching edge cases ───────────────────────────────────────────────

describe("globTool: pattern edge cases", () => {
  it("handles pattern with only ** to match all files", async () => {
    vi.mocked(readdirSync).mockImplementation((dir: string) => {
      if (dir === "/tmp") return ["a.ts", "subdir"] as any;
      if (dir === "/tmp/subdir") return ["b.js"] as any;
      return [] as any;
    });
    vi.mocked(statSync).mockImplementation((path: string) => {
      if (path === "/tmp/a.ts" || path === "/tmp/subdir/b.js") return makeFile();
      if (path === "/tmp/subdir") return makeDir();
      throw new Error("ENOENT");
    });

    const tool = globTool;
    const result = await tool.execute({ pattern: "**" }, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("a.ts");
    expect(result.content).toContain("subdir/b.js");
  });

  it("handles exact filename pattern", async () => {
    vi.mocked(readdirSync).mockImplementation((dir: string) => {
      if (dir === "/tmp") return ["package.json", "package-lock.json"] as any;
      return [] as any;
    });
    vi.mocked(statSync).mockReturnValue(makeFile());

    const tool = globTool;
    const result = await tool.execute({ pattern: "package.json" }, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("package.json");
    expect(result.content).not.toContain("package-lock.json");
  });

  it("handles partial wildcard: prefix*.ts", async () => {
    vi.mocked(readdirSync).mockImplementation((dir: string) => {
      if (dir === "/tmp") return ["test-unit.ts", "test-e2e.ts", "other.ts"] as any;
      return [] as any;
    });
    vi.mocked(statSync).mockReturnValue(makeFile());

    const tool = globTool;
    const result = await tool.execute({ pattern: "test-*.ts" }, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("test-unit.ts");
    expect(result.content).toContain("test-e2e.ts");
    expect(result.content).not.toContain("other.ts");
  });

  it("handles partial wildcard: *suffix pattern", async () => {
    vi.mocked(readdirSync).mockImplementation((dir: string) => {
      if (dir === "/tmp") return ["file.test.ts", "file.spec.ts"] as any;
      return [] as any;
    });
    vi.mocked(statSync).mockReturnValue(makeFile());

    const tool = globTool;
    const result = await tool.execute({ pattern: "*.test.ts" }, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("file.test.ts");
    expect(result.content).not.toContain("file.spec.ts");
  });

  it("handles middle wildcard: prefix*suffix pattern", async () => {
    vi.mocked(readdirSync).mockImplementation((dir: string) => {
      if (dir === "/tmp") return ["report-2024-final.pdf", "report-2025-draft.pdf", "summary.pdf"] as any;
      return [] as any;
    });
    vi.mocked(statSync).mockReturnValue(makeFile());

    const tool = globTool;
    const result = await tool.execute({ pattern: "report-*-*.pdf" }, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("report-2024-final.pdf");
    expect(result.content).toContain("report-2025-draft.pdf");
    expect(result.content).not.toContain("summary.pdf");
  });

  it("combines ** with extension filter", async () => {
    vi.mocked(readdirSync).mockImplementation((dir: string) => {
      if (dir === "/tmp") return ["a.ts", "b.js", "subdir"] as any;
      if (dir === "/tmp/subdir") return ["c.ts", "d.js"] as any;
      return [] as any;
    });
    vi.mocked(statSync).mockImplementation((path: string) => {
      if (path === "/tmp/subdir") return makeDir();
      if (["/tmp/a.ts", "/tmp/b.js", "/tmp/subdir/c.ts", "/tmp/subdir/d.js"].includes(path)) return makeFile();
      throw new Error("ENOENT");
    });

    const tool = globTool;
    const result = await tool.execute({ pattern: "**/*.ts" }, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("a.ts");
    expect(result.content).toContain("subdir/c.ts");
    expect(result.content).not.toContain(".js");
    expect(result.content).toContain("2 file(s)");
  });

  it("normalizes backslashes in pattern to forward slashes", async () => {
    vi.mocked(readdirSync).mockImplementation((dir: string) => {
      if (dir === "/tmp") return ["subdir"] as any;
      if (dir === "/tmp/subdir") return ["file.ts"] as any;
      return [] as any;
    });
    vi.mocked(statSync).mockImplementation((path: string) => {
      if (path === "/tmp/subdir") return makeDir();
      if (path === "/tmp/subdir/file.ts") return makeFile();
      throw new Error("ENOENT");
    });

    const tool = globTool;
    // Use backslash separator — should be normalized to "/"
    const result = await tool.execute({ pattern: "subdir\\file.ts" }, mockCtx);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("subdir/file.ts");
  });

  it("returns ok: false on error, not ok: true with empty result", async () => {
    vi.mocked(readdirSync).mockImplementation(() => {
      throw new Error("ENOENT: directory gone");
    });

    const tool = globTool;
    const result = await tool.execute({ pattern: "*.ts" }, mockCtx);

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });
});
