import { afterEach, describe, expect, it, vi } from "vitest";
import { copyTextToClipboard } from "@/utils/clipboard";

describe("copyTextToClipboard", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses navigator.clipboard when available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    await copyTextToClipboard("hello markdown");

    expect(writeText).toHaveBeenCalledWith("hello markdown");
  });
});
