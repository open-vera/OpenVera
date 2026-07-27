import { recordPerfEvent } from "@/perf/recorder.js";
import type { MarkdownWorkerRequest, MarkdownWorkerResponse } from "./markdown.worker.js";
import { renderMarkdown } from "./markdown.js";

/** Render on a worker when content is large enough to risk janking the UI thread. */
export const MARKDOWN_WORKER_THRESHOLD_CHARS = 2_000;

type Pending = {
  resolve: (html: string) => void;
  reject: (error: Error) => void;
};

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();
let workerFailed = false;

function ensureWorker(): Worker | null {
  if (workerFailed) return null;
  if (worker) return worker;
  if (typeof Worker === "undefined") {
    workerFailed = true;
    return null;
  }
  try {
    worker = new Worker(new URL("./markdown.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (event: MessageEvent<MarkdownWorkerResponse>) => {
      const job = pending.get(event.data.id);
      if (!job) return;
      pending.delete(event.data.id);
      if (event.data.error) {
        job.reject(new Error(event.data.error));
        return;
      }
      job.resolve(event.data.html ?? "");
    };
    worker.onerror = () => {
      workerFailed = true;
      for (const [, job] of pending) {
        job.reject(new Error("Markdown worker failed"));
      }
      pending.clear();
      worker?.terminate();
      worker = null;
    };
    return worker;
  } catch {
    workerFailed = true;
    return null;
  }
}

/**
 * Render markdown off the UI thread when possible.
 * Falls back to sync renderMarkdown if Worker is unavailable.
 */
export function renderMarkdownAsync(source: string): Promise<string> {
  const started = performance.now();
  const finish = (html: string, via: "sync" | "worker" | "fallback") => {
    const durationMs = Math.round(performance.now() - started);
    if (durationMs >= 50 || source.length >= MARKDOWN_WORKER_THRESHOLD_CHARS) {
      recordPerfEvent({
        kind: durationMs >= 500 ? "freeze" : "slow_op",
        severity: durationMs >= 500 ? "error" : durationMs >= 50 ? "warn" : "info",
        durationMs,
        name: "markdown.render",
        detail: `${via} ${source.length} chars → ${html.length} html chars`,
        meta: { via, sourceChars: source.length, htmlChars: html.length },
      });
    }
    return html;
  };

  if (source.length < MARKDOWN_WORKER_THRESHOLD_CHARS) {
    return Promise.resolve(finish(renderMarkdown(source), "sync"));
  }

  const active = ensureWorker();
  if (!active) {
    return Promise.resolve(finish(renderMarkdown(source), "fallback"));
  }

  const id = nextId++;
  return new Promise<string>((resolve, reject) => {
    pending.set(id, {
      resolve: (html) => resolve(finish(html, "worker")),
      reject,
    });
    const request: MarkdownWorkerRequest = { id, source };
    active.postMessage(request);
  });
}

/** Test helper — tear down singleton worker between cases. */
export function resetMarkdownWorkerForTests(): void {
  worker?.terminate();
  worker = null;
  workerFailed = false;
  pending.clear();
  nextId = 1;
}
