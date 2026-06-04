import { describe, expect, it, vi } from "vitest";
import {
  createCompressionState,
  createMicroCompactState,
} from "../src/context/index.js";
import type { MemoryFile } from "../src/memory/index.js";
import type { ProjectContext } from "../src/project-context/index.js";
import type { ReplContext } from "../src/repl/context.js";
import {
  prepareTurnContext,
  type TurnContextRefs,
} from "../src/repl/ui/controller/turnContextRuntime.js";
import type { Message } from "../src/types/index.js";

function memory(overrides: Partial<MemoryFile>): MemoryFile {
  return {
    path: "/tmp/memory.md",
    filename: "memory.md",
    description: undefined,
    type: undefined,
    score: 0,
    mtimeMs: 0,
    ...overrides,
  };
}

function projectContext(): ProjectContext {
  return {
    files: [{ path: "/tmp/project/VERA.md", type: "project", content: "rules" }],
    system: "Project system",
    signature: "sig",
  };
}

function ctx(): ReplContext {
  return {
    cwd: "/tmp/project",
    config: { providers: {}, default_provider: "test" },
    adapter: {} as ReplContext["adapter"],
    model: "model",
    tools: [],
    buildAdapter: () => ({} as ReplContext["adapter"]),
    sessionStore: { filePath: "/tmp/run/session.jsonl" } as ReplContext["sessionStore"],
    promptStore: {} as ReplContext["promptStore"],
  };
}

function refs(): TurnContextRefs {
  return {
    historyRef: { current: [] as Message[] },
    compressionStateRef: { current: createCompressionState() },
    microCompactStateRef: { current: createMicroCompactState() },
    memoryTrackerRef: { current: null },
    frozenMemoryFilesRef: { current: [] },
    frozenMemorySignatureRef: { current: "" },
    frozenMemoryTurnRef: { current: -5 },
    projectContextRef: { current: null },
    loadedVeraContextPathsRef: { current: new Set<string>() },
  };
}

describe("turnContextRuntime", () => {
  it("loads project context, creates memory tracker, and prepares dynamic context", async () => {
    const previousVeraHome = process.env.VERA_HOME;
    process.env.VERA_HOME = "/tmp/run-home";
    try {
      const scanned = [memory({ path: "/tmp/run/memory/a.md", filename: "a.md", mtimeMs: 10 })];
      const tracker = {
        scan: vi.fn().mockResolvedValue(scanned),
        selectForInjection: vi.fn((files: MemoryFile[]) => files.slice(0, 1)),
      };
      const state = refs();

      const prepared = await prepareTurnContext({
        ctx: ctx(),
        activeModel: "model-x",
        turnCount: 0,
        refs: state,
        loadProjectContextImpl: () => projectContext(),
        createMemoryTracker: (memoryDir) => {
          expect(memoryDir).toBe("/tmp/run-home/.vera/memory");
          return tracker as never;
        },
      });

      expect(prepared.runDir).toBe("/tmp/run");
      expect(prepared.projectContext.system).toBe("Project system");
      expect(prepared.memoryTracker).toBe(tracker);
      expect(prepared.dynamicContext.memoryTracker).toBe(tracker);
      expect(prepared.dynamicContext.scannedMemoryFiles).toEqual(scanned);
      expect(state.loadedVeraContextPathsRef.current).toEqual(new Set(["/tmp/project/VERA.md"]));
      expect(state.frozenMemoryFilesRef.current).toEqual(scanned);
      expect(state.frozenMemorySignatureRef.current).toBe("/tmp/run/memory/a.md:10");
      expect(state.frozenMemoryTurnRef.current).toBe(0);
    } finally {
      if (previousVeraHome === undefined) {
        delete process.env.VERA_HOME;
      } else {
        process.env.VERA_HOME = previousVeraHome;
      }
    }
  });

  it("reuses cached project context and memory selection when inventory is unchanged", async () => {
    const scanned = [memory({ path: "/tmp/run/memory/a.md", filename: "a.md", mtimeMs: 10 })];
    const selected = [scanned[0] as MemoryFile];
    const tracker = {
      scan: vi.fn().mockResolvedValue(scanned),
      selectForInjection: vi.fn(),
    };
    const state = refs();
    state.projectContextRef.current = projectContext();
    state.memoryTrackerRef.current = tracker as never;
    state.frozenMemoryFilesRef.current = selected;
    state.frozenMemorySignatureRef.current = "/tmp/run/memory/a.md:10";
    state.frozenMemoryTurnRef.current = 1;

    const prepared = await prepareTurnContext({
      ctx: ctx(),
      activeModel: "model-x",
      turnCount: 2,
      refs: state,
      loadProjectContextImpl: vi.fn(() => {
        throw new Error("should not load");
      }),
    });

    expect(prepared.dynamicContext.scannedMemoryFiles).toBe(selected);
    expect(tracker.selectForInjection).not.toHaveBeenCalled();
  });

  it("refreshes memory selection when inventory signature changes", async () => {
    const scanned = [memory({ path: "/tmp/run/memory/b.md", filename: "b.md", mtimeMs: 20 })];
    const tracker = {
      scan: vi.fn().mockResolvedValue(scanned),
      selectForInjection: vi.fn((files: MemoryFile[]) => files),
    };
    const state = refs();
    state.projectContextRef.current = projectContext();
    state.memoryTrackerRef.current = tracker as never;
    state.frozenMemoryFilesRef.current = [memory({ path: "/tmp/run/memory/a.md", filename: "a.md", mtimeMs: 10 })];
    state.frozenMemorySignatureRef.current = "/tmp/run/memory/a.md:10";
    state.frozenMemoryTurnRef.current = 1;

    await prepareTurnContext({
      ctx: ctx(),
      activeModel: "model-x",
      turnCount: 2,
      refs: state,
    });

    expect(tracker.selectForInjection).toHaveBeenCalledWith(scanned);
    expect(state.frozenMemoryFilesRef.current).toEqual(scanned);
    expect(state.frozenMemorySignatureRef.current).toBe("/tmp/run/memory/b.md:20");
  });

  it("updates history and compression state through dynamic context callback", async () => {
    const tracker = {
      scan: vi.fn().mockResolvedValue([]),
      selectForInjection: vi.fn(() => []),
    };
    const state = refs();
    const prepared = await prepareTurnContext({
      ctx: ctx(),
      activeModel: "model-x",
      turnCount: 0,
      refs: state,
      loadProjectContextImpl: () => projectContext(),
      createMemoryTracker: () => tracker as never,
    });
    const nextCompression = createCompressionState();
    nextCompression.compressedUntilIndex = 3;

    prepared.dynamicContext.onContextUpdate(
      [{ role: "user", content: "next" }],
      { compressionState: nextCompression, microCompactState: null },
    );

    expect(state.historyRef.current).toEqual([{ role: "user", content: "next" }]);
    expect(state.compressionStateRef.current).toBe(nextCompression);
  });
});
