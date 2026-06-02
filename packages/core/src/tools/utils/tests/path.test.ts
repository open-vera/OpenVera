import { describe, expect, it } from "vitest";
import { isInsideCwd, safePath, sanitizeCwd } from "../path.js";

// ── isInsideCwd ─────────────────────────────────────────────────────────────

describe("isInsideCwd", () => {
  // -- same / child / parent / sibling ---------------------------------------

  it("returns true for target equal to baseDir (same directory)", () => {
    const baseDir = "/home/user/project";
    expect(isInsideCwd("/home/user/project", baseDir)).toBe(true);
  });

  it("returns true for target equal to baseDir with trailing slash on base", () => {
    const baseDir = "/home/user/project/";
    expect(isInsideCwd("/home/user/project", baseDir)).toBe(true);
  });

  it("returns true for target equal to baseDir with trailing slash on target", () => {
    const baseDir = "/home/user/project";
    expect(isInsideCwd("/home/user/project/", baseDir)).toBe(true);
  });

  it("returns true for child directory", () => {
    const baseDir = "/home/user/project";
    expect(isInsideCwd("/home/user/project/src", baseDir)).toBe(true);
  });

  it("returns true for deeply nested child directory", () => {
    const baseDir = "/home/user/project";
    expect(isInsideCwd("/home/user/project/src/components/ui", baseDir)).toBe(true);
  });

  it("returns false for parent directory", () => {
    const baseDir = "/home/user/project";
    expect(isInsideCwd("/home/user", baseDir)).toBe(false);
  });

  it("returns false for sibling directory", () => {
    const baseDir = "/home/user/project";
    expect(isInsideCwd("/home/user/other-project", baseDir)).toBe(false);
  });

  it("returns false for completely unrelated absolute path", () => {
    const baseDir = "/home/user/project";
    expect(isInsideCwd("/etc/passwd", baseDir)).toBe(false);
  });

  it("returns false when prefix matches but is not a directory boundary", () => {
    // /home/user/project vs /home/user/project-backup — should NOT be "inside"
    const baseDir = "/home/user/project";
    expect(isInsideCwd("/home/user/project-backup", baseDir)).toBe(false);
  });

  // -- relative paths --------------------------------------------------------

  it("resolves relative child path against baseDir", () => {
    const baseDir = "/home/user/project";
    expect(isInsideCwd("src", baseDir)).toBe(true);
    expect(isInsideCwd("src/index.ts", baseDir)).toBe(true);
  });

  it("returns false for parent traversal that goes to parent of baseDir", () => {
    const baseDir = "/home/user/project/src";
    // ../ resolves to /home/user/project, which is the parent of baseDir — outside
    expect(isInsideCwd("../", baseDir)).toBe(false);
  });

  it("resolves relative parent traversal that goes outside cwd", () => {
    const baseDir = "/home/user/project";
    // ../ goes to /home/user, which is outside
    expect(isInsideCwd("../", baseDir)).toBe(false);
  });

  it("handles dot (current directory) as inside", () => {
    const baseDir = "/home/user/project";
    expect(isInsideCwd(".", baseDir)).toBe(true);
  });

  it("returns false for parent + child traversal that resolves to parent of baseDir", () => {
    const baseDir = "/home/user/project/src";
    // ../lib resolves to /home/user/project/lib — still outside baseDir /home/user/project/src
    expect(isInsideCwd("../lib", baseDir)).toBe(false);
  });

  it("returns true for parent + child traversal that stays inside a broader cwd", () => {
    const baseDir = "/home/user/project";
    // src/../lib resolves to /home/user/project/lib — inside baseDir
    expect(isInsideCwd("src/../lib", baseDir)).toBe(true);
  });

  // -- absolute paths with unusual forms -------------------------------------

  it("handles absolute target already within baseDir", () => {
    const baseDir = "/home/user/project";
    expect(isInsideCwd("/home/user/project/src/main.ts", baseDir)).toBe(true);
  });

  it("handles absolute target outside baseDir", () => {
    const baseDir = "/home/user/project";
    expect(isInsideCwd("/var/log", baseDir)).toBe(false);
  });

  // -- platform-independent normalization ------------------------------------

  it("normalizes redundant separators in target", () => {
    const baseDir = "/home/user/project";
    expect(isInsideCwd("/home/user/project//src//index.ts", baseDir)).toBe(true);
  });

  it("normalizes redundant separators keeping outside path outside", () => {
    const baseDir = "/home/user/project";
    expect(isInsideCwd("/home/user//other//src", baseDir)).toBe(false);
  });
});

// ── safePath ────────────────────────────────────────────────────────────────

describe("safePath", () => {
  const cwd = "/home/user/project";

  // -- within cwd ------------------------------------------------------------

  it("returns resolved path when target is inside cwd", () => {
    const result = safePath("src/utils/path.ts", cwd);
    expect("resolved" in result).toBe(true);
    if ("resolved" in result) {
      expect(result.resolved).toBe("/home/user/project/src/utils/path.ts");
    }
  });

  it("returns resolved when target equals cwd", () => {
    const result = safePath("/home/user/project", cwd);
    expect("resolved" in result).toBe(true);
    if ("resolved" in result) {
      expect(result.resolved).toBe("/home/user/project");
    }
  });

  it("returns resolved for dot (current directory)", () => {
    const result = safePath(".", cwd);
    expect("resolved" in result).toBe(true);
    if ("resolved" in result) {
      expect(result.resolved).toBe(cwd);
    }
  });

  it("returns resolved for relative child path", () => {
    const result = safePath("lib", cwd);
    expect("resolved" in result).toBe(true);
    if ("resolved" in result) {
      expect(result.resolved).toBe("/home/user/project/lib");
    }
  });

  // -- outside cwd -----------------------------------------------------------

  it("returns error when target is outside cwd", () => {
    const result = safePath("/etc/passwd", cwd);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("outside allowed workdir");
      expect(result.error).toContain("/home/user/project");
      expect(result.error).toContain("/etc/passwd");
    }
  });

  it("returns error for parent directory traversal outside cwd", () => {
    const result = safePath("../../", cwd);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("outside allowed workdir");
    }
  });

  it("returns error for sibling path outside cwd", () => {
    const result = safePath("/home/user/other-project/src", cwd);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("outside allowed workdir");
    }
  });

  it("returns error when prefix matches but is not a directory boundary", () => {
    // /home/user vs /home/userdata — not inside because no trailing separator boundary
    const result = safePath("/home/userdata", "/home/user");
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("outside allowed workdir");
    }
  });

  // -- allowedPaths ----------------------------------------------------------

  it("returns resolved when outside cwd but inside one allowedPath", () => {
    const result = safePath("/var/log/app.log", cwd, ["/var/log"]);
    expect("resolved" in result).toBe(true);
    if ("resolved" in result) {
      expect(result.resolved).toBe("/var/log/app.log");
    }
  });

  it("returns resolved when outside cwd but inside allowedPath as relative child", () => {
    const result = safePath("error.log", cwd, ["/var/log"]);
    // error.log resolved against cwd is /home/user/project/error.log — not inside /var/log
    // It IS inside cwd, so resolved should succeed
    expect("resolved" in result).toBe(true);
    if ("resolved" in result) {
      expect(result.resolved).toBe("/home/user/project/error.log");
    }
  });

  it("returns resolved for absolute path inside allowedPath", () => {
    const result = safePath("/tmp/cache/data.json", cwd, ["/tmp/cache"]);
    expect("resolved" in result).toBe(true);
    if ("resolved" in result) {
      expect(result.resolved).toBe("/tmp/cache/data.json");
    }
  });

  it("returns error when target is outside both cwd and allowedPaths", () => {
    const result = safePath("/etc/shadow", cwd, ["/var/log", "/tmp/cache"]);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("outside allowed workdir");
    }
  });

  it("supports multiple allowedPaths and uses the matching one", () => {
    const result = safePath("/var/www/html/index.html", cwd, [
      "/var/log",
      "/var/www",
      "/tmp/cache",
    ]);
    expect("resolved" in result).toBe(true);
    if ("resolved" in result) {
      expect(result.resolved).toBe("/var/www/html/index.html");
    }
  });

  it("returns error when target is child of allowedPath but that path is not a directory boundary", () => {
    // /var vs /var-log — should NOT match
    const result = safePath("/var-log/data", cwd, ["/var"]);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("outside allowed workdir");
    }
  });

  it("returns resolved when target equals an allowedPath", () => {
    const result = safePath("/var/log", cwd, ["/var/log"]);
    expect("resolved" in result).toBe(true);
    if ("resolved" in result) {
      expect(result.resolved).toBe("/var/log");
    }
  });

  // -- normalized paths (.. traversal handling) ------------------------------

  it("normalizes path with .. traversal that stays inside cwd", () => {
    const result = safePath("src/../lib", cwd);
    expect("resolved" in result).toBe(true);
    if ("resolved" in result) {
      expect(result.resolved).toBe("/home/user/project/lib");
    }
  });

  it("returns error when .. traversal escapes cwd", () => {
    const result = safePath("../../etc/passwd", cwd);
    expect("error" in result).toBe(true);
  });

  it("normalizes path using allowedPath with .. traversal still inside allowedPath", () => {
    const result = safePath("/var/log/../cache/data", cwd, ["/var/cache"]);
    expect("resolved" in result).toBe(true);
    if ("resolved" in result) {
      expect(result.resolved).toBe("/var/cache/data");
    }
  });

  it("returns error when .. traversal escapes allowedPath", () => {
    const result = safePath("/var/log/../..", cwd, ["/var/log"]);
    expect("error" in result).toBe(true);
  });

  it("handles complex traversal that resolves inside cwd", () => {
    const result = safePath("src/../src/components/../../lib", cwd);
    expect("resolved" in result).toBe(true);
    if ("resolved" in result) {
      expect(result.resolved).toBe("/home/user/project/lib");
    }
  });

  // -- empty allowedPaths (default parameter) --------------------------------

  it("treats empty allowedPaths as no extra permissions", () => {
    const result = safePath("/var/log/app.log", cwd);
    expect("error" in result).toBe(true);
  });

  it("passes within-cwd test with empty allowedPaths", () => {
    const result = safePath("file.txt", cwd);
    expect("resolved" in result).toBe(true);
    if ("resolved" in result) {
      expect(result.resolved).toBe("/home/user/project/file.txt");
    }
  });

  // -- error message format --------------------------------------------------

  it("includes allowed workdir and got path in error message", () => {
    const result = safePath("/secret/token", cwd);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("outside allowed workdir");
      expect(result.error).toContain(cwd);
      expect(result.error).toContain("/secret/token");
    }
  });
});

// ── sanitizeCwd ─────────────────────────────────────────────────────────────

describe("sanitizeCwd", () => {
  // -- normal paths ----------------------------------------------------------

  it("replaces path separators with underscores (for filename-safe output)", () => {
    expect(sanitizeCwd("/home/user/project")).toBe("home_user_project");
  });

  it("preserves dots, hyphens, and alphanumeric but replaces separators", () => {
    expect(sanitizeCwd("/home/user/my-project.v2")).toBe(
      "home_user_my-project.v2"
    );
  });

  it("handles simple alphanumeric path", () => {
    expect(sanitizeCwd("home")).toBe("home");
  });

  it("replaces separators in typical user paths", () => {
    expect(sanitizeCwd("/Users/yang.zhou/workspace/open-vera")).toBe(
      "Users_yang.zhou_workspace_open-vera"
    );
  });

  // -- special characters ----------------------------------------------------

  it("replaces spaces with underscores", () => {
    expect(sanitizeCwd("/home/user/my project")).toBe(
      "home_user_my_project"
    );
  });

  it("replaces special characters (including separators) with underscores", () => {
    expect(sanitizeCwd("/home/user/项目/开发")).toBe("home_user");
  });

  it("replaces mixed special characters with underscores", () => {
    expect(sanitizeCwd("/home/@user/!test")).toBe("home_user_test");
  });

  it("replaces path-legal but non-alphanumeric chars (spaces, parens, separators)", () => {
    expect(sanitizeCwd("/home/user/My Project (v1)")).toBe(
      "home_user_My_Project_v1"
    );
  });

  // -- consecutive special chars ---------------------------------------------

  it("collapses consecutive special characters into single underscore", () => {
    expect(sanitizeCwd("/home/user/$$$special$$$")).toBe(
      "home_user_special"
    );
  });

  it("collapses mixed consecutive special chars", () => {
    expect(sanitizeCwd("/home/user/!@#hi")).toBe("home_user_hi");
  });

  // -- leading / trailing special chars --------------------------------------

  it("removes leading underscores from sanitized result", () => {
    expect(sanitizeCwd("!start")).toBe("start");
  });

  it("removes trailing underscores from sanitized result", () => {
    expect(sanitizeCwd("end!")).toBe("end");
  });

  it("removes both leading and trailing underscores", () => {
    expect(sanitizeCwd("!both!")).toBe("both");
  });

  it("removes leading underscore but keeps internal underscores", () => {
    expect(sanitizeCwd("!middle!chars")).toBe("middle_chars");
  });

  it("removes trailing underscore from parenthesized path", () => {
    expect(sanitizeCwd("hello(world)")).toBe("hello_world");
  });

  // -- edge cases ------------------------------------------------------------

  it("returns empty string for all-special-char input", () => {
    expect(sanitizeCwd("!!!")).toBe("");
  });

  it("returns empty string for empty input", () => {
    expect(sanitizeCwd("")).toBe("");
  });

  it("replaces path separators with underscores", () => {
    expect(sanitizeCwd("/a/b/c")).toBe("a_b_c");
  });

  it("preserves underscores already present but separators still replaced", () => {
    expect(sanitizeCwd("/home/user_1/my_file")).toBe("home_user_1_my_file");
  });

  it("handles leading slash followed by special chars correctly", () => {
    // /!hello → __hello → _hello → hello
    expect(sanitizeCwd("/!hello")).toBe("hello");
  });

  it("handles trailing slash followed by special chars", () => {
    // test!/ → test__ → test_ → test
    expect(sanitizeCwd("test!/")).toBe("test");
  });

  it("collapses underscores across special chars and existing underscores", () => {
    expect(sanitizeCwd("a_!b")).toBe("a_b");
  });

  it("does not double-leading/trailing strip characters that are not underscores", () => {
    // dots and hyphens at edges should be preserved
    expect(sanitizeCwd(".hidden")).toBe(".hidden");
    expect(sanitizeCwd("-flag")).toBe("-flag");
  });
});
