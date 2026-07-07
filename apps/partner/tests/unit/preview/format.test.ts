import { describe, expect, it } from "vitest";
import {
  canFormatLanguage,
  formatPreviewDocument,
  PreviewFormatError,
} from "@/preview/format";

describe("preview/format", () => {
  it("formats json documents with Prettier", async () => {
    await expect(formatPreviewDocument("data.json", "json", '{"b":1,"a":2}')).resolves.toBe(
      '{ "b": 1, "a": 2 }\n',
    );
  });

  it("formats jsonl records without turning them into one json document", async () => {
    await expect(
      formatPreviewDocument(
        "events.jsonl",
        "jsonl",
        '{"event":"ready","ok":true}\n{"count":2,"items":[1,2]}',
      ),
    ).resolves.toBe(
      '{ "event": "ready", "ok": true }\n{ "count": 2, "items": [1, 2] }',
    );
  });

  it("reports the invalid jsonl line number", async () => {
    await expect(
      formatPreviewDocument("events.jsonl", "jsonl", '{"ok":true}\nnot-json'),
    ).rejects.toThrow(PreviewFormatError);
    await expect(
      formatPreviewDocument("events.jsonl", "jsonl", '{"ok":true}\nnot-json'),
    ).rejects.toThrow("第 2 行不是有效 JSON");
  });

  it("only enables languages with a formatter", () => {
    expect(canFormatLanguage("jsonl")).toBe(true);
    expect(canFormatLanguage("typescript")).toBe(true);
    expect(canFormatLanguage("plaintext")).toBe(false);
  });
});
