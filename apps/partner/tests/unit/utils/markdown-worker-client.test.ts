import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MARKDOWN_WORKER_THRESHOLD_CHARS,
  renderMarkdownAsync,
  resetMarkdownWorkerForTests,
} from "@/utils/markdown-worker-client";

describe("renderMarkdownAsync", () => {
  afterEach(() => {
    resetMarkdownWorkerForTests();
    vi.unstubAllGlobals();
  });

  it("renders small content synchronously without requiring a Worker", async () => {
    const html = await renderMarkdownAsync("hello **world**");
    expect(html).toContain("<strong>world</strong>");
  });

  it("uses Worker for large content when available", async () => {
    class FakeWorker {
      onmessage: ((event: MessageEvent<{ id: number; html?: string }>) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      postMessage(data: { id: number; source: string }) {
        queueMicrotask(() => {
          this.onmessage?.({
            data: {
              id: data.id,
              html: `<p>${data.source.slice(0, 12)}…</p>`,
            },
          } as MessageEvent<{ id: number; html?: string }>);
        });
      }
      terminate() {}
    }

    vi.stubGlobal("Worker", FakeWorker);
    vi.stubGlobal("URL", class {
      constructor(public href: string) {}
    });

    const source = "x".repeat(MARKDOWN_WORKER_THRESHOLD_CHARS + 10);
    const html = await renderMarkdownAsync(source);
    expect(html).toContain("<p>xxxxxxxxxxxx…</p>");
  });
});
