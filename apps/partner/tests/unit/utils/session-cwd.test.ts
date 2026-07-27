import { describe, expect, it } from "vitest";
import { SETTINGS_TAB_ID } from "@/utils/partner-app-state";
import { resolveSessionCwd } from "@/utils/session-cwd";

const projects = [
  {
    id: "p1",
    rootPath: "/Users/me/workspace/pater",
    name: "pater",
    expanded: true,
    preview: { version: 1 as const, activeTabId: null, tabs: [] },
    updatedAt: 1,
  },
  {
    id: "p2",
    rootPath: "/Users/me/workspace/open-vera",
    name: "open-vera",
    expanded: true,
    preview: { version: 1 as const, activeTabId: null, tabs: [] },
    updatedAt: 2,
  },
];

const sessions = {
  s1: {
    id: "s1",
    projectId: "p1",
    title: "chat",
    messages: [],
    createdAt: 1,
    updatedAt: 2,
  },
  orphan: {
    id: "orphan",
    projectId: null,
    title: "orphan",
    messages: [],
    createdAt: 1,
    updatedAt: 2,
  },
  dangling: {
    id: "dangling",
    projectId: "missing",
    title: "dangling",
    messages: [],
    createdAt: 1,
    updatedAt: 2,
  },
};

describe("resolveSessionCwd", () => {
  it("uses active session project root and name", () => {
    expect(
      resolveSessionCwd({
        activeTabId: "s1",
        sessions,
        projects,
        workspaceRootPath: "/Users/me/workspace/open-vera",
      }),
    ).toEqual({ cwd: "/Users/me/workspace/pater", label: "pater" });
  });

  it("falls back to workspace root for orphan sessions", () => {
    expect(
      resolveSessionCwd({
        activeTabId: "orphan",
        sessions,
        projects,
        workspaceRootPath: "/Users/me/workspace/open-vera",
      }),
    ).toEqual({ cwd: "/Users/me/workspace/open-vera", label: "open-vera" });
  });

  it("falls back to workspace when project id is missing", () => {
    expect(
      resolveSessionCwd({
        activeTabId: "dangling",
        sessions,
        projects,
        workspaceRootPath: "/tmp/ws",
      }),
    ).toEqual({ cwd: "/tmp/ws", label: "ws" });
  });

  it("ignores settings tab and uses workspace fallback", () => {
    expect(
      resolveSessionCwd({
        activeTabId: SETTINGS_TAB_ID,
        sessions,
        projects,
        workspaceRootPath: "/Users/me/workspace/pater",
      }),
    ).toEqual({ cwd: "/Users/me/workspace/pater", label: "pater" });
  });

  it("returns empty cwd when nothing is available", () => {
    expect(
      resolveSessionCwd({
        activeTabId: null,
        sessions: {},
        projects: [],
        workspaceRootPath: "",
      }),
    ).toEqual({ cwd: "", label: "Terminal" });
  });
});
