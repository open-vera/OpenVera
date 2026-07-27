import { getCurrentWindow } from "@tauri-apps/api/window";
import { getChatRunner } from "@/shell";
import { useAppStateStore } from "@/stores/app-state";
import { useChatStore } from "@/stores/chat";
import { confirmDialog } from "@/utils/native-dialog";

let closeInFlight = false;

/**
 * Close a center tab (chat or settings), keeping the session in the left tree.
 * Does not quit the app — callers should use {@link closeActiveCenterTabOrQuit}
 * when the user may be closing the last tab.
 */
export function closeCenterTabById(tabId: string): boolean {
  const chat = useChatStore();
  const appState = useAppStateStore();
  const tab = chat.tabs.find((item) => item.id === tabId);
  if (!tab) return false;
  if (tab.kind === "chat" && tab.isAgentRunning) {
    getChatRunner().abort({ discardQueue: true });
  }
  if (tab.kind === "chat") {
    appState.updateSessionContent(tabId, {
      title: tab.title,
      messages: tab.messages,
      lastError: tab.lastError ?? null,
    });
  }
  appState.closeOpenTab(tabId);
  chat.closeTab(tabId);
  chat.syncFromOpenTabIds(
    appState.openTabIds,
    appState.sessions,
    appState.activeTabId,
  );
  return true;
}

/** Prompt and quit Partner when confirmed. */
export async function confirmQuitPartner(): Promise<boolean> {
  const shouldQuit = await confirmDialog(
    "这是最后一个标签页。关闭后将退出 Partner，是否继续？",
    { title: "关闭 Partner" },
  );
  if (!shouldQuit) return false;
  await getCurrentWindow().close();
  return true;
}

/**
 * Close the active center tab. If it is the only remaining tab, ask to quit Partner.
 * Returns true when the shortcut/menu action was handled (including cancel on quit prompt).
 */
export async function closeActiveCenterTabOrQuit(): Promise<boolean> {
  // Menu accelerator + window keydown can both fire for Cmd+W.
  if (closeInFlight) return true;
  closeInFlight = true;
  try {
    const chat = useChatStore();
    const activeTab = chat.activeTab;
    if (!activeTab) return false;
    if (activeTab.kind === "chat" && activeTab.isAgentRunning) return false;

    if (chat.tabs.length <= 1) {
      await confirmQuitPartner();
      return true;
    }

    return closeCenterTabById(activeTab.id);
  } finally {
    closeInFlight = false;
  }
}
