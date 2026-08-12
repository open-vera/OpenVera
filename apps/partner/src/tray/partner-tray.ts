import { Image } from "@tauri-apps/api/image";
import { Menu } from "@tauri-apps/api/menu";
import { TrayIcon } from "@tauri-apps/api/tray";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAppStateStore } from "@/stores/app-state";
import { useChatStore } from "@/stores/chat";
import { useSettingsStore } from "@/stores/settings";
import {
  buildTrayMenuModel,
  TRAY_MENU_LABELS_EN,
  TRAY_MENU_LABELS_ZH,
  type TrayMenuModelItem,
  type TraySessionItem,
  type TraySessionMenuItem,
} from "./tray-menu-model.js";
import trayLineArtUrl from "@/assets/tray-line-art.png";

const TRAY_ID = "partner-main-tray";

export type PartnerTrayHandlers = {
  onSelectSession: (sessionId: string) => void;
  onNewChat: () => void;
};

let trayIcon: TrayIcon | null = null;
let handlers: PartnerTrayHandlers | null = null;
let refreshTimer: number | undefined;
let lastMenuSignature = "";

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function focusPartnerWindow(): Promise<void> {
  const win = getCurrentWindow();
  await win.unminimize();
  await win.show();
  await win.setFocus();
}

function collectTraySessions(): TraySessionItem[] {
  const appState = useAppStateStore();
  const chat = useChatStore();
  const runningById = new Map(
    chat.tabs
      .filter((tab) => tab.kind === "chat")
      .map((tab) => [tab.id, tab.isAgentRunning] as const)
  );

  return Object.values(appState.sessions).map((session) => ({
    id: session.id,
    title: session.title,
    updatedAt: session.updatedAt,
    isRunning: runningById.get(session.id) ?? false,
  }));
}

function menuSignature(items: TrayMenuModelItem[]): string {
  return JSON.stringify(items);
}

function toNativeMenuItems(
  items: TrayMenuModelItem[]
): Array<Record<string, unknown>> {
  const native: Array<Record<string, unknown>> = [];

  for (const item of items) {
    if (item.type === "header") {
      native.push({
        id: item.id,
        text: item.text,
        enabled: false,
      });
      continue;
    }
    if (item.type === "separator") {
      native.push({ item: "Separator" });
      continue;
    }
    if (item.type === "submenu") {
      native.push({
        id: item.id,
        text: item.text,
        items: item.items.map((child) => sessionMenuOptions(child)),
      });
      continue;
    }
    if (item.type === "session") {
      native.push(sessionMenuOptions(item));
      continue;
    }
    if (item.id === "quit") {
      native.push({
        id: "quit",
        text: item.text,
        action: () => {
          void getCurrentWindow().close();
        },
      });
      continue;
    }
    if (item.id === "open-partner") {
      native.push({
        id: "open-partner",
        text: item.text,
        action: () => {
          void focusPartnerWindow();
        },
      });
      continue;
    }
    native.push({
      id: "new-chat",
      text: item.text,
      action: () => {
        void focusPartnerWindow().then(() => {
          handlers?.onNewChat();
        });
      },
    });
  }

  return native;
}

function sessionMenuOptions(
  item: TraySessionMenuItem
): Record<string, unknown> {
  return {
    id: item.id,
    text: item.text,
    action: () => {
      void focusPartnerWindow().then(() => {
        handlers?.onSelectSession(item.sessionId);
      });
    },
  };
}

async function buildMenu(): Promise<{ menu: Menu; signature: string }> {
  const settings = useSettingsStore();
  const labels =
    settings.locale === "en" ? TRAY_MENU_LABELS_EN : TRAY_MENU_LABELS_ZH;
  const model = buildTrayMenuModel(collectTraySessions(), { labels });
  const signature = menuSignature(model);
  const menu = await Menu.new({
    // Tauri menu item unions are wider than our lightweight model mapper.
    items: toNativeMenuItems(model) as never,
  });
  return { menu, signature };
}

export async function initPartnerTray(
  nextHandlers: PartnerTrayHandlers
): Promise<void> {
  if (!isTauriRuntime()) return;
  handlers = nextHandlers;
  if (trayIcon) {
    await refreshPartnerTray();
    return;
  }

  try {
    const { menu, signature } = await buildMenu();
    lastMenuSignature = signature;
    const icon = await Image.fromBytes(
      await (await fetch(trayLineArtUrl)).arrayBuffer()
    );
    trayIcon = await TrayIcon.new({
      id: TRAY_ID,
      icon: icon ?? undefined,
      menu,
      tooltip: "Partner",
      iconAsTemplate: true,
      showMenuOnLeftClick: true,
    });
  } catch (error) {
    console.warn("[Tray] failed to create menu bar icon:", error);
    trayIcon = null;
  }
}

export async function refreshPartnerTray(): Promise<void> {
  if (!isTauriRuntime() || !trayIcon) return;
  try {
    const { menu, signature } = await buildMenu();
    if (signature === lastMenuSignature) return;
    lastMenuSignature = signature;
    await trayIcon.setMenu(menu);
  } catch (error) {
    console.warn("[Tray] failed to refresh menu:", error);
  }
}

export function schedulePartnerTrayRefresh(): void {
  if (!isTauriRuntime() || !trayIcon) return;
  if (refreshTimer) window.clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => {
    refreshTimer = undefined;
    void refreshPartnerTray();
  }, 200);
}

export async function disposePartnerTray(): Promise<void> {
  if (refreshTimer) {
    window.clearTimeout(refreshTimer);
    refreshTimer = undefined;
  }
  if (trayIcon) {
    try {
      await trayIcon.close();
    } catch {
      // ignore dispose races on quit
    }
  }
  trayIcon = null;
  handlers = null;
  lastMenuSignature = "";
}
