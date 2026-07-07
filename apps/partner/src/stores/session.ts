import { defineStore } from "pinia";
import type { Session } from "@/types";

function createSession(windowId = "main"): Session {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    windowId,
    createdAt: now,
    lastActiveAt: now,
    instanceId: null,
  };
}

export const useSessionStore = defineStore("session", {
  state: () => ({
    current: createSession(),
  }),
  actions: {
    setWindowId(windowId: string) {
      if (!windowId || this.current.windowId === windowId) return;
      this.current = {
        ...this.current,
        windowId,
        lastActiveAt: Date.now(),
      };
    },
    async loadFromDb() {
      // Phase 2: load from SQLite via bridge
    },
    async persist() {
      this.current.lastActiveAt = Date.now();
      // Phase 2: persist to SQLite via bridge
    },
    touch() {
      this.current.lastActiveAt = Date.now();
    },
  },
});
