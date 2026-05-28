/**
 * MemoryUpdater — OC9
 *
 * Post-task memory update agent. After a task completes, analyzes the session
 * transcript to extract and persist high-value memories. Only triggers when
 * the session had ≥ `minTurns` turns (default: 10) to avoid overhead on
 * short interactions.
 *
 * Flow:
 *   1. Check turn count — skip if < minTurns
 *   2. Extract candidate memories from transcript
 *   3. LLM decides merge strategy (new / update / discard)
 *   4. Apply changes to MemoryStore
 */

import type { LLMAdapter } from "../adapters/base.js";
import type { Message } from "../types/index.js";
import type { MemoryStore } from "./store.js";
import type { MergeDecision, MergeStrategyResult } from "./merge-strategy.js";
import { runMergeStrategy } from "./merge-strategy.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface MemoryUpdaterOptions {
  /** Minimum turns in session to trigger memory update. Default: 10 */
  minTurns?: number;
  /** LLM adapter for merge strategy analysis */
  adapter: LLMAdapter;
  /** Model to use for merge analysis */
  model: string;
  /** Memory store to update */
  store: MemoryStore;
  /** Optional callback after update completes */
  onUpdate?: (result: MemoryUpdateResult) => void;
}

export interface MemoryUpdateResult {
  /** Whether the update was triggered (false if below turn threshold) */
  triggered: boolean;
  /** Number of new memories created */
  created: number;
  /** Number of existing memories updated */
  updated: number;
  /** Number of memories discarded */
  discarded: number;
  /** Merge decisions made */
  decisions: MergeDecision[];
}

// ── MemoryUpdater ──────────────────────────────────────────────────────────

export class MemoryUpdater {
  private readonly minTurns: number;
  private readonly adapter: LLMAdapter;
  private readonly model: string;
  private readonly store: MemoryStore;
  private readonly onUpdate?: (result: MemoryUpdateResult) => void;

  constructor(options: MemoryUpdaterOptions) {
    this.minTurns = options.minTurns ?? 10;
    this.adapter = options.adapter;
    this.model = options.model;
    this.store = options.store;
    this.onUpdate = options.onUpdate;
  }

  /**
   * Count user turns in a message list.
   * A "turn" = one user message (messages with role "user").
   */
  countTurns(messages: Message[]): number {
    return messages.filter((m) => m.role === "user").length;
  }

  /**
   * Run the memory update process. Skips if turn count < minTurns.
   */
  async update(messages: Message[]): Promise<MemoryUpdateResult> {
    const turnCount = this.countTurns(messages);

    if (turnCount < this.minTurns) {
      return {
        triggered: false,
        created: 0,
        updated: 0,
        discarded: 0,
        decisions: [],
      };
    }

    // Extract transcript text from messages
    const transcript = this.extractTranscript(messages);

    // Get existing memories for merge context
    const existingSemantic = this.store.getSemantic();
    const existingEpisodic = this.store.getEpisodic();

    // Run LLM-based merge strategy
    const mergeResult = await runMergeStrategy(
      transcript,
      existingSemantic,
      existingEpisodic,
      this.adapter,
      this.model,
    );

    // Apply merge decisions
    let created = 0;
    let updated = 0;
    let discarded = 0;

    for (const decision of mergeResult.decisions) {
      switch (decision.action) {
        case "create":
          this.store.addSemantic(
            decision.key,
            decision.value,
            decision.tags ?? ["auto-extracted"],
            "memory-updater",
            decision.importance ?? 0.7,
          );
          created++;
          break;

        case "update":
          if (decision.existingKey) {
            this.store.addSemantic(
              decision.existingKey,
              decision.value,
              decision.tags ?? [],
              "memory-updater",
              decision.importance ?? 0.7,
            );
            updated++;
          }
          break;

        case "discard":
          if (decision.existingKey) {
            this.store.removeSemantic(decision.existingKey);
            discarded++;
          }
          break;
      }
    }

    // Also record an episodic entry for the task
    if (created + updated > 0) {
      const summary = mergeResult.summary ?? "Task completed";
      const lessons = mergeResult.decisions
        .filter((d) => d.action === "create")
        .map((d) => d.key)
        .slice(0, 5);
      this.store.addEpisodic(
        summary,
        `Updated ${created} new, ${updated} existing memories`,
        lessons,
        ["auto-updated"],
      );
    }

    const result: MemoryUpdateResult = {
      triggered: true,
      created,
      updated,
      discarded,
      decisions: mergeResult.decisions,
    };

    this.onUpdate?.(result);
    return result;
  }

  /**
   * Extract a plain-text transcript from messages for LLM analysis.
   */
  private extractTranscript(messages: Message[]): string {
    const lines: string[] = [];
    for (const msg of messages) {
      if (msg.role === "user" || msg.role === "assistant") {
        const text = typeof msg.content === "string"
          ? msg.content
          : msg.content
              .filter((p): p is { type: "text"; text: string } => p.type === "text")
              .map((p) => p.text)
              .join("\n");
        if (text.trim()) {
          lines.push(`[${msg.role}]: ${text}`);
        }
      }
    }
    return lines.join("\n\n");
  }
}
