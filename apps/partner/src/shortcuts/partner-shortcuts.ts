import { useAppStateStore } from "@/stores/app-state";
import { useChatStore } from "@/stores/chat";
import { usePreviewStore } from "@/stores/preview";
import { useQuickOpenStore } from "@/stores/quick-open";
import { useTerminalStore } from "@/stores/terminal";
import { closeActiveCenterTabOrQuit } from "@/utils/close-center-tab";
import { confirmDialog } from "@/utils/native-dialog";

type ShortcutScope = "center" | "preview" | "left" | "bottom" | "global";
type WorkAreaScope = "center" | "preview";
type ShortcutId = "mod+w" | "mod+n" | "mod+p" | "mod+backtick";

interface ShortcutContext {
  event: KeyboardEvent;
  scope: ShortcutScope;
  chat: ReturnType<typeof useChatStore>;
  preview: ReturnType<typeof usePreviewStore>;
  quickOpen: ReturnType<typeof useQuickOpenStore>;
  terminal: ReturnType<typeof useTerminalStore>;
}

interface ShortcutDefinition {
  description: string;
  run: (context: ShortcutContext) => boolean | Promise<boolean>;
}

/** Last focused center/preview panel — used when Cmd+W comes from the app menu. */
let lastWorkAreaScope: WorkAreaScope = "center";
/** Deduplicate DOM keydown + native menu accelerator for the same Cmd+W. */
let lastCloseShortcutAt = 0;
const CLOSE_SHORTCUT_DEDUP_MS = 200;

export const PARTNER_SHORTCUTS: Record<ShortcutId, ShortcutDefinition> = {
  "mod+w": {
    description: "Close the active tab in the focused work area.",
    run: ({ scope, preview, terminal }) => {
      if (scope === "bottom") {
        if (terminal.activeTabId) {
          terminal.closeTab(terminal.activeTabId);
        } else {
          terminal.closePanel();
        }
        return true;
      }
      const workArea = resolveWorkAreaScope(scope);
      return closeTabInWorkArea(workArea, preview);
    },
  },
  "mod+n": {
    description: "Create a new chat session for the current project.",
    run: ({ chat }) => {
      const appState = useAppStateStore();
      const id = appState.createSession({ projectId: appState.previewProjectId });
      const session = appState.getSession(id);
      if (session) chat.ensureSessionTab(session);
      return true;
    },
  },
  "mod+p": {
    description: "Quick open a workspace file.",
    run: ({ quickOpen }) => {
      quickOpen.toggle();
      return true;
    },
  },
  "mod+backtick": {
    description: "Toggle the bottom terminal panel.",
    run: ({ terminal }) => {
      terminal.toggle();
      return true;
    },
  },
};

/**
 * Close the tab in the last focused work area (center chat or right preview).
 * Used by File → Close Tab / native Cmd+W accelerator.
 */
export function closeFocusedWorkAreaTab(): boolean {
  const preview = usePreviewStore();
  return closeTabInWorkArea(lastWorkAreaScope, preview);
}

export function registerPartnerShortcuts(): () => void {
  const chat = useChatStore();
  const preview = usePreviewStore();
  const quickOpen = useQuickOpenStore();
  const terminal = useTerminalStore();

  function onKeyDown(event: KeyboardEvent) {
    const shortcutId = normalizeShortcut(event);
    if (!shortcutId) return;

    const shortcut = PARTNER_SHORTCUTS[shortcutId];
    if (!shortcut) return;

    const scope = resolveShortcutScope(event.target);
    rememberWorkAreaScope(scope);

    const handled = shortcut.run({
      event,
      scope,
      chat,
      preview,
      quickOpen,
      terminal,
    });

    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  function onFocusIn(event: FocusEvent) {
    rememberWorkAreaScope(resolveShortcutScope(event.target));
  }

  function onPointerDown(event: PointerEvent) {
    rememberWorkAreaScope(resolveShortcutScope(event.target));
  }

  window.addEventListener("keydown", onKeyDown, { capture: true });
  window.addEventListener("focusin", onFocusIn, { capture: true });
  window.addEventListener("pointerdown", onPointerDown, { capture: true });
  return () => {
    window.removeEventListener("keydown", onKeyDown, { capture: true });
    window.removeEventListener("focusin", onFocusIn, { capture: true });
    window.removeEventListener("pointerdown", onPointerDown, { capture: true });
  };
}

function normalizeShortcut(event: KeyboardEvent): ShortcutId | null {
  const isMod = event.metaKey || event.ctrlKey;
  // VS Code / Cursor style: Ctrl+` (Control preferred; Meta also accepted).
  if (
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    !event.shiftKey &&
    (event.key === "`" || event.code === "Backquote")
  ) {
    return "mod+backtick";
  }
  if (!isMod || event.altKey) return null;
  const key = event.key.toLowerCase();
  if (key === "w") return "mod+w";
  if (key === "n") return "mod+n";
  if (key === "p") return "mod+p";
  return null;
}

function resolveShortcutScope(target: EventTarget | null): ShortcutScope {
  if (!(target instanceof Element)) return "global";
  const scopedElement = target.closest<HTMLElement>("[data-shortcut-scope]");
  const scope = scopedElement?.dataset.shortcutScope;
  if (
    scope === "center" ||
    scope === "preview" ||
    scope === "left" ||
    scope === "bottom"
  ) {
    return scope;
  }
  return "global";
}

function rememberWorkAreaScope(scope: ShortcutScope) {
  if (scope === "preview" || scope === "center") {
    lastWorkAreaScope = scope;
  }
}

function resolveWorkAreaScope(scope: ShortcutScope): WorkAreaScope {
  if (scope === "preview" || scope === "center") {
    return scope;
  }
  return lastWorkAreaScope;
}

function claimCloseShortcut(): boolean {
  const now = Date.now();
  if (now - lastCloseShortcutAt < CLOSE_SHORTCUT_DEDUP_MS) {
    return false;
  }
  lastCloseShortcutAt = now;
  return true;
}

function closeTabInWorkArea(
  scope: WorkAreaScope,
  preview: ReturnType<typeof usePreviewStore>,
): boolean {
  if (!claimCloseShortcut()) {
    return true;
  }

  if (scope === "preview") {
    // Preview focus must never fall through to closing a chat session.
    closeActivePreviewTab(preview);
    return true;
  }

  void closeActiveCenterTabOrQuit();
  return true;
}

function closeActivePreviewTab(preview: ReturnType<typeof usePreviewStore>): boolean {
  const activeTab = preview.tabs.find((tab) => tab.id === preview.activeTabId);
  if (!activeTab) return false;
  if (activeTab.isDirty) {
    void confirmDialog(
      `${activeTab.title} 有未保存的修改，确认关闭并丢弃这些修改吗？`,
    ).then((shouldClose) => {
      if (shouldClose) {
        preview.closeTab(activeTab.id);
      }
    });
    return true;
  }
  preview.closeTab(activeTab.id);
  return true;
}

/** Test-only helpers */
export const __test__ = {
  reset() {
    lastWorkAreaScope = "center";
    lastCloseShortcutAt = 0;
  },
  setLastWorkAreaScope(scope: WorkAreaScope) {
    lastWorkAreaScope = scope;
  },
  getLastWorkAreaScope() {
    return lastWorkAreaScope;
  },
};
