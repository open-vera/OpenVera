/**
 * Reproduction harness for the Host <-> Shell projection loop.
 *
 * The three views (session tree, chat tab strip, file tree) converge through
 * two Vue watchers in App.vue: Host patch -> Shell projection, and chat snapshot
 * -> debounced `host.app.replace_state`. When those two disagree they ping-pong
 * the active tab, which is what "跳来跳去" looks like in the app. This test wires
 * the real stores to a Host double that mutates like `dispatcher.rs` does, so the
 * loop either converges here or it does not converge in the app either.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { nextTick, reactive, watch } from "vue";

type HostSession = {
  id: string;
  projectId: string | null;
  title: string;
  messages: unknown[];
  lastError: null;
  lastTaskId: null;
  createdAt: number;
  updatedAt: number;
};

const emptyPreview = () => ({ version: 1, activeTabId: null, tabs: [] });

function hostProject(id: string, rootPath: string, tabs: unknown[] = []) {
  return {
    id,
    rootPath,
    name: rootPath.split("/").pop() ?? id,
    expanded: true,
    preview: {
      version: 1,
      activeTabId: (tabs[0] as { id?: string } | undefined)?.id ?? null,
      tabs,
    },
    updatedAt: 1,
  };
}

/** Editor tab shaped like the preview store persists them. */
function codeTab(filePath: string) {
  return {
    id: `code:${filePath}`,
    title: filePath.split("/").pop(),
    kind: "code",
    source: filePath,
    filePath,
    content: "",
    isDirty: false,
  };
}

function hostSession(id: string, projectId: string | null): HostSession {
  return {
    id,
    projectId,
    title: id,
    messages: [],
    lastError: null,
    lastTaskId: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

/** Host double: same mutations as src-tauri/src/host/dispatcher.rs. */
const hostDoc = reactive({
  protocolVersion: 1,
  revision: 1,
  version: 4,
  projects: [
    hostProject("p1", "/repo/open-vera", [codeTab("/repo/open-vera/.prettierrc.json")]),
    hostProject("p2", "/repo/proxy-x-fe"),
  ],
  sessions: {
    b: hostSession("b", "p1"),
    a: hostSession("a", "p2"),
  } as Record<string, HostSession>,
  openTabIds: ["b"] as string[],
  activeTabId: "b" as string | null,
  previewProjectId: "p1" as string | null,
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
});

const opLog: string[] = [];

type Cmd = { op: string } & Record<string, unknown>;

async function hostCommandImpl(cmd: Cmd) {
  switch (cmd.op) {
    case "host.app.activate_session": {
      const sessionId = cmd.sessionId as string;
      const session = hostDoc.sessions[sessionId];
      if (!session) return undefined;
      opLog.push(`activate_session:${sessionId}`);
      if (!hostDoc.openTabIds.includes(sessionId)) hostDoc.openTabIds.push(sessionId);
      hostDoc.activeTabId = sessionId;
      if (session.projectId) hostDoc.previewProjectId = session.projectId;
      hostDoc.revision += 1;
      break;
    }
    case "host.app.open_tab": {
      const tabId = cmd.tabId as string;
      opLog.push(`open_tab:${tabId}`);
      if (!hostDoc.openTabIds.includes(tabId)) hostDoc.openTabIds.push(tabId);
      hostDoc.activeTabId = tabId;
      hostDoc.revision += 1;
      break;
    }
    case "host.workspace.set_preview_project": {
      opLog.push(`set_preview_project:${String(cmd.projectId)}`);
      hostDoc.previewProjectId = (cmd.projectId as string | null) ?? null;
      hostDoc.revision += 1;
      break;
    }
    case "host.app.replace_state": {
      // apply_persisted in src-tauri/src/host/persist.rs replaces every field.
      const doc = cmd.document as {
        projects: typeof hostDoc.projects;
        sessions: Record<string, HostSession>;
        openTabIds: string[];
        activeTabId: string | null;
        previewProjectId: string | null;
      };
      opLog.push(`replace_state:active=${String(doc.activeTabId)}:tabs=${doc.openTabIds.join("+")}`);
      hostDoc.projects = doc.projects;
      hostDoc.sessions = doc.sessions;
      hostDoc.openTabIds = [...doc.openTabIds];
      hostDoc.activeTabId = doc.activeTabId;
      hostDoc.previewProjectId = doc.previewProjectId;
      hostDoc.revision += 1;
      break;
    }
    default:
      opLog.push(cmd.op);
  }
  return undefined;
}

const hostCommand = vi.fn(hostCommandImpl);

vi.mock("@/shell", () => ({
  useHostStore: () => ({
    booted: true,
    boot: vi.fn(async () => undefined),
    command: hostCommand,
    doc: hostDoc,
    get previewProject() {
      const id = hostDoc.previewProjectId;
      return id ? hostDoc.projects.find((p) => p.id === id) ?? null : null;
    },
  }),
}));

/** Flush Vue watchers plus the debounced persist, repeatedly. */
async function pump(rounds = 12) {
  for (let i = 0; i < rounds; i += 1) {
    await nextTick();
    await vi.advanceTimersByTimeAsync(500);
    await nextTick();
  }
}

describe("Host projection loop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setActivePinia(createPinia());
    opLog.length = 0;
    hostCommand.mockClear();
    Object.assign(hostDoc, {
      revision: 1,
      projects: [
        hostProject("p1", "/repo/open-vera", [codeTab("/repo/open-vera/.prettierrc.json")]),
        hostProject("p2", "/repo/proxy-x-fe"),
      ],
      sessions: { b: hostSession("b", "p1"), a: hostSession("a", "p2") },
      openTabIds: ["b"],
      activeTabId: "b",
      previewProjectId: "p1",
    });
  });

  it("settles on the activated session instead of ping-ponging the active tab", async () => {
    const { useAppStateStore } = await import("@/stores/app-state");
    const { useChatStore } = await import("@/stores/chat");
    const { usePreviewStore } = await import("@/stores/preview");
    const appState = useAppStateStore();
    const chat = useChatStore();
    const preview = usePreviewStore();

    await appState.load();

    // ── The two App.vue watchers, verbatim in behaviour ──────────────────────
    const hostTabSignature = () =>
      [
        hostDoc.activeTabId ?? "",
        hostDoc.previewProjectId ?? "",
        hostDoc.openTabIds.join(","),
        hostDoc.projects.map((p) => `${p.id}:${p.expanded ? 1 : 0}`).join(","),
        Object.keys(hostDoc.sessions).length,
      ].join("|");

    watch(hostTabSignature, () => {
      if (!appState.isLoaded) return;
      appState.syncFromHost();
      chat.syncFromOpenTabIds(appState.openTabIds, appState.sessions, appState.activeTabId);
      if (appState.previewProject?.preview) {
        preview.restoreSnapshot(appState.previewProject.preview);
      }
    });

    // PreviewPanel.vue: every preview-store change is written back into whichever
    // project is current — undebounced, straight to replace_state.
    watch(
      () => preview.exportSnapshot(),
      (snapshot) => {
        if (appState.previewProject) {
          appState.saveProjectPreview(appState.previewProject.id, snapshot);
        }
      },
      { deep: true },
    );

    watch(
      () => chat.exportSnapshot(),
      () => {
        appState.schedulePersist();
        for (const tab of chat.tabs) {
          if (tab.kind !== "chat") continue;
          appState.upsertFromChatTab({
            id: tab.id,
            title: tab.title,
            kind: "chat",
            messages: tab.messages,
            lastError: tab.lastError ?? null,
            lastTaskId: tab.lastTaskId ?? null,
          });
        }
      },
      { deep: true },
    );

    // Boot state: session "b" open and active.
    chat.syncFromOpenTabIds(appState.openTabIds, appState.sessions, appState.activeTabId);
    await pump(3);
    opLog.length = 0;

    // ── The click: activate "a", which lives in the other project ────────────
    const session = appState.getSession("a");
    expect(session).not.toBeNull();
    await appState.openSession("a");
    chat.ensureSessionTab(session!);

    await pump();

    const replaceStates = opLog.filter((entry) => entry.startsWith("replace_state"));
    const activeTabsWritten = [
      ...new Set(replaceStates.map((entry) => entry.split(":")[1])),
    ];

    expect(hostDoc.activeTabId).toBe("a");
    expect(hostDoc.previewProjectId).toBe("p2");
    expect(chat.activeTabId).toBe("a");
    // The loop signature: replace_state alternating between two active tabs.
    expect(activeTabsWritten).toEqual(["active=a"]);
    expect(replaceStates.length).toBeLessThanOrEqual(2);
  });
});
