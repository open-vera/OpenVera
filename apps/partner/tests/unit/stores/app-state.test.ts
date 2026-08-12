import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { Message } from "@/types";

const hostCommand = vi.fn(async (_cmd: { op: string } & Record<string, unknown>) => undefined);
const hostBoot = vi.fn(async () => undefined);
const hostCreateSession = vi.fn(async () => ({ sessionId: "host-session" }));
const hostOpenWorkspace = vi.fn(async () => ({ projectId: "p-host" }));

function emptyHostDoc() {
  return {
    protocolVersion: 1,
    revision: 1,
    version: 4,
    projects: [] as unknown[],
    sessions: {} as Record<string, unknown>,
    openTabIds: [] as string[],
    activeTabId: null as string | null,
    previewProjectId: null as string | null,
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

let hostDoc = emptyHostDoc();

vi.mock("@/shell", () => ({
  useHostStore: () => ({
    booted: true,
    boot: hostBoot,
    command: hostCommand,
    createSession: hostCreateSession,
    openWorkspace: hostOpenWorkspace,
    get doc() {
      return hostDoc;
    },
  }),
}));

function session(id: string, projectId: string | null = null) {
  return {
    id,
    projectId,
    title: id,
    messages: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

function project(id: string) {
  return {
    id,
    rootPath: `/repo/${id}`,
    name: id,
    expanded: true,
    preview: { version: 1, activeTabId: null, tabs: [] },
    updatedAt: 1,
  };
}

async function makeStore() {
  const { useAppStateStore } = await import("@/stores/app-state");
  const store = useAppStateStore();
  store.isLoaded = true;
  return store;
}

function opsSent(): string[] {
  return hostCommand.mock.calls.map((call) => call[0].op);
}

function message(id: string, content: string): Message {
  return { id, role: "assistant", content, timestamp: 1 };
}

function lastCommand(): Record<string, unknown> {
  return hostCommand.mock.calls.at(-1)?.[0] as Record<string, unknown>;
}

describe("app-state host projection", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    hostDoc = emptyHostDoc();
    hostCommand.mockClear();
    hostBoot.mockClear();
    hostCreateSession.mockClear();
    hostOpenWorkspace.mockClear();
  });

  it("loads by syncing from host", async () => {
    const { useAppStateStore } = await import("@/stores/app-state");
    const store = useAppStateStore();
    await store.load();
    expect(store.isLoaded).toBe(true);
    expect(store.doc.version).toBe(4);
  });

  it("persists via host.app.replace_state", async () => {
    const store = await makeStore();
    await store.persist();
    expect(hostCommand).toHaveBeenCalledWith(
      expect.objectContaining({ op: "host.app.replace_state" }),
    );
  });

  it("never ships a tab regression in the outgoing document", async () => {
    const store = await makeStore();
    store.doc.sessions = { a: session("a"), b: session("b") };
    store.doc.openTabIds = ["a", "b"];
    store.doc.activeTabId = "a";
    // Host activated "b" after this Shell snapshot was taken.
    hostDoc.sessions = { a: session("a"), b: session("b") };
    hostDoc.openTabIds = ["a", "b"];
    hostDoc.activeTabId = "b";

    await store.persist();

    const document = hostCommand.mock.calls.at(-1)?.[0].document as {
      activeTabId: string | null;
    };
    expect(document.activeTabId).toBe("b");
  });

  it("keeps a pending local activation instead of adopting the Host's older tab", async () => {
    const store = await makeStore();
    store.doc.projects = [project("p1")];
    store.doc.sessions = { a: session("a", "p1"), b: session("b", "p1") };
    store.doc.openTabIds = ["a", "b"];
    store.doc.activeTabId = "b";
    hostDoc.sessions = { a: session("a", "p1"), b: session("b", "p1") };
    hostDoc.openTabIds = ["a", "b"];
    // The activation for "b" is still in flight: the Host patch has not landed.
    hostDoc.activeTabId = "a";

    await store.persist();

    // Adopting "a" here is what bounced the tree and tab strip back for a whole
    // round trip on every click.
    expect(store.doc.activeTabId).toBe("b");
  });

  describe("activation writes go to the Host", () => {
    it("activates a session with one Host op so tab and project move together", async () => {
      const store = await makeStore();
      store.doc.projects = [project("p1")];
      store.doc.sessions = { s1: session("s1", "p1") };

      await store.openSession("s1");

      // A single op: open_tab + set_preview_project would emit two patches, and
      // the Shell projects the one in between.
      expect(opsSent()).toEqual(["host.app.activate_session"]);
      expect(hostCommand).toHaveBeenCalledWith({
        op: "host.app.activate_session",
        sessionId: "s1",
      });
      expect(store.doc.activeTabId).toBe("s1");
      expect(store.doc.previewProjectId).toBe("p1");
    });

    it("leaves the preview project alone for a project-less session", async () => {
      const store = await makeStore();
      store.doc.projects = [project("p1")];
      store.doc.sessions = { s1: session("s1") };
      store.doc.previewProjectId = "p1";

      await store.openSession("s1");

      expect(opsSent()).toEqual(["host.app.activate_session"]);
      expect(store.doc.previewProjectId).toBe("p1");
    });

    it("ignores an unknown session id", async () => {
      const store = await makeStore();

      await store.openSession("ghost");

      expect(hostCommand).not.toHaveBeenCalled();
    });

    it("routes tab-strip selection through the same activation op", async () => {
      const store = await makeStore();
      store.doc.projects = [project("p1")];
      store.doc.sessions = { s1: session("s1", "p1"), s2: session("s2", "p1") };
      store.doc.openTabIds = ["s1", "s2"];
      store.doc.previewProjectId = "p1";

      await store.selectTab("s2");

      expect(opsSent()).toEqual(["host.app.activate_session"]);
      expect(store.doc.activeTabId).toBe("s2");
    });

    it("opens a not-yet-open tab when selecting it", async () => {
      const store = await makeStore();
      store.doc.sessions = { s1: session("s1") };

      await store.selectTab("s1");

      expect(hostCommand).toHaveBeenCalledWith({
        op: "host.app.activate_session",
        sessionId: "s1",
      });
      expect(store.doc.openTabIds).toEqual(["s1"]);
    });

    it("selects the settings tab without touching sessions", async () => {
      const store = await makeStore();

      await store.selectTab("settings");

      expect(hostCommand).toHaveBeenCalledWith({
        op: "host.app.open_tab",
        tabId: "settings",
      });
    });

    it("opens the settings tab through the Host", async () => {
      const store = await makeStore();

      await store.openSettingsTab();

      expect(hostCommand).toHaveBeenCalledWith({
        op: "host.app.open_tab",
        tabId: "settings",
      });
      expect(store.doc.activeTabId).toBe("settings");
    });

    it("closes a tab through host.app.close_tab and keeps the session", async () => {
      const store = await makeStore();
      store.doc.sessions = { s1: session("s1"), s2: session("s2") };
      store.doc.openTabIds = ["s1", "s2"];
      store.doc.activeTabId = "s2";

      await store.closeOpenTab("s2");

      expect(hostCommand).toHaveBeenCalledWith({
        op: "host.app.close_tab",
        tabId: "s2",
      });
      expect(store.doc.openTabIds).toEqual(["s1"]);
      expect(store.doc.activeTabId).toBe("s1");
      expect(store.doc.sessions.s2).toBeDefined();
    });

    it("creates sessions through host.session.create and adopts the Host id", async () => {
      const store = await makeStore();
      store.doc.projects = [project("p1")];

      const id = await store.createSession({ projectId: "p1" });

      expect(id).toBe("host-session");
      expect(hostCreateSession).toHaveBeenCalledWith("p1", "对话 1");
      expect(store.doc.sessions["host-session"]?.projectId).toBe("p1");
      expect(store.doc.activeTabId).toBe("host-session");
      expect(opsSent()).not.toContain("host.app.replace_state");
    });

    it("toggles project expansion through the Host", async () => {
      const store = await makeStore();
      store.doc.projects = [project("p1")];

      await store.toggleProjectExpanded("p1");

      expect(hostCommand).toHaveBeenCalledWith({
        op: "host.workspace.set_project_expanded",
        projectId: "p1",
        expanded: false,
      });
    });

    it("opens a project through host.workspace.open", async () => {
      const store = await makeStore();

      const id = await store.ensureProject("/repo/next");

      expect(hostOpenWorkspace).toHaveBeenCalledWith("/repo/next");
      expect(store.doc.projects.some((item) => item.id === id)).toBe(true);
      expect(store.doc.previewProjectId).toBe(id);
    });

    it("skips a redundant preview-project write", async () => {
      const store = await makeStore();
      store.doc.projects = [project("p1")];
      store.doc.previewProjectId = "p1";

      await store.setPreviewProject("p1");

      expect(hostCommand).not.toHaveBeenCalled();
    });
  });

  describe("reorderOpenTabs", () => {
    async function storeWithOpenTabs(ids: string[]) {
      const store = await makeStore();
      // openTabIds only survive normalization when the session exists.
      store.doc.sessions = Object.fromEntries(
        ids.filter((id) => id !== "settings").map((id) => [id, session(id)]),
      );
      store.doc.openTabIds = [...ids];
      hostCommand.mockClear();
      return store;
    }

    it("applies a dragged tab order through its own Host op", async () => {
      const store = await storeWithOpenTabs(["a", "b", "c"]);

      store.reorderOpenTabs(["c", "a", "b"]);

      expect(store.doc.openTabIds).toEqual(["c", "a", "b"]);
      // replace_state no longer carries tab state, so a reorder sent that way
      // would be dropped by the Host.
      expect(hostCommand).toHaveBeenCalledWith({
        op: "host.app.reorder_tabs",
        tabIds: ["c", "a", "b"],
      });
      expect(opsSent()).not.toContain("host.app.replace_state");
    });

    it("keeps ids the caller did not mention", async () => {
      const store = await storeWithOpenTabs(["a", "b", "settings"]);

      store.reorderOpenTabs(["b", "a"]);

      expect(store.doc.openTabIds).toEqual(["b", "a", "settings"]);
    });

    it("does not write an unchanged order", async () => {
      const store = await storeWithOpenTabs(["a", "b"]);

      store.reorderOpenTabs(["a", "b"]);

      expect(hostCommand).not.toHaveBeenCalled();
    });
  });

  describe("content sync", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(async () => {
      // Drain per-session debounces: a leftover timer would fire into a later test.
      await vi.runAllTimersAsync();
      vi.useRealTimers();
    });

    async function storeWithHostSession(id: string) {
      const store = await makeStore();
      hostDoc.sessions = { [id]: session(id) };
      store.doc.sessions = { [id]: session(id) };
      return store;
    }

    it("sends session content through host.session.update", async () => {
      const store = await storeWithHostSession("u1");

      store.updateSessionContent("u1", {
        title: "renamed",
        messages: [message("m1", "hello")],
      });

      expect(opsSent()).toEqual(["host.session.update"]);
      expect(lastCommand()).toMatchObject({
        op: "host.session.update",
        sessionId: "u1",
        title: "renamed",
      });
      expect(store.doc.sessions.u1?.title).toBe("renamed");
    });

    it("falls back to the full document for a lastError change", async () => {
      const store = await storeWithHostSession("u2");

      store.updateSessionContent("u2", {
        lastError: { id: "e1", message: "boom", timestamp: 2 },
      });

      // host.session.update carries title + messages only.
      expect(opsSent()).toEqual(["host.app.replace_state"]);
      expect(store.doc.sessions.u2?.lastError?.message).toBe("boom");
    });

    it("coalesces a streaming turn into one host.session.update", async () => {
      const store = await storeWithHostSession("s3");
      const messages = [message("m1", "")];

      for (const chunk of ["a", "ab", "abc"]) {
        // The chat tab mutates the same array the store holds, as it does live.
        messages[0]!.content = chunk;
        store.upsertFromChatTab({ id: "s3", title: "s3", kind: "chat", messages });
      }

      expect(hostCommand).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(400);

      expect(opsSent()).toEqual(["host.session.update"]);
      expect(lastCommand().messages).toEqual(messages);
    });

    it("does not write when a chat tab's content did not change", async () => {
      const store = await storeWithHostSession("s4");
      const messages = [message("m1", "hi")];
      store.upsertFromChatTab({ id: "s4", title: "s4", kind: "chat", messages });
      await vi.advanceTimersByTimeAsync(400);
      hostCommand.mockClear();

      store.upsertFromChatTab({ id: "s4", title: "s4", kind: "chat", messages });
      await vi.advanceTimersByTimeAsync(400);

      expect(hostCommand).not.toHaveBeenCalled();
    });

    it("inserts a session the Host has never seen through the full document", async () => {
      const store = await makeStore();

      store.upsertFromChatTab({
        id: "restored",
        title: "restored",
        kind: "chat",
        messages: [message("m1", "old")],
      });

      expect(store.doc.sessions.restored).toBeDefined();
      await vi.advanceTimersByTimeAsync(400);
      // host.session.update answers "unknown session" for an id the Host lacks.
      expect(opsSent()).toEqual(["host.app.replace_state"]);
    });

    it("keeps a Host-minted task id without any write of its own", async () => {
      const store = await storeWithHostSession("s6");
      const messages = [message("m1", "hi")];
      store.upsertFromChatTab({ id: "s6", title: "s6", kind: "chat", messages });
      await vi.advanceTimersByTimeAsync(400);
      hostCommand.mockClear();

      store.upsertFromChatTab({
        id: "s6",
        title: "s6",
        kind: "chat",
        messages,
        lastTaskId: "task-1",
      });
      await vi.advanceTimersByTimeAsync(400);

      expect(store.doc.sessions.s6?.lastTaskId).toBe("task-1");
      expect(hostCommand).not.toHaveBeenCalled();

      store.upsertFromChatTab({
        id: "s6",
        title: "s6",
        kind: "chat",
        messages,
        lastTaskId: null,
      });

      expect(store.doc.sessions.s6?.lastTaskId).toBe("task-1");
    });

    it("falls back to the full document when a session changes project", async () => {
      const store = await storeWithHostSession("s7");
      store.doc.projects = [project("p1")];

      store.upsertFromChatTab({
        id: "s7",
        title: "s7",
        kind: "chat",
        messages: [],
        projectId: "p1",
      });
      await vi.advanceTimersByTimeAsync(400);

      expect(opsSent()).toEqual(["host.app.replace_state"]);
      expect(store.doc.sessions.s7?.projectId).toBe("p1");
    });

    it("writes a project preview through host.document.replace_preview", async () => {
      const store = await makeStore();
      store.doc.projects = [project("p9")];

      store.saveProjectPreview("p9", { version: 1, activeTabId: "code:/a.ts", tabs: [] });
      store.saveProjectPreview("p9", { version: 1, activeTabId: "code:/b.ts", tabs: [] });

      expect(hostCommand).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(400);

      expect(opsSent()).toEqual(["host.document.replace_preview"]);
      expect(lastCommand()).toMatchObject({
        op: "host.document.replace_preview",
        projectId: "p9",
        preview: { activeTabId: "code:/b.ts" },
      });
    });
  });
});
