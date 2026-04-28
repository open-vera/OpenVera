/**
 * Memory file discovered on disk. The scanner reads frontmatter from each
 * .md file in the memory directory to populate these fields.
 */
export interface MemoryFile {
  /** Absolute path to the .md file on disk. */
  path: string;
  /** Filename relative to the memory directory root. */
  filename: string;
  /** Frontmatter `type` field — user, project, reference, feedback. */
  type: MemoryType | undefined;
  /** Frontmatter `description` field — one-line summary. */
  description: string | null;
  /** mtime (ms) when the scanner read the file. Used for staleness checks. */
  mtimeMs: number;
}

export type MemoryType = "user" | "project" | "feedback" | "reference";

/**
 * Snapshot recorded each time the agent injects a set of memory files
 * into context. Used to later reconcile which ones were actually used.
 */
export interface InjectionRecord {
  /** Turn number when the injection happened. */
  turn: number;
  /** Paths of memory files injected this turn. */
  injectedPaths: string[];
  /** ISO timestamp. */
  at: string;
}

/**
 * Result of a single usage-detection pass after the assistant responds.
 */
export interface UsageDetectionResult {
  /** Memory file path. */
  path: string;
  /** Whether the detector considers this memory "used" in the response. */
  used: boolean;
  /** Confidence score 0–1 (keyword overlap ratio). */
  score: number;
  /** Which keywords from the memory description were found in the response. */
  matchedKeywords: string[];
}

/**
 * Accumulated statistics for a single memory file across all turns
 * in the session.
 */
export interface MemoryHitStats {
  path: string;
  filename: string;
  type: MemoryType | undefined;
  description: string | null;
  /** Number of turns where this memory was injected. */
  injections: number;
  /** Number of turns where it was detected as used. */
  hits: number;
  /** hit / injection ratio (0 if never injected). */
  hitRate: number;
  /** Most recent detection score. */
  lastScore: number;
  /** mtime at last scan. */
  mtimeMs: number;
}

/**
 * Configuration for the usage detector.
 */
export interface DetectorConfig {
  /** Keyword-based detection (zero-cost). Default true. */
  keywordEnabled: boolean;
  /**
   * Minimum keyword overlap ratio to classify as "used".
   * 0.2 means at least 20% of extracted keywords must appear.
   * Default 0.2.
   */
  keywordThreshold: number;
  /**
   * Optional sideQuery-based detection for ambiguous cases.
   * When set, scores between lowBound and highBound trigger a
   * classifier call. Default undefined (no sideQuery).
   */
  sideQuery?: {
    /** Scores below this are automatically "unused". Default 0.1. */
    lowBound: number;
    /** Scores above this are automatically "used". Default 0.5. */
    highBound: number;
    /** Async function that runs a cheap classifier. */
    classify: (response: string, memories: MemoryFile[]) => Promise<string[]>;
  };
}

export const DEFAULT_DETECTOR_CONFIG: DetectorConfig = {
  keywordEnabled: true,
  keywordThreshold: 0.2,
};
