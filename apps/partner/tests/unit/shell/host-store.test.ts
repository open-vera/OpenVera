import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";
import { mergeHostPatch, useHostStore } from "@/shell/host-store";
import type { HostSession, HostState } from "@/shell/types";

function session(id: string): HostSession {
  return {
    id,
    projectId: null,
    title: `chat ${id}`,
    messages: [{ role: "user", content: "hi" }],
    createdAt: 1,
    updatedAt: 1,
  };
}

function sampleState(
  revision: number,
  overrides: Partial<HostState> = {},
): HostState {
  return {
    protocolVersion: 1,
    revision,
    version: 4,
    projects: [],
    sessions: {},
    openTabIds: [],
    activeTabId: null,
    previewProjectId: null,
    layout: {
      leftWidth: 240,
      previewWidth: 640,
      leftOpen: true,
      previewOpen: true,
      explorerOpen: true,
      editorOpen: true,
    },
    updatedAt: 1,
    projectRuntime: {},
    orchestrator: {
      runningSessionId: null,
      runningRequestId: null,
      queue: [],
      maxConcurrency: 1,
    },
    booted: true,
    sectionRevisions: { sessions: 0, projects: 0, projectRuntime: 0 },
    ...overrides,
  };
}

/** Patch document with the omittable sections stripped, as the Host sends it. */
function withoutSections(
  state: HostState,
  sections: Array<"sessions" | "projects" | "projectRuntime">,
) {
  const copy = { ...state } as Record<string, unknown>;
  for (const section of sections) delete copy[section];
  return copy as unknown as HostState;
}

describe("useHostStore projection", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("applies replace patches by revision", () => {
    const store = useHostStore();
    store.applyPatch({ replace: true, revision: 2, state: sampleState(2) });
    expect(store.doc.revision).toBe(2);
    store.applyPatch({ replace: true, revision: 1, state: sampleState(1) });
    // Older replace still applied when replace=true (full snapshot from host).
    expect(store.doc.revision).toBe(1);
  });

  it("ignores a stale non-replace patch", () => {
    const store = useHostStore();
    store.applyPatch({
      replace: true,
      revision: 5,
      state: sampleState(5, { sessions: { "s-1": session("s-1") } }),
    });
    store.applyPatch({
      replace: false,
      revision: 4,
      state: sampleState(4, { activeTabId: "s-9" }),
    });
    expect(store.doc.revision).toBe(5);
    expect(store.doc.activeTabId).toBeNull();
    expect(Object.keys(store.doc.sessions)).toEqual(["s-1"]);
  });

  it("carries omitted sessions forward instead of emptying them", () => {
    const store = useHostStore();
    const full = sampleState(1, {
      sessions: { "s-1": session("s-1"), "s-2": session("s-2") },
      projects: [
        {
          id: "p-1",
          rootPath: "/tmp/demo",
          name: "demo",
          expanded: true,
          preview: { version: 1, activeTabId: null, tabs: [] },
          updatedAt: 1,
        },
      ],
      sectionRevisions: { sessions: 3, projects: 2, projectRuntime: 1 },
    });
    store.applyPatch({ replace: true, revision: 1, state: full });

    const slim = sampleState(2, {
      activeTabId: "s-2",
      sectionRevisions: { sessions: 3, projects: 2, projectRuntime: 1 },
    });
    store.applyPatch({
      replace: true,
      revision: 2,
      omitted: ["sessions", "projects", "projectRuntime"],
      state: withoutSections(slim, ["sessions", "projects", "projectRuntime"]),
    });

    expect(store.doc.revision).toBe(2);
    expect(store.doc.activeTabId).toBe("s-2");
    expect(Object.keys(store.doc.sessions).sort()).toEqual(["s-1", "s-2"]);
    expect(store.doc.sessions["s-1"].messages).toHaveLength(1);
    expect(store.doc.projects).toHaveLength(1);
  });

  it("applies a present-but-empty section", () => {
    const store = useHostStore();
    store.applyPatch({
      replace: true,
      revision: 1,
      state: sampleState(1, { sessions: { "s-1": session("s-1") } }),
    });
    store.applyPatch({
      replace: true,
      revision: 2,
      omitted: ["projects", "projectRuntime"],
      state: withoutSections(sampleState(2, { sessions: {} }), [
        "projects",
        "projectRuntime",
      ]),
    });
    expect(store.doc.sessions).toEqual({});
  });

  it("keeps the activeSession getter working across an omitted patch", () => {
    const store = useHostStore();
    store.applyPatch({
      replace: true,
      revision: 1,
      state: sampleState(1, {
        sessions: { "s-1": session("s-1") },
        activeTabId: "s-1",
      }),
    });
    store.applyPatch({
      replace: true,
      revision: 2,
      omitted: ["sessions"],
      state: withoutSections(sampleState(2, { activeTabId: "s-1" }), [
        "sessions",
      ]),
    });
    expect(store.activeSession?.id).toBe("s-1");
  });
});

describe("mergeHostPatch", () => {
  it("prefers the current doc for a section listed as omitted", () => {
    const current = sampleState(1, { sessions: { "s-1": session("s-1") } });
    const merged = mergeHostPatch(current, {
      replace: true,
      revision: 2,
      omitted: ["sessions"],
      // A stray value under an omitted key is a protocol slip: ignore it.
      state: sampleState(2, { sessions: {} }),
    });
    expect(Object.keys(merged.sessions)).toEqual(["s-1"]);
    expect(merged.revision).toBe(2);
  });

  it("falls back to the empty shape when nothing can be carried forward", () => {
    const current = { ...sampleState(1) } as unknown as Record<string, unknown>;
    delete current.sessions;
    const merged = mergeHostPatch(current as unknown as HostState, {
      replace: true,
      revision: 2,
      omitted: ["sessions"],
      state: withoutSections(sampleState(2), ["sessions"]),
    });
    expect(merged.sessions).toEqual({});
  });

  it("carries a section forward when it is absent without being listed", () => {
    const current = sampleState(1, { sessions: { "s-1": session("s-1") } });
    const merged = mergeHostPatch(current, {
      replace: true,
      revision: 2,
      state: withoutSections(sampleState(2), ["sessions"]),
    });
    expect(Object.keys(merged.sessions)).toEqual(["s-1"]);
  });

  it("leaves the current doc untouched", () => {
    const current = sampleState(1, { sessions: { "s-1": session("s-1") } });
    mergeHostPatch(current, {
      replace: true,
      revision: 2,
      omitted: ["sessions"],
      state: withoutSections(sampleState(2, { activeTabId: "s-1" }), [
        "sessions",
      ]),
    });
    expect(current.revision).toBe(1);
    expect(current.activeTabId).toBeNull();
  });

  it("tracks the section revisions the Host reports", () => {
    const current = sampleState(1);
    const merged = mergeHostPatch(current, {
      replace: true,
      revision: 2,
      omitted: ["projects", "projectRuntime"],
      state: withoutSections(
        sampleState(2, {
          sessions: { "s-1": session("s-1") },
          sectionRevisions: { sessions: 1, projects: 0, projectRuntime: 0 },
        }),
        ["projects", "projectRuntime"],
      ),
    });
    expect(merged.sectionRevisions).toEqual({
      sessions: 1,
      projects: 0,
      projectRuntime: 0,
    });
  });
});
