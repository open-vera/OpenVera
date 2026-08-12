import { describe, expect, it } from "vitest";
import {
  createEmptyPartnerAppState,
  listOrphanSessions,
  listProjectSessions,
  mergeLegacyIntoPartnerAppState,
  migrateLegacyToPartnerAppState,
  normalizePartnerAppState,
  projectIdFromRootPath,
  rebaseHostOwnedTabState,
  projectNameFromRootPath,
  resolvePartnerAppState,
  SETTINGS_TAB_ID,
} from "@/utils/partner-app-state";

describe("partner-app-state", () => {
  it("derives stable project ids and names from root paths", () => {
    expect(projectNameFromRootPath("/Users/me/workspace/PROXY-X-FE")).toBe("PROXY-X-FE");
    expect(projectIdFromRootPath("/a/b")).toBe(projectIdFromRootPath("/a/b/"));
    expect(projectIdFromRootPath("/a/b")).not.toBe(projectIdFromRootPath("/a/c"));
  });

  it("normalizes v4 payloads and drops dangling project refs", () => {
    const normalized = normalizePartnerAppState({
      version: 4,
      projects: [{ id: "p1", rootPath: "/repo", name: "repo", expanded: true, preview: { version: 1, activeTabId: null, tabs: [] }, updatedAt: 1 }],
      sessions: {
        s1: {
          id: "s1",
          projectId: "missing",
          title: "orphanized",
          messages: [],
          createdAt: 1,
          updatedAt: 2,
        },
        s2: {
          id: "s2",
          projectId: "p1",
          title: "kept",
          messages: [{ id: "m1", role: "user", content: "hi", timestamp: 1 }],
          createdAt: 1,
          updatedAt: 3,
        },
      },
      openTabIds: ["s2", "ghost", SETTINGS_TAB_ID],
      activeTabId: "s2",
      previewProjectId: "p1",
      layout: { leftWidth: 200, previewWidth: 400 },
      updatedAt: 9,
    });

    expect(normalized.sessions.s1.projectId).toBeNull();
    expect(normalized.sessions.s2.projectId).toBe("p1");
    expect(normalized.openTabIds).toEqual(["s2", SETTINGS_TAB_ID]);
    expect(listOrphanSessions(normalized).map((s) => s.id)).toEqual(["s1"]);
    expect(listProjectSessions(normalized, "p1").map((s) => s.id)).toEqual(["s2"]);
  });

  it("lists project sessions with newest createdAt first when updatedAt ties", () => {
    const state = createEmptyPartnerAppState();
    state.projects.push({
      id: "p1",
      rootPath: "/repo",
      name: "repo",
      expanded: true,
      preview: { version: 1, activeTabId: null, tabs: [] },
      updatedAt: 1,
    });
    state.sessions = {
      old: {
        id: "old",
        projectId: "p1",
        title: "对话 1",
        messages: [],
        createdAt: 10,
        updatedAt: 100,
      },
      newer: {
        id: "newer",
        projectId: "p1",
        title: "对话 6",
        messages: [],
        createdAt: 20,
        updatedAt: 100,
      },
    };

    expect(listProjectSessions(state, "p1").map((s) => s.id)).toEqual(["newer", "old"]);
  });

  it("migrates legacy partner-sessions into project-scoped sessions", () => {
    const migrated = migrateLegacyToPartnerAppState({
      rootPath: "/Users/me/proj",
      windowId: "main",
      legacySessions: {
        version: 3,
        activeWindowId: "main",
        windows: {
          main: {
            windowId: "main",
            chat: {
              version: 1,
              activeTabId: "chat:1",
              tabs: [
                {
                  id: "chat:1",
                  title: "对话 1",
                  kind: "chat",
                  messages: [{ id: "m1", role: "user", content: "hello", timestamp: 10 }],
                  isAgentRunning: false,
                  currentTokenCount: 0,
                  estimatedCost: 0,
                },
                {
                  id: "settings",
                  title: "设置",
                  kind: "settings",
                  messages: [],
                  isAgentRunning: false,
                  currentTokenCount: 0,
                  estimatedCost: 0,
                },
              ],
            },
            preview: {
              version: 1,
              activeTabId: "code:/Users/me/proj/a.ts",
              tabs: [
                {
                  id: "code:/Users/me/proj/a.ts",
                  title: "a.ts",
                  kind: "code",
                  source: "disk",
                  filePath: "/Users/me/proj/a.ts",
                },
              ],
            },
            layout: { leftWidth: 260, previewWidth: 480 },
            updatedAt: 100,
          },
        },
        tasks: {
          t1: {
            taskId: "t1",
            windowId: "main",
            chatTabId: "chat:1",
            title: "历史任务",
            previewText: "done",
            chat: {
              version: 1,
              activeTabId: "chat:1",
              tabs: [
                {
                  id: "chat:1",
                  title: "对话 1",
                  kind: "chat",
                  messages: [{ id: "m2", role: "assistant", content: "ok", timestamp: 11 }],
                  isAgentRunning: false,
                  currentTokenCount: 0,
                  estimatedCost: 0,
                },
              ],
            },
            preview: { version: 1, activeTabId: null, tabs: [] },
            createdAt: 50,
            updatedAt: 90,
          },
        },
      },
    });

    expect(migrated.version).toBe(4);
    expect(migrated.projects).toHaveLength(1);
    expect(migrated.projects[0].rootPath).toBe("/Users/me/proj");
    expect(migrated.projects[0].preview.tabs).toHaveLength(1);
    expect(migrated.sessions["chat:1"]?.title).toBe("对话 1");
    expect(migrated.sessions["chat:1"]?.projectId).toBe(migrated.projects[0].id);
    expect(migrated.sessions["task:t1"]?.title).toBe("历史任务");
    expect(migrated.openTabIds).toContain("chat:1");
    expect(migrated.openTabIds).toContain(SETTINGS_TAB_ID);
    expect(migrated.activeTabId).toBe("chat:1");
    expect(migrated.layout.leftWidth).toBe(260);
  });

  it("keeps stored v4 projects when legacy payload is empty", () => {
    const stored = createEmptyPartnerAppState();
    stored.projects.push({
      id: "p-existing",
      rootPath: "/already",
      name: "already",
      expanded: true,
      preview: { version: 1, activeTabId: null, tabs: [] },
      updatedAt: 1,
    });
    const resolved = resolvePartnerAppState({
      stored,
      legacy: {
        rootPath: "/other",
        legacySessions: null,
      },
    });
    expect(resolved.projects[0]?.id).toBe("p-existing");
  });

  it("merges legacy history into an empty v4 app-state", () => {
    const stored = createEmptyPartnerAppState();
    stored.sessions = {
      placeholder: {
        id: "placeholder",
        projectId: null,
        title: "对话 1",
        messages: [],
        createdAt: 1,
        updatedAt: 2,
      },
    };
    stored.openTabIds = ["placeholder"];
    stored.activeTabId = "placeholder";

    const resolved = resolvePartnerAppState({
      stored,
      legacy: {
        rootPath: "/Users/me/proj",
        windowId: "main",
        legacySessions: {
          version: 3,
          activeWindowId: "main",
          windows: {
            main: {
              windowId: "main",
              chat: {
                version: 1,
                activeTabId: "chat:hi",
                tabs: [
                  {
                    id: "chat:hi",
                    title: "hi",
                    kind: "chat",
                    messages: [
                      { id: "m1", role: "user", content: "hello history", timestamp: 10 },
                    ],
                    isAgentRunning: false,
                    currentTokenCount: 0,
                    estimatedCost: 0,
                  },
                ],
              },
              preview: { version: 1, activeTabId: null, tabs: [] },
              layout: { leftWidth: 240, previewWidth: 640 },
              updatedAt: 100,
            },
          },
          tasks: {},
        },
      },
    });

    expect(resolved.projects).toHaveLength(1);
    expect(resolved.sessions["chat:hi"]?.messages).toHaveLength(1);
    expect(resolved.sessions.placeholder).toBeUndefined();
    expect(resolved.openTabIds).toContain("chat:hi");
    expect(resolved.activeTabId).toBe("chat:hi");
  });

  it("mergeLegacyIntoPartnerAppState is idempotent for already-migrated sessions", () => {
    const once = mergeLegacyIntoPartnerAppState(createEmptyPartnerAppState(), {
      rootPath: "/repo",
      legacySessions: {
        version: 3,
        activeWindowId: "main",
        windows: {
          main: {
            windowId: "main",
            chat: {
              version: 1,
              activeTabId: "s1",
              tabs: [
                {
                  id: "s1",
                  title: "A",
                  kind: "chat",
                  messages: [{ id: "m1", role: "user", content: "x", timestamp: 1 }],
                  isAgentRunning: false,
                  currentTokenCount: 0,
                  estimatedCost: 0,
                },
              ],
            },
            preview: { version: 1, activeTabId: null, tabs: [] },
            layout: { leftWidth: 240, previewWidth: 640 },
            updatedAt: 1,
          },
        },
        tasks: {},
      },
    });
    const twice = mergeLegacyIntoPartnerAppState(once, {
      rootPath: "/repo",
      legacySessions: {
        version: 3,
        activeWindowId: "main",
        windows: {
          main: {
            windowId: "main",
            chat: {
              version: 1,
              activeTabId: "s1",
              tabs: [
                {
                  id: "s1",
                  title: "A",
                  kind: "chat",
                  messages: [{ id: "m1", role: "user", content: "x", timestamp: 1 }],
                  isAgentRunning: false,
                  currentTokenCount: 0,
                  estimatedCost: 0,
                },
              ],
            },
            preview: { version: 1, activeTabId: null, tabs: [] },
            layout: { leftWidth: 240, previewWidth: 640 },
            updatedAt: 1,
          },
        },
        tasks: {},
      },
    });
    expect(Object.keys(twice.sessions)).toEqual(Object.keys(once.sessions));
    expect(twice.sessions.s1?.messages).toHaveLength(1);
  });

  describe("previewProjectId normalization", () => {
    function stateWith(previewProjectId: unknown) {
      return {
        version: 4,
        projects: [
          {
            id: "p1",
            rootPath: "/repo/one",
            name: "one",
            expanded: true,
            preview: { version: 1, activeTabId: null, tabs: [] },
            updatedAt: 1,
          },
        ],
        sessions: {},
        openTabIds: [],
        activeTabId: null,
        previewProjectId,
        layout: { leftWidth: 240, previewWidth: 640 },
        updatedAt: 1,
      };
    }

    it("keeps an explicit null instead of inventing a project", () => {
      expect(normalizePartnerAppState(stateWith(null)).previewProjectId).toBeNull();
    });

    it("falls back to the first project for a missing or unknown value", () => {
      expect(normalizePartnerAppState(stateWith(undefined)).previewProjectId).toBe("p1");
      expect(normalizePartnerAppState(stateWith("ghost")).previewProjectId).toBe("p1");
    });
  });

  describe("rebaseHostOwnedTabState", () => {
    function local() {
      const state = createEmptyPartnerAppState();
      state.openTabIds = ["a", "b"];
      state.activeTabId = "a";
      state.previewProjectId = "p-local";
      return state;
    }

    it("takes the Host active tab and preview project", () => {
      const rebased = rebaseHostOwnedTabState(local(), {
        openTabIds: ["a", "b"],
        activeTabId: "b",
        previewProjectId: "p-host",
      });
      expect(rebased.activeTabId).toBe("b");
      expect(rebased.previewProjectId).toBe("p-host");
    });

    it("appends tabs the Host has not seen yet instead of dropping them", () => {
      const state = local();
      state.openTabIds = ["a", "b", "fresh"];
      const rebased = rebaseHostOwnedTabState(state, {
        openTabIds: ["b", "a"],
        activeTabId: "a",
        previewProjectId: null,
      });
      expect(rebased.openTabIds).toEqual(["b", "a", "fresh"]);
    });

    it("keeps the local active tab when the Host points at a closed one", () => {
      const rebased = rebaseHostOwnedTabState(local(), {
        openTabIds: ["a", "b"],
        activeTabId: "gone",
        previewProjectId: null,
      });
      expect(rebased.activeTabId).toBe("a");
    });

    it("falls back to the first open tab when neither side has a valid one", () => {
      const state = local();
      state.activeTabId = null;
      const rebased = rebaseHostOwnedTabState(state, {
        openTabIds: ["a", "b"],
        activeTabId: null,
        previewProjectId: null,
      });
      expect(rebased.activeTabId).toBe("a");
    });
  });
});
