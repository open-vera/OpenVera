import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetSyncLogFlag, syncCaller, syncLog } from "@/utils/sync-log";

const FLAG = "partner:debug-sync";

const stored = new Map<string, string>();

describe("sync-log", () => {
  beforeEach(() => {
    stored.clear();
    resetSyncLogFlag();
    vi.restoreAllMocks();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => {
        stored.set(key, value);
      },
    });
  });

  it("logs under a single grep-able tag once the flag is set", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    stored.set(FLAG, "1");
    resetSyncLogFlag();

    syncLog("appState.openSession", { sessionId: "s1" });

    expect(info).toHaveBeenCalledWith("[ProjectSync] appState.openSession", {
      sessionId: "s1",
    });
  });

  it("caches the flag until it is reset", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    stored.set(FLAG, "1");
    resetSyncLogFlag();
    syncLog("first");
    stored.delete(FLAG);
    syncLog("still cached");

    expect(info).toHaveBeenCalledTimes(2);
  });

  it('is silenced by the flag set to "0", and skips building a stack', () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    stored.set(FLAG, "0");
    resetSyncLogFlag();

    syncLog("event");

    expect(info).not.toHaveBeenCalled();
    expect(syncCaller()).toBe("");
  });

  it("survives a localStorage that throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
    });
    resetSyncLogFlag();

    expect(() => syncLog("event")).not.toThrow();
  });

  it("names the calling frame without the 'at' prefix", () => {
    stored.set(FLAG, "1");
    resetSyncLogFlag();

    function writer() {
      return syncCaller(2);
    }

    const caller = writer();
    expect(caller).not.toMatch(/^at /);
    expect(caller).toContain("writer");
  });
});
