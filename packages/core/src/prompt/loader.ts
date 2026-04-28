import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { PromptTemplate, PromptProfile } from "./types.js";
import type { PromptStore } from "./store.js";

/**
 * Load JSON template files from a directory.
 * Each file should be a single PromptTemplate object or an array of them.
 *
 * Expected layout:
 *   promptsDir/
 *     code-review.json
 *     custom.json
 *     profiles/
 *       my-profile.json
 */
export function loadTemplates(
  store: PromptStore,
  promptsDir: string
): number {
  if (!existsSync(promptsDir)) return 0;

  let count = 0;
  const entries = readdirSync(promptsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;

    try {
      const raw = readFileSync(join(promptsDir, entry.name), "utf-8");
      const parsed = JSON.parse(raw) as unknown;

      const items: PromptTemplate[] = Array.isArray(parsed)
        ? parsed
        : [parsed];

      for (const item of items) {
        if (isTemplate(item)) {
          store.addTemplate(item);
          count++;
        }
      }
    } catch {
      // Skip malformed files
    }
  }

  // Load profiles from subdirectory
  const profilesDir = join(promptsDir, "profiles");
  if (existsSync(profilesDir)) {
    const profileEntries = readdirSync(profilesDir, {
      withFileTypes: true,
    });
    for (const entry of profileEntries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;

      try {
        const raw = readFileSync(join(profilesDir, entry.name), "utf-8");
        const parsed = JSON.parse(raw) as unknown;

        const items: PromptProfile[] = Array.isArray(parsed)
          ? parsed
          : [parsed];

        for (const item of items) {
          if (isProfile(item)) {
            store.addProfile(item);
            count++;
          }
        }
      } catch {
        // Skip malformed files
      }
    }
  }

  return count;
}

// ── Type guards ────────────────────────────────────────────────────────────────

function isTemplate(obj: unknown): obj is PromptTemplate {
  if (!obj || typeof obj !== "object") return false;
  const t = obj as Record<string, unknown>;
  return typeof t.id === "string" && Array.isArray(t.sections);
}

function isProfile(obj: unknown): obj is PromptProfile {
  if (!obj || typeof obj !== "object") return false;
  const p = obj as Record<string, unknown>;
  return (
    typeof p.id === "string" &&
    typeof p.templateId === "string"
  );
}
