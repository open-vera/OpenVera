import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";
import { useHostStore } from "@/shell/host-store";
import type { HostState } from "@/shell/types";

function sampleState(revision: number): HostState {
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
  };
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
});
