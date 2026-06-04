/**
 * Shared helpers for ContentUploader tests.
 */

import { vi } from "vitest";
import type { ObjectStore } from "../object-store.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

export function createMockStore(): ObjectStore {
  return {
    name: "mock",
    put: vi.fn().mockResolvedValue({
      key: "content/test.txt",
      size: 12,
      contentType: "text/plain",
      lastModified: new Date(),
      metadata: {},
    }),
    get: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
    list: vi.fn(),
    exists: vi.fn(),
    head: vi.fn(),
    presignUrl: vi.fn().mockResolvedValue("https://example.com/content/test.txt?sign=abc"),
    close: vi.fn(),
  };
}

