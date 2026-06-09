import { describe, expect, it } from "vitest";
import { isInsideCwd, safePath, sanitizeCwd } from "../path.js";
import { resolve, normalize, sep } from "node:path";

// ── Platform helpers ────────────────────────────────────────────────────────
const isWin = sep === "\\";
const DRIVE = isWin ? "Z:\\" : "";

/** Build a platform-native absolute path. */
function abs(...segments: string[]): string {
  return isWin
    ? resolve(DRIVE, ...segments)
    : resolve("/", ...segments);
}

// ── isInsideCwd ─────────────────────────────────────────────────────────────

describe("isInsideCwd", () => {
  it("returns true for target equal to baseDir", () => {
    const base = abs("home", "user", "project");
    expect(isInsideCwd(base, base)).toBe(true);
  });

  it("returns true with trailing slash on base", () => {
    const base = abs("home", "user", "project") + sep;
    expect(isInsideCwd(abs("home", "user", "project"), base)).toBe(true);
  });

  it("returns true with trailing slash on target", () => {
    const base = abs("home", "user", "project");
    expect(isInsideCwd(base + sep, base)).toBe(true);
  });

  it("returns true for child directory", () => {
    const base = abs("home", "user", "project");
    expect(isInsideCwd(abs("home", "user", "project", "src"), base)).toBe(true);
  });

  it("returns true for deeply nested child", () => {
    const base = abs("home", "user", "project");
    expect(isInsideCwd(abs("home", "user", "project", "src", "components", "ui"), base)).toBe(true);
  });

  it("returns false for parent directory", () => {
    const base = abs("home", "user", "project");
    expect(isInsideCwd(abs("home", "user"), base)).toBe(false);
  });

  it("returns false for sibling directory", () => {
    const base = abs("home", "user", "project");
    expect(isInsideCwd(abs("home", "user", "other-project"), base)).toBe(false);
  });

  it("returns false for unrelated absolute path", () => {
    const base = abs("home", "user", "project");
    expect(isInsideCwd(abs("etc", "passwd"), base)).toBe(false);
  });

  it("returns false when prefix matches but not a directory boundary", () => {
    const base = abs("home", "user", "project");
    expect(isInsideCwd(abs("home", "user", "project-backup"), base)).toBe(false);
  });

  it("resolves relative child path against baseDir", () => {
    const base = abs("home", "user", "project");
    expect(isInsideCwd("src", base)).toBe(true);
  });

  it("returns false for parent traversal outside baseDir", () => {
    const base = abs("home", "user", "project", "src");
    expect(isInsideCwd("../", base)).toBe(false);
  });

  it("returns false for ../ from shallow baseDir", () => {
    const base = abs("home", "user", "project");
    expect(isInsideCwd("../", base)).toBe(false);
  });

  it("handles dot as inside", () => {
    const base = abs("home", "user", "project");
    expect(isInsideCwd(".", base)).toBe(true);
  });

  it("returns false for ../lib from subdirectory (sibling, not child)", () => {
    const base = abs("home", "user", "project", "src");
    expect(isInsideCwd("../lib", base)).toBe(false);
  });

  it("returns true for src/../lib staying inside broader cwd", () => {
    const base = abs("home", "user", "project");
    expect(isInsideCwd("src/../lib", base)).toBe(true);
  });

  it("handles absolute target within baseDir", () => {
    const base = abs("home", "user", "project");
    expect(isInsideCwd(abs("home", "user", "project", "src", "main.ts"), base)).toBe(true);
  });

  it("handles absolute target outside baseDir", () => {
    const base = abs("home", "user", "project");
    expect(isInsideCwd(abs("var", "log"), base)).toBe(false);
  });

  it("normalizes redundant separators (inside)", () => {
    const base = abs("home", "user", "project");
    const target = abs("home", "user", "project", "", "src", "", "index.ts");
    expect(isInsideCwd(target, base)).toBe(true);
  });

  it("normalizes redundant separators (outside)", () => {
    const base = abs("home", "user", "project");
    const outside = abs("home", "user", "", "other", "", "src");
    expect(isInsideCwd(outside, base)).toBe(false);
  });
});

// ── safePath ────────────────────────────────────────────────────────────────

describe("safePath", () => {
  const cwd = abs("home", "user", "project");

  // -- within cwd ----

  it("returns resolved for relative child path", () => {
    const result = safePath("src/utils/path.ts", cwd);
    expect("resolved" in result).toBe(true);
    if ("resolved" in result) {
      expect(result.resolved).toBe(abs("home", "user", "project", "src", "utils", "path.ts"));
    }
  });

  it("returns resolved when target equals cwd", () => {
    const result = safePath(cwd, cwd);
    expect("resolved" in result).toBe(true);
  });

  it("returns resolved for dot", () => {
    const result = safePath(".", cwd);
    expect("resolved" in result).toBe(true);
    if ("resolved" in result) {
      expect(result.resolved).toBe(normalize(cwd));
    }
  });

  it("returns resolved for simple child", () => {
    const result = safePath("lib", cwd);
    expect("resolved" in result).toBe(true);
    if ("resolved" in result) {
      expect(result.resolved).toBe(abs("home", "user", "project", "lib"));
    }
  });

  // -- outside cwd ----

  it("returns error for absolute path outside cwd", () => {
    const result = safePath(abs("etc", "passwd"), cwd);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("outside allowed workdir");
    }
  });

  it("returns error for ../.. traversal outside cwd", () => {
    const result = safePath("../../", cwd);
    expect("error" in result).toBe(true);
  });

  it("returns error for sibling path outside cwd", () => {
    const result = safePath(abs("home", "user", "other-project", "src"), cwd);
    expect("error" in result).toBe(true);
  });

  it("returns error when prefix matches but not a directory boundary", () => {
    const result = safePath(abs("home", "userdata"), abs("home", "user"));
    expect("error" in result).toBe(true);
  });

  // -- allowedPaths ----

  it("returns resolved when outside cwd but inside allowedPath", () => {
    const allowed = abs("var", "log");
    const target = abs("var", "log", "app.log");
    const result = safePath(target, cwd, [allowed]);
    expect("resolved" in result).toBe(true);
  });

  it("returns resolved for relative child even with allowedPaths", () => {
    const result = safePath("error.log", cwd, [abs("var", "log")]);
    expect("resolved" in result).toBe(true);
    if ("resolved" in result) {
      expect(result.resolved).toBe(abs("home", "user", "project", "error.log"));
    }
  });

  it("returns resolved for absolute path inside allowedPath", () => {
    const result = safePath(abs("tmp", "cache", "data.json"), cwd, [abs("tmp", "cache")]);
    expect("resolved" in result).toBe(true);
  });

  it("returns error when outside both cwd and allowedPaths", () => {
    const result = safePath(abs("etc", "shadow"), cwd, [abs("var", "log"), abs("tmp", "cache")]);
    expect("error" in result).toBe(true);
  });

  it("supports multiple allowedPaths", () => {
    const result = safePath(
      abs("var", "www", "html", "index.html"),
      cwd,
      [abs("var", "log"), abs("var", "www"), abs("tmp", "cache")]
    );
    expect("resolved" in result).toBe(true);
  });

  it("returns error for non-boundary prefix match in allowedPaths", () => {
    const result = safePath(abs("var-log", "data"), cwd, [abs("var")]);
    expect("error" in result).toBe(true);
  });

  it("returns resolved when target equals allowedPath", () => {
    const result = safePath(abs("var", "log"), cwd, [abs("var", "log")]);
    expect("resolved" in result).toBe(true);
  });

  // -- .. traversal ----

  it("normalizes src/../lib staying inside cwd", () => {
    const result = safePath("src/../lib", cwd);
    expect("resolved" in result).toBe(true);
    if ("resolved" in result) {
      expect(result.resolved).toBe(abs("home", "user", "project", "lib"));
    }
  });

  it("returns error when .. escapes cwd", () => {
    const result = safePath("../../etc/passwd", cwd);
    expect("error" in result).toBe(true);
  });

  it("normalizes .. traversal inside allowedPath", () => {
    const result = safePath(abs("var", "log", "..", "cache", "data"), cwd, [abs("var", "cache")]);
    expect("resolved" in result).toBe(true);
    if ("resolved" in result) {
      expect(result.resolved).toBe(abs("var", "cache", "data"));
    }
  });

  it("returns error when .. escapes allowedPath", () => {
    const result = safePath(abs("var", "log", "..", ".."), cwd, [abs("var", "log")]);
    expect("error" in result).toBe(true);
  });

  it("handles complex traversal resolving inside cwd", () => {
    const result = safePath("src/../src/components/../../lib", cwd);
    expect("resolved" in result).toBe(true);
    if ("resolved" in result) {
      expect(result.resolved).toBe(abs("home", "user", "project", "lib"));
    }
  });

  // -- empty allowedPaths ----

  it("treats empty allowedPaths as no extra permissions", () => {
    const result = safePath(abs("var", "log", "app.log"), cwd);
    expect("error" in result).toBe(true);
  });

  it("passes within-cwd with empty allowedPaths", () => {
    const result = safePath("file.txt", cwd);
    expect("resolved" in result).toBe(true);
    if ("resolved" in result) {
      expect(result.resolved).toBe(abs("home", "user", "project", "file.txt"));
    }
  });

  // -- error message ----

  it("includes allowed workdir in error message", () => {
    const result = safePath(abs("secret", "token"), cwd);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("outside allowed workdir");
      expect(result.error).toContain(normalize(cwd));
    }
  });
});

// ── sanitizeCwd ─────────────────────────────────────────────────────────────

describe("sanitizeCwd", () => {
  it("replaces separators with underscores", () => {
    const input = isWin ? "\\home\\user\\project" : "/home/user/project";
    expect(sanitizeCwd(input)).toBe("home_user_project");
  });

  it("preserves dots, hyphens, alphanumeric", () => {
    const input = isWin ? "\\home\\user\\my-project.v2" : "/home/user/my-project.v2";
    expect(sanitizeCwd(input)).toBe("home_user_my-project.v2");
  });

  it("handles simple alphanumeric", () => {
    expect(sanitizeCwd("home")).toBe("home");
  });

  it("replaces separators in typical user paths", () => {
    const input = isWin ? "\\Users\\yang.zhou\\workspace\\open-vera" : "/Users/yang.zhou/workspace/open-vera";
    expect(sanitizeCwd(input)).toBe("Users_yang.zhou_workspace_open-vera");
  });

  it("replaces spaces with underscores", () => {
    const input = isWin ? "\\home\\user\\my project" : "/home/user/my project";
    expect(sanitizeCwd(input)).toBe("home_user_my_project");
  });

  it("replaces non-ASCII characters", () => {
    const input = isWin ? "\\home\\user\\项目\\开发" : "/home/user/项目/开发";
    expect(sanitizeCwd(input)).toBe("home_user");
  });

  it("replaces mixed special characters", () => {
    const input = isWin ? "\\home\\@user\\!test" : "/home/@user/!test";
    expect(sanitizeCwd(input)).toBe("home_user_test");
  });

  it("handles parens and spaces", () => {
    const input = isWin ? "\\home\\user\\My Project (v1)" : "/home/user/My Project (v1)";
    expect(sanitizeCwd(input)).toBe("home_user_My_Project_v1");
  });

  it("collapses consecutive special characters", () => {
    const input = isWin ? "\\home\\user\\$$$special$$$" : "/home/user/$$$special$$$";
    expect(sanitizeCwd(input)).toBe("home_user_special");
  });

  it("collapses mixed consecutive special chars", () => {
    const input = isWin ? "\\home\\user\\!@#hi" : "/home/user/!@#hi";
    expect(sanitizeCwd(input)).toBe("home_user_hi");
  });

  it("removes leading underscores", () => { expect(sanitizeCwd("!start")).toBe("start"); });
  it("removes trailing underscores", () => { expect(sanitizeCwd("end!")).toBe("end"); });
  it("removes both leading and trailing", () => { expect(sanitizeCwd("!both!")).toBe("both"); });
  it("keeps internal underscores", () => { expect(sanitizeCwd("!middle!chars")).toBe("middle_chars"); });
  it("handles parenthesized path", () => { expect(sanitizeCwd("hello(world)")).toBe("hello_world"); });
  it("returns empty for all-special", () => { expect(sanitizeCwd("!!!")).toBe(""); });
  it("returns empty for empty input", () => { expect(sanitizeCwd("")).toBe(""); });

  it("replaces separators only", () => {
    const input = isWin ? "\\a\\b\\c" : "/a/b/c";
    expect(sanitizeCwd(input)).toBe("a_b_c");
  });

  it("preserves existing underscores", () => {
    const input = isWin ? "\\home\\user_1\\my_file" : "/home/user_1/my_file";
    expect(sanitizeCwd(input)).toBe("home_user_1_my_file");
  });

  it("handles leading separator + special chars", () => {
    const input = isWin ? "\\!hello" : "/!hello";
    expect(sanitizeCwd(input)).toBe("hello");
  });

  it("handles trailing separator + special chars", () => {
    expect(sanitizeCwd("test!/")).toBe("test");
  });

  it("collapses across special chars and underscores", () => {
    expect(sanitizeCwd("a_!b")).toBe("a_b");
  });

  it("preserves leading dots and hyphens", () => {
    expect(sanitizeCwd(".hidden")).toBe(".hidden");
    expect(sanitizeCwd("-flag")).toBe("-flag");
  });
});
