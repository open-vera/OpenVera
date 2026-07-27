export type TraySessionItem = {
  id: string;
  title: string;
  updatedAt: number;
  isRunning: boolean;
};

export type TrayMenuLabels = {
  running: string;
  recent: string;
  more: string;
  newChat: string;
  openPartner: string;
  quit: string;
};

export type TraySessionMenuItem = {
  type: "session";
  id: string;
  text: string;
  sessionId: string;
};

export type TrayMenuModelItem =
  | { type: "header"; id: string; text: string }
  | { type: "separator"; id: string }
  | TraySessionMenuItem
  | { type: "action"; id: "new-chat" | "open-partner" | "quit"; text: string }
  | { type: "submenu"; id: string; text: string; items: TraySessionMenuItem[] };

export const DEFAULT_TRAY_RECENT_LIMIT = 5;
export const DEFAULT_TRAY_TITLE_MAX = 28;

export const TRAY_MENU_LABELS_ZH: TrayMenuLabels = {
  running: "进行中",
  recent: "最近",
  more: "更多",
  newChat: "新建对话",
  openPartner: "打开 Partner",
  quit: "退出 Partner",
};

export const TRAY_MENU_LABELS_EN: TrayMenuLabels = {
  running: "Running",
  recent: "Recent",
  more: "More",
  newChat: "New Chat",
  openPartner: "Open Partner",
  quit: "Quit Partner",
};

export function truncateTrayTitle(title: string, max = DEFAULT_TRAY_TITLE_MAX): string {
  const normalized = title.trim().replace(/\s+/g, " ");
  if (!normalized) return "Untitled";
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}

/**
 * Build a ChatGPT-style tray menu model:
 * Running → Recent (+ More) → New Chat → Open / Quit.
 */
export function buildTrayMenuModel(
  sessions: TraySessionItem[],
  options?: {
    recentLimit?: number;
    labels?: TrayMenuLabels;
  },
): TrayMenuModelItem[] {
  const recentLimit = options?.recentLimit ?? DEFAULT_TRAY_RECENT_LIMIT;
  const labels = options?.labels ?? TRAY_MENU_LABELS_ZH;
  const items: TrayMenuModelItem[] = [];

  const running = sessions
    .filter((session) => session.isRunning)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const recent = sessions
    .filter((session) => !session.isRunning)
    .sort((a, b) => b.updatedAt - a.updatedAt);

  if (running.length > 0) {
    items.push({ type: "header", id: "header-running", text: labels.running });
    for (const session of running) {
      items.push({
        type: "session",
        id: `session:${session.id}`,
        text: truncateTrayTitle(session.title),
        sessionId: session.id,
      });
    }
    items.push({ type: "separator", id: "sep-after-running" });
  }

  if (recent.length > 0) {
    items.push({ type: "header", id: "header-recent", text: labels.recent });
    const visible = recent.slice(0, recentLimit);
    const overflow = recent.slice(recentLimit);
    for (const session of visible) {
      items.push({
        type: "session",
        id: `session:${session.id}`,
        text: truncateTrayTitle(session.title),
        sessionId: session.id,
      });
    }
    if (overflow.length > 0) {
      items.push({
        type: "submenu",
        id: "submenu-more",
        text: labels.more,
        items: overflow.map((session) => ({
          type: "session" as const,
          id: `session-more:${session.id}`,
          text: truncateTrayTitle(session.title),
          sessionId: session.id,
        })),
      });
    }
    items.push({ type: "separator", id: "sep-after-recent" });
  }

  items.push({ type: "action", id: "new-chat", text: labels.newChat });
  items.push({ type: "separator", id: "sep-before-app" });
  items.push({ type: "action", id: "open-partner", text: labels.openPartner });
  items.push({ type: "action", id: "quit", text: labels.quit });
  return items;
}
