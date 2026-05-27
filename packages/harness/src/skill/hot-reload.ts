/**
 * Skill Hot-Reload (SK5)
 *
 * Watches skill directories for file changes and automatically reloads
 * skills without requiring a restart. Supports:
 * - File add/change/delete detection
 * - Debounced reload to avoid rapid successive reloads
 * - Event callbacks for reload notifications
 * - Manual reload triggers
 */

import { watch, type FSWatcher } from "node:fs";
import { loadSkillFile, type BuiltinToolProvider } from "./loader.js";
import type { Skill } from "./types.js";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Events emitted by the hot-reloader. */
export type HotReloadEvent =
  | { type: "loaded"; skillId: string; filePath: string }
  | { type: "unloaded"; skillId: string; filePath: string }
  | { type: "error"; filePath: string; error: string }
  | { type: "reloaded"; loaded: string[]; unloaded: string[] };

/** Callback for hot-reload events. */
export type HotReloadCallback = (event: HotReloadEvent) => void;

/** Configuration for hot-reload. */
export interface HotReloadConfig {
  /** Debounce interval in ms to avoid rapid successive reloads. Default: 300 */
  debounceMs: number;
  /** Whether to watch recursively. Default: false */
  recursive: boolean;
}

const DEFAULT_HOT_RELOAD_CONFIG: HotReloadConfig = {
  debounceMs: 300,
  recursive: false,
};

// ── SkillHotReloader ──────────────────────────────────────────────────────────

export class SkillHotReloader {
  private watchers: Map<string, FSWatcher> = new Map();
  /** filePath → skillId */
  private fileToSkill: Map<string, string> = new Map();
  /** skillId → Skill */
  private loadedSkills: Map<string, Skill> = new Map();
  private callbacks: HotReloadCallback[] = [];
  private config: HotReloadConfig;
  private toolProvider?: BuiltinToolProvider;
  private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  /** Skills that are pinned and should not be hot-reloaded. */
  private pinnedSkills: Set<string> = new Set();

  constructor(
    config?: Partial<HotReloadConfig>,
    toolProvider?: BuiltinToolProvider
  ) {
    this.config = { ...DEFAULT_HOT_RELOAD_CONFIG, ...config };
    this.toolProvider = toolProvider;
  }

  /** Register a callback for reload events. */
  onEvent(callback: HotReloadCallback): void {
    this.callbacks.push(callback);
  }

  /** Pin a skill so it won't be affected by hot-reload. */
  pin(skillId: string): void {
    this.pinnedSkills.add(skillId);
  }

  /** Unpin a skill. */
  unpin(skillId: string): void {
    this.pinnedSkills.delete(skillId);
  }

  /**
   * Start watching a directory for skill file changes.
   * Returns a function to stop watching.
   */
  watch(dirPath: string): () => void {
    if (this.watchers.has(dirPath)) {
      return () => this.unwatch(dirPath);
    }

    try {
      const watcher = watch(
        dirPath,
        { recursive: this.config.recursive },
        (eventType, filename) => {
          if (!filename) return;
          const filePath = `${dirPath}/${filename}`;
          this.handleFileChange(filePath, eventType);
        }
      );

      watcher.on("error", (err) => {
        this.emit({
          type: "error",
          filePath: dirPath,
          error: err.message,
        });
      });

      this.watchers.set(dirPath, watcher);
    } catch (err) {
      this.emit({
        type: "error",
        filePath: dirPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return () => this.unwatch(dirPath);
  }

  /** Stop watching a directory. */
  unwatch(dirPath: string): void {
    const watcher = this.watchers.get(dirPath);
    if (watcher) {
      watcher.close();
      this.watchers.delete(dirPath);
    }
  }

  /** Stop all watchers and clean up. */
  destroy(): void {
    for (const [, watcher] of this.watchers) {
      watcher.close();
    }
    this.watchers.clear();
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }

  /**
   * Manually reload a specific skill file.
   * Returns the loaded skill or null if loading failed.
   */
  reloadFile(filePath: string): Skill | null {
    try {
      const skill = loadSkillFile(filePath, this.toolProvider);

      // Track the mapping
      const oldSkillId = this.fileToSkill.get(filePath);
      if (oldSkillId && oldSkillId !== skill.id) {
        // Skill ID changed — unload old one
        if (!this.pinnedSkills.has(oldSkillId)) {
          this.loadedSkills.delete(oldSkillId);
          this.emit({ type: "unloaded", skillId: oldSkillId, filePath });
        }
      }

      this.fileToSkill.set(filePath, skill.id);
      this.loadedSkills.set(skill.id, skill);
      this.emit({ type: "loaded", skillId: skill.id, filePath });

      return skill;
    } catch (err) {
      this.emit({
        type: "error",
        filePath,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /** Get all currently loaded skills. */
  getLoadedSkills(): Skill[] {
    return [...this.loadedSkills.values()];
  }

  /** Get a specific loaded skill by ID. */
  getSkill(skillId: string): Skill | undefined {
    return this.loadedSkills.get(skillId);
  }

  /** Remove a skill from the loaded set. */
  unloadSkill(skillId: string): boolean {
    if (this.pinnedSkills.has(skillId)) return false;
    const removed = this.loadedSkills.delete(skillId);
    if (removed) {
      // Clean up file mapping
      for (const [filePath, id] of this.fileToSkill) {
        if (id === skillId) {
          this.fileToSkill.delete(filePath);
          break;
        }
      }
      this.emit({ type: "unloaded", skillId, filePath: "" });
    }
    return removed;
  }

  /** Handle a file change event with debouncing. */
  private handleFileChange(filePath: string, eventType: string): void {
    // Only handle .md files
    if (!filePath.endsWith(".md")) return;

    // Clear existing debounce timer for this file
    const existing = this.debounceTimers.get(filePath);
    if (existing) clearTimeout(existing);

    // Debounce
    this.debounceTimers.set(
      filePath,
      setTimeout(() => {
        this.debounceTimers.delete(filePath);
        this.processFileChange(filePath, eventType);
      }, this.config.debounceMs)
    );
  }

  /** Process a debounced file change. */
  private processFileChange(filePath: string, eventType: string): void {
    if (eventType === "rename") {
      // File was deleted or renamed
      const skillId = this.fileToSkill.get(filePath);
      if (skillId && !this.pinnedSkills.has(skillId)) {
        this.loadedSkills.delete(skillId);
        this.fileToSkill.delete(filePath);
        this.emit({ type: "unloaded", skillId, filePath });
      }
    } else {
      // File was changed — reload
      this.reloadFile(filePath);
    }
  }

  /** Emit an event to all registered callbacks. */
  private emit(event: HotReloadEvent): void {
    for (const cb of this.callbacks) {
      try {
        cb(event);
      } catch {
        // Swallow callback errors to not break the reloader
      }
    }
  }
}
