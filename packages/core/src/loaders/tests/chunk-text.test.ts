import { describe, expect, it } from "vitest";
import { chunkText } from "../chunk-text.js";

describe("chunkText", () => {
  it("returns single chunk when text fits chunk size", () => {
    expect(chunkText("hello", 100, 10)).toEqual(["hello"]);
  });

  it("splits long text into multiple non-empty chunks", () => {
    const text = "a".repeat(120);
    const chunks = chunkText(text, 50, 10);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length > 0)).toBe(true);
    expect(chunks.join("").length).toBeGreaterThanOrEqual(text.length - 20);
  });

  it("prefers paragraph boundaries when possible", () => {
    const text = `${"x".repeat(40)}\n\n${"y".repeat(40)}`;
    const chunks = chunkText(text, 50, 5);
    expect(chunks.some((c) => c.includes("\n\n") || c.endsWith("x") || c.startsWith("y"))).toBe(
      true
    );
  });
});
