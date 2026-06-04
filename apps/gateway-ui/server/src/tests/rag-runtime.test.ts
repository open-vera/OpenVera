import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { searchProjectRag } from "../rag-runtime.js";

describe("searchProjectRag", () => {
  it("finds keyword matches under .vera/rag", async () => {
    const root = mkdtempSync(join(tmpdir(), "gateway-rag-"));
    const ragDir = join(root, ".vera", "rag", "docs");
    mkdirSync(ragDir, { recursive: true });
    writeFileSync(join(ragDir, "note.md"), "Gateway control plane keyword search");

    const result = await searchProjectRag(root, "keyword");
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.mode).toBe("keyword");
  });
});
