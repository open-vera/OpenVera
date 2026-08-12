import { describe, expect, it } from "vitest";
import {
  canPreviewLanguage,
  previewKindForLanguage,
} from "@/preview/markdown-preview";

describe("document preview languages", () => {
  it("maps markdown, HTML, SVG and plaintext to preview kinds", () => {
    expect(previewKindForLanguage("markdown")).toBe("markdown");
    expect(previewKindForLanguage("html")).toBe("html");
    expect(previewKindForLanguage("svg")).toBe("svg");
    expect(previewKindForLanguage("plaintext")).toBe("text");
    expect(previewKindForLanguage("typescript")).toBeNull();
    expect(previewKindForLanguage(null)).toBeNull();
  });

  it("allows markdown, HTML, SVG and plaintext preview", () => {
    expect(canPreviewLanguage("markdown")).toBe(true);
    expect(canPreviewLanguage("html")).toBe(true);
    expect(canPreviewLanguage("svg")).toBe(true);
    expect(canPreviewLanguage("plaintext")).toBe(true);
    expect(canPreviewLanguage("typescript")).toBe(false);
    expect(canPreviewLanguage(null)).toBe(false);
  });
});
