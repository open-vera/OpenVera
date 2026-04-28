import type {
  DetectorConfig,
  MemoryFile,
  UsageDetectionResult,
} from "./types.js";

// Common English stop words to filter out of keyword extraction.
const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been",
  "being", "have", "has", "had", "do", "does", "did", "will",
  "would", "could", "should", "may", "might", "can", "shall",
  "to", "of", "in", "for", "on", "with", "at", "by", "from",
  "as", "into", "through", "during", "before", "after",
  "and", "but", "or", "nor", "not", "so", "yet", "both",
  "this", "that", "these", "those", "it", "its", "he", "she",
  "they", "them", "we", "you", "i", "my", "your", "our",
  "about", "up", "out", "if", "then", "than", "too", "very",
  "just", "also", "now", "here", "there", "when", "where",
  "how", "all", "each", "every", "which", "what", "who",
]);

// Characters to strip when extracting keywords.
const TOKEN_SEPARATORS = /[\s,./;:'"!?()[\]{}<>|\\\-_+=@#$%^&*~`]+/;

/**
 * Extract meaningful lowercase keywords from a text string.
 * Filters out stop words and short tokens.
 */
function extractKeywords(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .split(TOKEN_SEPARATORS)
    .filter((t) => t.length >= 3 && !STOP_WORDS.has(t));

  // Deduplicate while preserving order
  return [...new Set(tokens)];
}

/**
 * Build a keyword list for a memory file from its description and filename.
 * The filename is de-suffixed (.md removed, path separators stripped) and
 * used as an additional source of keywords.
 */
function memoryKeywords(memory: MemoryFile): string[] {
  const sources: string[] = [];
  if (memory.description) sources.push(memory.description);
  // Also use the filename stem as a keyword source
  const stem = memory.filename
    .replace(/\.md$/, "")
    .replace(/[/\\]/g, " ")
    .replace(/[-_]/g, " ");
  sources.push(stem);
  return extractKeywords(sources.join(" "));
}

/**
 * Compute a keyword-overlap score for one memory file against the
 * assistant's response text.
 *
 * Returns a score 0–1 representing the fraction of memory keywords
 * found in the response.
 */
function keywordScore(
  response: string,
  memory: MemoryFile,
): { score: number; matched: string[] } {
  const keywords = memoryKeywords(memory);
  if (keywords.length === 0) return { score: 0, matched: [] };

  const lowerResponse = response.toLowerCase();
  const matched = keywords.filter((kw) => lowerResponse.includes(kw));
  return { score: matched.length / keywords.length, matched };
}

/**
 * Run keyword-based detection for a batch of memory files.
 * Returns raw results without thresholding (scoring only).
 */
function keywordDetect(
  response: string,
  memories: MemoryFile[],
): UsageDetectionResult[] {
  return memories.map((memory) => {
    const { score, matched } = keywordScore(response, memory);
    return {
      path: memory.path,
      used: false, // will be set after thresholding
      score,
      matchedKeywords: matched,
    };
  });
}

/**
 * Apply threshold / sideQuery escalation to raw detection results.
 * Mutates the `used` field on each result entry.
 */
async function classifyResults(
  results: UsageDetectionResult[],
  memories: MemoryFile[],
  response: string,
  config: DetectorConfig,
): Promise<void> {
  const byPath = new Map(memories.map((m) => [m.path, m]));

  for (const result of results) {
    if (result.score >= config.keywordThreshold) {
      result.used = true;
      continue;
    }

    // Below threshold: if sideQuery is configured and score is in
    // the ambiguous zone, escalate.
    if (config.sideQuery) {
      const { lowBound, highBound, classify } = config.sideQuery;
      // Already above highBound would have hit the threshold branch.
      if (result.score >= lowBound && result.score < config.keywordThreshold) {
        // Ambiguous — will be resolved in batch below
        continue;
      }
    }

    result.used = false;
  }

  // Batch sideQuery for ambiguous results
  if (config.sideQuery) {
    const ambiguous = results.filter(
      (r) =>
        !r.used &&
        r.score >= config.sideQuery!.lowBound &&
        r.score < config.keywordThreshold,
    );

    if (ambiguous.length > 0) {
      const ambigMemories = ambiguous
        .map((r) => byPath.get(r.path))
        .filter((m): m is MemoryFile => m !== undefined);

      const usedPaths = await config.sideQuery.classify(response, ambigMemories);
      const usedSet = new Set(usedPaths);

      for (const result of ambiguous) {
        if (usedSet.has(result.path)) {
          result.used = true;
          result.score = Math.max(result.score, config.keywordThreshold);
        }
      }
    }
  }
}

/**
 * Detect which injected memory files were actually used in the
 * assistant's response.
 *
 * Strategy (configurable via DetectorConfig):
 * 1. Extract keywords from each memory's description + filename
 * 2. Score keyword overlap against the response text
 * 3. Apply threshold: score >= threshold → "used"
 * 4. Optionally escalate ambiguous scores to a sideQuery classifier
 */
export async function detectUsage(
  response: string,
  memories: MemoryFile[],
  config: DetectorConfig = { keywordEnabled: true, keywordThreshold: 0.2 },
): Promise<UsageDetectionResult[]> {
  if (!config.keywordEnabled || memories.length === 0) {
    return memories.map((m) => ({
      path: m.path,
      used: false,
      score: 0,
      matchedKeywords: [],
    }));
  }

  const results = keywordDetect(response, memories);
  await classifyResults(results, memories, response, config);
  return results;
}

// Re-export for external use
export { extractKeywords, memoryKeywords };
