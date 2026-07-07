import { useChatStore } from "@/stores/chat";
import { usePreviewStore } from "@/stores/preview";

type ShortcutScope = "center" | "preview" | "left" | "global";
type ShortcutId = "mod+w" | "mod+n";

interface ShortcutContext {
  event: KeyboardEvent;
  scope: ShortcutScope;
  chat: ReturnType<typeof useChatStore>;
  preview: ReturnType<typeof usePreviewStore>;
}

interface ShortcutDefinition {
  description: string;
  run: (context: ShortcutContext) => boolean;
}

export const PARTNER_SHORTCUTS: Record<ShortcutId, ShortcutDefinition> = {
  "mod+w": {
    description: "Close the active tab in the focused work area.",
    run: ({ scope, chat, preview }) => {
      if (scope === "center") {
        return closeActiveCenterTab(chat);
      }
      if (scope === "preview") {
        return closeActivePreviewTab(preview);
      }
      return closeActivePreviewTab(preview) || closeActiveCenterTab(chat);
    },
  },
  "mod+n": {
    description: "Create a new chat tab.",
    run: ({ chat }) => {
      chat.createChatTab();
      return true;
    },
  },
};

export function registerPartnerShortcuts(): () => void {
  const chat = useChatStore();
  const preview = usePreviewStore();

  function onKeyDown(event: KeyboardEvent) {
    const shortcutId = normalizeShortcut(event);
    if (!shortcutId) return;

    const shortcut = PARTNER_SHORTCUTS[shortcutId];
    if (!shortcut) return;

    const handled = shortcut.run({
      event,
      scope: resolveShortcutScope(event.target),
      chat,
      preview,
    });

    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  window.addEventListener("keydown", onKeyDown, { capture: true });
  return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
}

function normalizeShortcut(event: KeyboardEvent): ShortcutId | null {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return null;
  const key = event.key.toLowerCase();
  if (key === "w") return "mod+w";
  if (key === "n") return "mod+n";
  return null;
}

function resolveShortcutScope(target: EventTarget | null): ShortcutScope {
  if (!(target instanceof Element)) return "global";
  const scopedElement = target.closest<HTMLElement>("[data-shortcut-scope]");
  const scope = scopedElement?.dataset.shortcutScope;
  if (scope === "center" || scope === "preview" || scope === "left") {
    return scope;
  }
  return "global";
}

function closeActiveCenterTab(chat: ReturnType<typeof useChatStore>): boolean {
  const activeTab = chat.activeTab;
  if (!activeTab || activeTab.isAgentRunning) return false;
  if (
    activeTab.kind === "chat" &&
    chat.tabs.filter((tab) => tab.kind === "chat").length <= 1
  ) {
    return false;
  }
  chat.closeTab(activeTab.id);
  return true;
}

function closeActivePreviewTab(preview: ReturnType<typeof usePreviewStore>): boolean {
  const activeTab = preview.tabs.find((tab) => tab.id === preview.activeTabId);
  if (!activeTab) return false;
  if (activeTab.isDirty) {
    const shouldClose = window.confirm(
      `${activeTab.title} 有未保存的修改，确认关闭并丢弃这些修改吗？`,
    );
    if (!shouldClose) return false;
  }
  preview.closeTab(activeTab.id);
  return true;
}
