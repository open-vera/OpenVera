import { describe, it, expect } from "vitest";
import { PromptStore } from "../src/prompt/store.js";
import { renderTemplate } from "../src/prompt/renderer.js";
import { loadTemplates } from "../src/prompt/loader.js";
import type {
  PromptTemplate,
  PromptProfile,
  PromptIntent,
} from "../src/prompt/types.js";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Test helpers ───────────────────────────────────────────────────────────────

function makeIntent(
  overrides?: Partial<PromptIntent>
): PromptIntent {
  return {
    domain: "chat",
    level: 0,
    needs_tools: false,
    ...overrides,
  };
}

// ── renderTemplate ─────────────────────────────────────────────────────────────

describe("renderTemplate", () => {
  const basicTemplate: PromptTemplate = {
    id: "test",
    name: "Test",
    description: "",
    version: 1,
    sections: [
      { name: "identity", content: "You are a test bot.", priority: 0 },
      {
        name: "code",
        content: "You write {{language}} code.",
        priority: 10,
        conditions: { domain: ["code"] },
      },
      {
        name: "tools",
        content: "Use tools wisely.",
        priority: 20,
        conditions: { needsTools: true },
      },
    ],
    variables: [{ name: "language", default: "TypeScript" }],
  };

  it("renders all unconditional sections", () => {
    const result = renderTemplate(basicTemplate, makeIntent());
    expect(result).toContain("You are a test bot.");
    expect(result).not.toContain("You write");
    expect(result).not.toContain("Use tools wisely.");
  });

  it("filters sections by domain condition", () => {
    const result = renderTemplate(
      basicTemplate,
      makeIntent({ domain: "code" })
    );
    expect(result).toContain("You are a test bot.");
    expect(result).toContain("TypeScript code");
  });

  it("filters sections by needsTools condition", () => {
    const result = renderTemplate(
      basicTemplate,
      makeIntent({ needs_tools: true })
    );
    expect(result).toContain("Use tools wisely.");
    expect(result).not.toContain("TypeScript");
  });

  it("sorts sections by priority", () => {
    const t: PromptTemplate = {
      id: "ordered",
      name: "Ordered",
      description: "",
      version: 1,
      sections: [
        { name: "c", content: "C", priority: 30 },
        { name: "a", content: "A", priority: 0 },
        { name: "b", content: "B", priority: 10 },
      ],
      variables: [],
    };
    const result = renderTemplate(t, makeIntent());
    const aIdx = result.indexOf("A");
    const bIdx = result.indexOf("B");
    const cIdx = result.indexOf("C");
    expect(aIdx).toBeLessThan(bIdx);
    expect(bIdx).toBeLessThan(cIdx);
  });

  it("substitutes variables with defaults", () => {
    const result = renderTemplate(
      basicTemplate,
      makeIntent({ domain: "code" })
    );
    expect(result).toContain("TypeScript code");
  });

  it("substitutes variables with overrides", () => {
    const result = renderTemplate(
      basicTemplate,
      makeIntent({ domain: "code" }),
      { language: "Python" }
    );
    expect(result).toContain("Python code");
  });

  it("keeps unknown placeholders as-is", () => {
    const t: PromptTemplate = {
      id: "unknown-var",
      name: "Unknown Var",
      description: "",
      version: 1,
      sections: [{ name: "x", content: "Hello {{missing}}", priority: 0 }],
      variables: [],
    };
    const result = renderTemplate(t, makeIntent());
    expect(result).toContain("Hello {{missing}}");
  });

  it("supports template inheritance via parent chain", () => {
    const parent: PromptTemplate = {
      id: "parent",
      name: "Parent",
      description: "",
      version: 1,
      sections: [
        { name: "base", content: "Base section.", priority: 0 },
        { name: "override-me", content: "Parent content.", priority: 5 },
      ],
      variables: [{ name: "x", default: "parent-x" }],
    };

    const child: PromptTemplate = {
      id: "child",
      name: "Child",
      description: "",
      version: 1,
      sections: [
        { name: "override-me", content: "Child content.", priority: 5 },
        { name: "extra", content: "Extra {{x}}.", priority: 10 },
      ],
      variables: [{ name: "y", default: "child-y" }],
      parent: "parent",
    };

    const templates = new Map<string, PromptTemplate>();
    templates.set("parent", parent);
    const result = renderTemplate(
      child,
      makeIntent(),
      undefined,
      (id) => templates.get(id)
    );

    expect(result).toContain("Base section.");
    expect(result).toContain("Child content.");
    expect(result).not.toContain("Parent content.");
    expect(result).toContain("Extra parent-x.");
  });
});

// ── PromptStore ────────────────────────────────────────────────────────────────

describe("PromptStore", () => {
  it("registers built-in templates on construction", () => {
    const store = new PromptStore();
    const templates = store.listTemplates();
    expect(templates.length).toBeGreaterThanOrEqual(5);
    expect(templates.find((t) => t.id === "general")).toBeDefined();
    expect(templates.find((t) => t.id === "code")).toBeDefined();
  });

  it("registers built-in profiles on construction", () => {
    const store = new PromptStore();
    const profiles = store.listProfiles();
    expect(profiles.length).toBeGreaterThanOrEqual(5);
    expect(profiles.find((p) => p.id === "general")).toBeDefined();
  });

  it("resolves general profile for chat intent by default", () => {
    const store = new PromptStore();
    const result = store.resolve(makeIntent());
    expect(result).not.toBeNull();
    expect(result!.profileId).toBe("general");
    expect(result!.system).toContain("Vera");
  });

  it("resolves code profile for code intent", () => {
    const store = new PromptStore();
    const result = store.resolve(
      makeIntent({ domain: "code", needs_tools: false })
    );
    expect(result).not.toBeNull();
    // code profile has 1 condition (domain) — with needs_tools=false it
    // beats debug which requires needs_tools=true (2 conditions)
    expect(result!.profileId).toBe("code");
    expect(result!.system).toContain("software engineer");
  });

  it("resolves planning profile for high-level analysis intent", () => {
    const store = new PromptStore();
    const result = store.resolve(
      makeIntent({ domain: "analysis", level: 3, needs_tools: false })
    );
    expect(result).not.toBeNull();
    expect(result!.profileId).toBe("planning");
    expect(result!.maxTurns).toBe(5);
  });

  it("explicit profile override takes precedence", () => {
    const store = new PromptStore();
    const result = store.resolve(makeIntent({ domain: "code" }), {
      profileId: "debug",
    });
    expect(result).not.toBeNull();
    expect(result!.profileId).toBe("debug");
    expect(result!.maxTurns).toBe(20);
  });

  it("falls back to general when no profile matches", () => {
    const store = new PromptStore();
    const result = store.resolve(
      makeIntent({ domain: "writing", level: 0, needs_tools: false })
    );
    expect(result).not.toBeNull();
    expect(result!.profileId).toBe("general");
  });

  it("returns RenderedPrompt with correct metadata", () => {
    const store = new PromptStore();
    const result = store.resolve(makeIntent());
    expect(result).not.toBeNull();
    expect(result!.templateId).toBeTruthy();
    expect(result!.templateVersion).toBeGreaterThan(0);
    expect(typeof result!.profileId).toBe("string");
    expect(typeof result!.system).toBe("string");
    expect(result!.system.length).toBeGreaterThan(0);
  });

  // ── Versioning ────────────────────────────────────────────────────────────

  it("stores and retrieves template versions", () => {
    const store = new PromptStore();
    const v1: PromptTemplate = {
      id: "versioned",
      name: "Versioned",
      description: "",
      version: 1,
      sections: [{ name: "s", content: "v1", priority: 0 }],
      variables: [],
    };
    const v2: PromptTemplate = {
      ...v1,
      version: 2,
      sections: [{ name: "s", content: "v2", priority: 0 }],
    };

    store.addTemplate(v1);
    store.addTemplate(v2);

    expect(store.getTemplate("versioned")?.version).toBe(2);
    expect(store.getTemplate("versioned", 1)?.version).toBe(1);
    expect(
      store.getTemplate("versioned")?.sections[0]?.content
    ).toBe("v2");
  });

  it("returns version history sorted newest first", () => {
    const store = new PromptStore();
    store.addTemplate({
      id: "hist",
      name: "Hist",
      description: "",
      version: 3,
      sections: [],
      variables: [],
    });
    store.addTemplate({
      id: "hist",
      name: "Hist",
      description: "",
      version: 1,
      sections: [],
      variables: [],
    });
    store.addTemplate({
      id: "hist",
      name: "Hist",
      description: "",
      version: 2,
      sections: [],
      variables: [],
    });

    const history = store.getVersionHistory("hist");
    expect(history).toEqual([3, 2, 1]);
  });

  it("diffVersions reports section changes", () => {
    const store = new PromptStore();
    store.addTemplate({
      id: "diff-test",
      name: "Diff",
      description: "",
      version: 1,
      sections: [{ name: "a", content: "A", priority: 0 }],
      variables: [],
    });
    store.addTemplate({
      id: "diff-test",
      name: "Diff",
      description: "",
      version: 2,
      sections: [
        { name: "a", content: "A-mod", priority: 0 },
        { name: "b", content: "B", priority: 10 },
      ],
      variables: [],
    });

    const diff = store.diffVersions("diff-test", 1, 2);
    expect(diff).toContain("+ sections: b");
  });

  // ── Custom profiles ───────────────────────────────────────────────────────

  it("allows adding custom profiles", () => {
    const store = new PromptStore();
    const custom: PromptProfile = {
      id: "custom",
      name: "Custom",
      description: "",
      templateId: "general",
      conditions: { domain: ["writing"] },
    };
    store.addProfile(custom);

    const result = store.resolve(
      makeIntent({ domain: "writing" })
    );
    expect(result).not.toBeNull();
    expect(result!.profileId).toBe("custom");
  });

  it("profile variable overrides are passed to template", () => {
    const store = new PromptStore();
    store.addProfile({
      id: "vars",
      name: "Vars",
      description: "",
      templateId: "code",
      variables: { workspace: "the test" },
      // No conditions — use explicit override to activate
    });

    const result = store.resolve(makeIntent({ domain: "code" }), {
      profileId: "vars",
    });
    expect(result).not.toBeNull();
    expect(result!.system).toContain("the test");
  });
});

// ── Loader ─────────────────────────────────────────────────────────────────────

describe("loadTemplates", () => {
  it("loads templates from a directory", () => {
    const store = new PromptStore();
    const dir = mkdtempSync(join(tmpdir(), "vera-prompt-test-"));
    const tmpl: PromptTemplate = {
      id: "from-disk",
      name: "From Disk",
      description: "",
      version: 1,
      sections: [{ name: "s", content: "loaded!", priority: 0 }],
      variables: [],
    };
    writeFileSync(join(dir, "test.json"), JSON.stringify(tmpl));

    const count = loadTemplates(store, dir);
    expect(count).toBe(1);
    expect(store.getTemplate("from-disk")).toBeDefined();

    rmSync(dir, { recursive: true, force: true });
  });

  it("loads profiles from profiles subdirectory", () => {
    const store = new PromptStore();
    const dir = mkdtempSync(join(tmpdir(), "vera-prompt-test-"));
    mkdirSync(join(dir, "profiles"), { recursive: true });

    const profile: PromptProfile = {
      id: "disk-profile",
      name: "Disk Profile",
      description: "",
      templateId: "general",
    };
    writeFileSync(
      join(dir, "profiles", "p.json"),
      JSON.stringify(profile)
    );

    const count = loadTemplates(store, dir);
    expect(count).toBe(1);
    expect(store.getProfile("disk-profile")).toBeDefined();

    rmSync(dir, { recursive: true, force: true });
  });

  it("returns 0 for non-existent directory", () => {
    const store = new PromptStore();
    const count = loadTemplates(store, "/nonexistent/path/12345");
    expect(count).toBe(0);
  });

  it("skips malformed JSON files", () => {
    const store = new PromptStore();
    const dir = mkdtempSync(join(tmpdir(), "vera-prompt-test-"));
    writeFileSync(join(dir, "bad.json"), "{ not valid json }");

    const count = loadTemplates(store, dir);
    expect(count).toBe(0);

    rmSync(dir, { recursive: true, force: true });
  });

  it("skips JSON that does not match template/profile shape", () => {
    const store = new PromptStore();
    const dir = mkdtempSync(join(tmpdir(), "vera-prompt-test-"));
    writeFileSync(
      join(dir, "wrong.json"),
      JSON.stringify({ foo: "bar" })
    );

    const count = loadTemplates(store, dir);
    expect(count).toBe(0);

    rmSync(dir, { recursive: true, force: true });
  });
});
