import { dirname } from "node:path";
import { globalDataPath } from "../../../config/paths.js";
import { MemoryTracker } from "../../../memory/index.js";
import type { MemoryFile } from "../../../memory/index.js";
import type { CompressionState, MicroCompactState } from "../../../context/index.js";
import { getModelContextLimit } from "../../../context/index.js";
import { loadProjectContext } from "../../../project-context/index.js";
import type { ProjectContext } from "../../../project-context/index.js";
import type { Message } from "../../../types/index.js";
import type { ReplContext } from "../../context.js";
import {
  buildDynamicContextOptions,
  buildMemoryPreamble,
  memoryInventorySignature,
  shouldRefreshMemoryInventory,
} from "./turnContext.js";

export interface RefLike<T> {
  current: T;
}

export interface TurnContextRefs {
  historyRef: RefLike<Message[]>;
  compressionStateRef: RefLike<CompressionState>;
  microCompactStateRef: RefLike<MicroCompactState>;
  memoryTrackerRef: RefLike<MemoryTracker | null>;
  frozenMemoryFilesRef: RefLike<MemoryFile[]>;
  frozenMemorySignatureRef: RefLike<string>;
  frozenMemoryTurnRef: RefLike<number>;
  projectContextRef: RefLike<ProjectContext | null>;
  loadedVeraContextPathsRef: RefLike<Set<string>>;
}

export interface PreparedTurnContext {
  runDir: string;
  projectContext: ProjectContext;
  memoryTracker: MemoryTracker;
  dynamicContext: ReturnType<typeof buildDynamicContextOptions> & {
    compressionState: CompressionState;
    microCompactState: MicroCompactState;
    memoryTracker: MemoryTracker;
    scannedMemoryFiles: MemoryFile[];
    onMemorySelected: typeof buildMemoryPreamble;
    onContextUpdate: (
      nextHistory: Message[],
      update: { compressionState: CompressionState | null; microCompactState: MicroCompactState | null },
    ) => void;
  };
}

export interface PrepareTurnContextOptions {
  ctx: ReplContext;
  activeModel: string;
  turnCount: number;
  refs: TurnContextRefs;
  loadProjectContextImpl?: typeof loadProjectContext;
  createMemoryTracker?: (memoryDir: string) => MemoryTracker;
}

export async function prepareTurnContext({
  ctx,
  activeModel,
  turnCount,
  refs,
  loadProjectContextImpl = loadProjectContext,
  createMemoryTracker = (memoryDir) => new MemoryTracker({ memoryDir }),
}: PrepareTurnContextOptions): Promise<PreparedTurnContext> {
  const store = ctx.sessionStore;
  const runDir = dirname(store.filePath);

  if (refs.projectContextRef.current === null) {
    refs.projectContextRef.current = loadProjectContextImpl({ cwd: ctx.cwd });
    refs.loadedVeraContextPathsRef.current = new Set(refs.projectContextRef.current.files.map((file) => file.path));
  }

  if (refs.memoryTrackerRef.current === null) {
    refs.memoryTrackerRef.current = createMemoryTracker(globalDataPath("memory"));
  }

  const memoryTracker = refs.memoryTrackerRef.current;
  const scannedMemoryFiles = await memoryTracker.scan();
  const memorySignature = memoryInventorySignature(scannedMemoryFiles);
  if (shouldRefreshMemoryInventory({
    selectedCount: refs.frozenMemoryFilesRef.current.length,
    currentTurn: turnCount,
    frozenTurn: refs.frozenMemoryTurnRef.current,
    currentSignature: memorySignature,
    frozenSignature: refs.frozenMemorySignatureRef.current,
  })) {
    refs.frozenMemoryFilesRef.current = memoryTracker.selectForInjection(scannedMemoryFiles);
    refs.frozenMemorySignatureRef.current = memorySignature;
    refs.frozenMemoryTurnRef.current = turnCount;
  }

  const modelContextLimit = getModelContextLimit(activeModel);
  const dynamicContext = {
    ...buildDynamicContextOptions(modelContextLimit, activeModel, ctx.config.session?.compact),
    compressionState: refs.compressionStateRef.current,
    microCompactState: refs.microCompactStateRef.current,
    memoryTracker,
    scannedMemoryFiles: refs.frozenMemoryFilesRef.current,
    onMemorySelected: buildMemoryPreamble,
    onContextUpdate: (
      nextHistory: Message[],
      update: { compressionState: CompressionState | null; microCompactState: MicroCompactState | null },
    ) => {
      refs.historyRef.current = [...nextHistory];
      if (update.compressionState) refs.compressionStateRef.current = update.compressionState;
      if (update.microCompactState) refs.microCompactStateRef.current = update.microCompactState;
    },
  };

  return {
    runDir,
    projectContext: refs.projectContextRef.current,
    memoryTracker,
    dynamicContext,
  };
}
