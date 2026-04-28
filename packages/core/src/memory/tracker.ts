import type {
  DetectorConfig,
  InjectionRecord,
  MemoryFile,
  MemoryHitStats,
  UsageDetectionResult,
} from "./types.js";
import { DEFAULT_DETECTOR_CONFIG } from "./types.js";
import { scanMemoryDir } from "./scanner.js";
import { detectUsage } from "./detector.js";

/**
 * Default maximum number of memory files to inject per turn.
 */
const DEFAULT_MAX_INJECT = 5;

/**
 * Files with hitRate below this and at least this many injections are
 * candidates for removal.
 */
const STALE_HIT_RATE_THRESHOLD = 0.1;
const STALE_MIN_INJECTIONS = 3;

export interface MemoryTrackerOptions {
  /** Absolute path to the memory directory (e.g. ~/.claude/projects/.../memory). */
  memoryDir: string;
  /** Max memory files to inject per turn. Default 5. */
  maxInjectPerTurn?: number;
  /** Detector configuration. Defaults to keyword-only at 0.2 threshold. */
  detector?: Partial<DetectorConfig>;
}

/**
 * Tracks which memory files are injected into context each turn,
 * detects whether the model actually used them, and accumulates
 * hit scores to guide future selection / pruning.
 *
 * Lifecycle per turn:
 *   const files = await tracker.scan();
 *   const selected = tracker.selectForInjection(files);
 *   tracker.recordInjection(selected);
 *   // ... send to model, get response ...
 *   await tracker.detectAndUpdate(response);
 */
export class MemoryTracker {
  private memoryDir: string;
  private maxInjectPerTurn: number;
  private detectorConfig: DetectorConfig;

  /** Accumulated stats keyed by file path. */
  private stats: Map<string, MemoryHitStats> = new Map();
  /** Injection records for the current session, newest first. */
  private injections: InjectionRecord[] = [];
  /** Turn counter (incremented by recordInjection). */
  private turn = 0;
  /** Paths injected in the current (pending) turn, before detection. */
  private pendingInjection: string[] | null = null;

  constructor(options: MemoryTrackerOptions) {
    this.memoryDir = options.memoryDir;
    this.maxInjectPerTurn = options.maxInjectPerTurn ?? DEFAULT_MAX_INJECT;
    this.detectorConfig = {
      ...DEFAULT_DETECTOR_CONFIG,
      ...options.detector,
    };
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Scan the memory directory and return discovered files, sorted by
   * mtime (newest first). Call once per turn or cache briefly.
   */
  async scan(): Promise<MemoryFile[]> {
    return scanMemoryDir(this.memoryDir);
  }

  /**
   * Select up to `maxInjectPerTurn` files from the scanned list for
   * injection into the current turn's context.
   *
   * Strategy: prefer files with high hitRate, then by recency.
   * Files with zero prior injections get a neutral starting priority.
   */
  selectForInjection(files: MemoryFile[]): MemoryFile[] {
    const scored = files.map((f) => {
      const st = this.stats.get(f.path);
      const hitRate = st ? st.hitRate : 0.5; // neutral for new files
      const injections = st ? st.injections : 0;
      // Boost: new files get a small priority bump to ensure they're tried
      const exploreBoost = injections === 0 ? 0.1 : 0;
      return { file: f, priority: hitRate + exploreBoost };
    });

    // Sort by priority desc, then mtime desc as tiebreaker
    scored.sort((a, b) => {
      const p = b.priority - a.priority;
      if (Math.abs(p) > 0.001) return p;
      return b.file.mtimeMs - a.file.mtimeMs;
    });

    return scored.slice(0, this.maxInjectPerTurn).map((s) => s.file);
  }

  /**
   * Record that a set of files was injected into the current turn's
   * context. Call BEFORE sending to the model.
   */
  recordInjection(paths: string[]): void {
    this.turn++;
    this.pendingInjection = [...paths];

    // Initialize stats for newly seen files
    for (const path of paths) {
      if (!this.stats.has(path)) {
        this.stats.set(path, {
          path,
          filename: "",
          type: undefined,
          description: null,
          injections: 0,
          hits: 0,
          hitRate: 0,
          lastScore: 0,
          mtimeMs: 0,
        });
      }
    }

    this.injections.unshift({
      turn: this.turn,
      injectedPaths: [...paths],
      at: new Date().toISOString(),
    });
  }

  /**
   * Run usage detection on the assistant's response and update
   * accumulated stats for the pending injection. Call AFTER receiving
   * the model's response.
   *
   * Returns the detection results for this turn.
   */
  async detectAndUpdate(
    response: string,
    memories: MemoryFile[],
  ): Promise<UsageDetectionResult[]> {
    const injectedPaths = this.pendingInjection ?? [];
    const injected = memories.filter((m) => injectedPaths.includes(m.path));

    const results = await detectUsage(response, injected, this.detectorConfig);

    // Update accumulated stats
    for (const result of results) {
      const st = this.stats.get(result.path);
      if (!st) continue;

      st.injections++;
      if (result.used) st.hits++;
      st.hitRate = st.injections > 0 ? st.hits / st.injections : 0;
      st.lastScore = result.score;

      // Backfill metadata from the memory file
      const mem = injected.find((m) => m.path === result.path);
      if (mem) {
        st.filename = mem.filename;
        st.type = mem.type;
        st.description = mem.description;
        st.mtimeMs = mem.mtimeMs;
      }
    }

    this.pendingInjection = null;
    return results;
  }

  /**
   * Convenience: detect + update using only the response text and a
   * pre-fetched scan result. The injected paths are taken from the
   * pending record.
   */
  async detectAndUpdateFromScan(
    response: string,
    scannedFiles: MemoryFile[],
  ): Promise<UsageDetectionResult[]> {
    return this.detectAndUpdate(response, scannedFiles);
  }

  /**
   * Return accumulated hit stats for all tracked memory files.
   */
  getStats(): MemoryHitStats[] {
    return [...this.stats.values()].sort((a, b) => b.hitRate - a.hitRate);
  }

  /**
   * Return files that are candidates for removal:
   * hitRate below threshold AND enough injections to be confident.
   */
  getStale(): MemoryHitStats[] {
    return this.getStats().filter(
      (s) =>
        s.hitRate < STALE_HIT_RATE_THRESHOLD &&
        s.injections >= STALE_MIN_INJECTIONS,
    );
  }

  /**
   * Return injection history for the session.
   */
  getInjectionHistory(): readonly InjectionRecord[] {
    return this.injections;
  }

  /**
   * Current turn number.
   */
  get currentTurn(): number {
    return this.turn;
  }
}
