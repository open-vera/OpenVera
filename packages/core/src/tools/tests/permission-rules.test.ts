import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock node:fs and node:os before importing the module under test
const { mockExistsSync, mockReadFileSync, mockHomedir } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockHomedir: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
}));

vi.mock("node:os", () => ({
  homedir: mockHomedir,
}));

import { loadPermissionRules, matchesPattern } from "../permission-rules.js";

describe("permission-rules", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHomedir.mockReturnValue("/home/user");
  });

  // ── loadPermissionRules ────────────────────────────────────────────────────

  describe("loadPermissionRules", () => {
    it("returns empty rules when neither file exists", () => {
      mockExistsSync.mockReturnValue(false);

      const rules = loadPermissionRules("/project");
      expect(rules).toEqual({});
    });

    it("loads rules from home permissions only", () => {
      mockExistsSync.mockImplementation((p: string) =>
        p === "/home/user/.vera/permissions.json"
      );
      mockReadFileSync.mockReturnValue(
        JSON.stringify({ allowedTools: ["bash", "read"] })
      );

      const rules = loadPermissionRules("/project");
      expect(rules.allowedTools).toEqual(["bash", "read"]);
    });

    it("loads rules from cwd permissions only", () => {
      mockExistsSync.mockImplementation((p: string) =>
        p === "/project/.vera/permissions.json"
      );
      mockReadFileSync.mockReturnValue(
        JSON.stringify({ deniedTools: ["rm"] })
      );

      const rules = loadPermissionRules("/project");
      expect(rules.deniedTools).toEqual(["rm"]);
    });

    it("merges rules from both files with dedup", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockImplementation((p: string) => {
        if (p === "/home/user/.vera/permissions.json") {
          return JSON.stringify({ allowedTools: ["bash", "read"] });
        }
        return JSON.stringify({ allowedTools: ["read", "write"] });
      });

      const rules = loadPermissionRules("/project");
      // "read" appears in both, should be deduped
      expect(rules.allowedTools).toEqual(["bash", "read", "write"]);
    });

    it("handles all four rule fields", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockImplementation((p: string) => {
        if (p === "/home/user/.vera/permissions.json") {
          return JSON.stringify({
            allowedTools: ["bash"],
            deniedTools: ["rm"],
            allowedBashCommands: ["ls"],
            deniedBashCommands: ["sudo"],
          });
        }
        return JSON.stringify({
          allowedTools: ["read"],
          deniedTools: ["eval"],
          allowedBashCommands: ["cat"],
          deniedBashCommands: ["reboot"],
        });
      });

      const rules = loadPermissionRules("/project");
      expect(rules.allowedTools).toEqual(["bash", "read"]);
      expect(rules.deniedTools).toEqual(["rm", "eval"]);
      expect(rules.allowedBashCommands).toEqual(["ls", "cat"]);
      expect(rules.deniedBashCommands).toEqual(["sudo", "reboot"]);
    });

    it("returns empty fields when file has no matching arrays", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({}));

      const rules = loadPermissionRules("/project");
      expect(rules.allowedTools).toBeUndefined();
      expect(rules.deniedTools).toBeUndefined();
      expect(rules.allowedBashCommands).toBeUndefined();
      expect(rules.deniedBashCommands).toBeUndefined();
    });
  });

  // ── matchesPattern ─────────────────────────────────────────────────────────

  describe("matchesPattern", () => {
    it("returns false when patterns is undefined", () => {
      expect(matchesPattern("bash", undefined)).toBe(false);
    });

    it("returns false when patterns is empty", () => {
      expect(matchesPattern("bash", [])).toBe(false);
    });

    it("matches exact strings", () => {
      expect(matchesPattern("bash", ["bash"])).toBe(true);
      expect(matchesPattern("bash", ["read"])).toBe(false);
    });

    it("matches with * wildcard", () => {
      expect(matchesPattern("bash-tool", ["bash-*"])).toBe(true);
      expect(matchesPattern("read", ["bash-*"])).toBe(false);
      expect(matchesPattern("anything", ["*"])).toBe(true);
    });

    it("matches with ? wildcard (single char)", () => {
      expect(matchesPattern("ba", ["b?"])).toBe(true);
      expect(matchesPattern("b", ["b?"])).toBe(false);
      expect(matchesPattern("bar", ["b?"])).toBe(false);
    });

    it("matches with combined wildcards", () => {
      expect(matchesPattern("tool-v2", ["tool-?*"])).toBe(true);
      expect(matchesPattern("tool-", ["tool-?*"])).toBe(false);
    });

    it("matches multiple patterns (any match = true)", () => {
      expect(matchesPattern("bash", ["read", "write", "bash"])).toBe(true);
    });

    it("escapes special regex characters", () => {
      expect(matchesPattern("file.ts", ["file.ts"])).toBe(true);
      expect(matchesPattern("fileXts", ["file.ts"])).toBe(false);
    });

    it("handles patterns with + and $ characters", () => {
      expect(matchesPattern("$var+", ["$var+"])).toBe(true);
      expect(matchesPattern("$varX", ["$var+"])).toBe(false);
    });

    it("handles patterns with parentheses and brackets", () => {
      expect(matchesPattern("func()", ["func()"])).toBe(true);
      expect(matchesPattern("arr[0]", ["arr[0]"])).toBe(true);
    });

    it("returns false when no patterns match", () => {
      expect(matchesPattern("unknown", ["bash", "read", "write"])).toBe(false);
    });
  });

  // ── readRulesFile (indirect via loadPermissionRules) ────────────────────────

  describe("readRulesFile error handling", () => {
    it("returns empty object when file has invalid JSON", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue("not valid json {{{");

      const rules = loadPermissionRules("/project");
      // Both files attempted: home returns invalid, cwd returns invalid
      // mergeRules({}, {}) = {}
      expect(rules.allowedTools).toBeUndefined();
    });

    it("filters non-string values from arrays", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({ allowedTools: ["bash", 123, null, "read", true] })
      );

      const rules = loadPermissionRules("/project");
      expect(rules.allowedTools).toEqual(["bash", "read"]);
    });

    it("returns undefined for non-array fields", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({ allowedTools: "not-an-array" })
      );

      const rules = loadPermissionRules("/project");
      expect(rules.allowedTools).toBeUndefined();
    });
  });

  // ── mergeArray edge cases ──────────────────────────────────────────────────

  describe("mergeArray", () => {
    it("returns undefined when both arrays are undefined", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({}));

      const rules = loadPermissionRules("/project");
      expect(rules.allowedTools).toBeUndefined();
    });

    it("returns the defined array when one side is undefined", () => {
      mockExistsSync.mockImplementation((p: string) =>
        p === "/project/.vera/permissions.json"
      );
      mockReadFileSync.mockReturnValue(
        JSON.stringify({ allowedTools: ["bash"] })
      );

      const rules = loadPermissionRules("/project");
      expect(rules.allowedTools).toEqual(["bash"]);
    });

    it("deduplicates across both arrays", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockImplementation((p: string) => {
        if (p === "/home/user/.vera/permissions.json") {
          return JSON.stringify({ allowedBashCommands: ["ls", "cat"] });
        }
        return JSON.stringify({ allowedBashCommands: ["cat", "grep"] });
      });

      const rules = loadPermissionRules("/project");
      expect(rules.allowedBashCommands).toEqual(["ls", "cat", "grep"]);
    });
  });
});
