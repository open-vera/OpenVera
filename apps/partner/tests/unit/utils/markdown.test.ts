import { describe, expect, it } from "vitest";
import { renderMarkdown } from "@/utils/markdown";

describe("renderMarkdown", () => {
  it("renders common markdown blocks", () => {
    const html = renderMarkdown("**Hello**\n\n- one\n- two");

    expect(html).toContain("<strong>Hello</strong>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>one</li>");
  });

  it("escapes raw html", () => {
    const html = renderMarkdown("<script>alert(1)</script>");

    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("removes chat separator lines", () => {
    const html = renderMarkdown("first\n\n---\n\nsecond\n\n------");

    expect(html).toContain("first");
    expect(html).toContain("second");
    expect(html).not.toContain("<hr");
    expect(html).not.toContain("------");
  });

  it("keeps separator-like lines inside code fences", () => {
    const html = renderMarkdown("```yaml\n---\nkey: value\n```");

    expect(html).toContain("---");
    expect(html).toContain("key: value");
  });
});
