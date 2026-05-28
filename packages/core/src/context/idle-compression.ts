/**
 * IdleCompressionTimer — OC5-OC7
 *
 * Automatically triggers context compression when the agent has been idle
 * for a configurable duration (default: 314 seconds, under the 5-minute
 * prompt cache TTL).
 *
 * OC5: Timer fires after idle threshold, triggering compression via callback.
 * OC6: New user input cancels any in-progress compression, ensuring consistency.
 * OC7: Compression results are persisted via the onCompressed callback.
 */
import type { Message } from "../types/index.js";
import type { LLMAdapter } from "../adapters/base.js";
import type { CompressionOptions, CompressionState } from "./compression.js";
import {
  compressMessages,
  createCompressionState,
} from "./compression.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface IdleCompressionOptions {
  /**
   * Idle duration in milliseconds before compression triggers.
   * Default: 314_000 (314 seconds — safely under 5-min cache TTL).
   */
  idleMs?: number;

  /**
   * Compression settings passed to compressMessages.
   * `enabled` is always treated as true when the timer fires.
   */
  compression: CompressionOptions;

  /**
   * LLM adapter used for compression. Required.
   */
  adapter: LLMAdapter;

  /**
   * Model name for compression. Defaults to compression.model or "unknown".
   */
  model: string;

  /**
   * Called after successful compression. Use this to persist the
   * compressed messages and updated state (e.g., save session).
   * OC7: Compression results persisted via this callback.
   */
  onCompressed: (result: IdleCompressionResult) => void | Promise<void>;

  /**
   * Called when compression is interrupted by new user input.
   * OC6: Ensures history consistency by aborting in-flight compression.
   */
  onCancelled?: () => void;
}

export interface IdleCompressionResult {
  /** Messages after compression (old turns replaced by synthetic summary). */
  messages: Message[];
  /** Updated compression state with new segment. */
  state: CompressionState;
  /** Whether compression actually occurred (false if under threshold). */
  compressed: boolean;
}

export type IdleCompressionStatus =
  | "idle"      // Timer is running, waiting for idle threshold
  | "running"   // Compression is in progress
  | "paused"    // Timer paused (new input arrived)
  | "stopped"   // Timer destroyed / not started
  | "fired"     // Compression completed successfully
  | "cancelled" // Compression was interrupted by new input
  | "error";    // Compression failed

// ── IdleCompressionTimer ───────────────────────────────────────────────────

export class IdleCompressionTimer {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private status: IdleCompressionStatus = "stopped";
  private currentAbort: AbortController | null = null;
  private compressionState: CompressionState;
  private readonly idleMs: number;
  private readonly opts: IdleCompressionOptions;

  constructor(options: IdleCompressionOptions) {
    this.opts = options;
    this.idleMs = options.idleMs ?? 314_000;
    this.compressionState = createCompressionState();
  }

  /** Current timer status. */
  getStatus(): IdleCompressionStatus {
    return this.status;
  }

  /** Get the current compression state. */
  getCompressionState(): CompressionState {
    return this.compressionState;
  }

  /**
   * Set the compression state (e.g., when restoring from a saved session).
   */
  setCompressionState(state: CompressionState): void {
    this.compressionState = state;
  }

  /**
   * Start the idle timer. Call this after the agent finishes responding.
   * OC5: Timer fires after `idleMs` of inactivity.
   */
  start(messages: Message[]): void {
    this.cancel();
    this.status = "idle";

    this.timer = setTimeout(() => {
      void this.fire(messages);
    }, this.idleMs);
  }

  /**
   * Reset the idle timer. Call this when new user input arrives.
   * OC6: Cancels any in-progress compression, ensuring history consistency.
   */
  reset(): void {
    this.cancel();
    this.status = "cancelled";
    this.opts.onCancelled?.();
  }

  /**
   * Stop and destroy the timer. Call this on session end.
   */
  destroy(): void {
    this.reset();
    this.status = "stopped";
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  /** Clear timer and abort in-flight compression without changing status. */
  private cancel(): void {
    if (this.currentAbort) {
      this.currentAbort.abort();
      this.currentAbort = null;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async fire(messages: Message[]): Promise<void> {
    this.timer = null;
    this.currentAbort = new AbortController();
    this.status = "running";

    try {
      const result = await compressMessages(
        messages,
        this.compressionState,
        { ...this.opts.compression, enabled: true },
        this.opts.adapter,
        this.opts.model,
      );

      // Check if aborted during API call
      if (this.currentAbort?.signal.aborted) return;

      if (result.messages !== messages) {
        this.compressionState = result.state;
        this.status = "fired";
        await this.opts.onCompressed({
          messages: result.messages,
          state: result.state,
          compressed: true,
        });
      } else {
        this.status = "fired";
        await this.opts.onCompressed({
          messages,
          state: this.compressionState,
          compressed: false,
        });
      }
    } catch (err) {
      if (this.currentAbort?.signal.aborted) return;
      this.status = "error";
    } finally {
      this.currentAbort = null;
    }
  }
}
