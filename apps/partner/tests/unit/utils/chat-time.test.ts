import { describe, expect, it } from "vitest";
import { formatChatTime, shouldShowChatTime } from "@/utils/chat-time";

describe("chat-time", () => {
  it("shows a separator for the first message and after five minutes", () => {
    const base = new Date("2026-07-07T09:00:00").getTime();

    expect(shouldShowChatTime(null, base)).toBe(true);
    expect(shouldShowChatTime(base, base + 4 * 60 * 1000)).toBe(false);
    expect(shouldShowChatTime(base, base + 5 * 60 * 1000)).toBe(true);
  });

  it("formats today's messages as clock time", () => {
    expect(
      formatChatTime(
        new Date("2026-07-07T09:05:00").getTime(),
        new Date("2026-07-07T17:30:00"),
      ),
    ).toBe("09:05");
  });

  it("formats same-year older messages with month and day", () => {
    expect(
      formatChatTime(
        new Date("2026-07-06T21:08:00").getTime(),
        new Date("2026-07-07T17:30:00"),
      ),
    ).toBe("7月6日 21:08");
  });

  it("formats cross-year messages with year", () => {
    expect(
      formatChatTime(
        new Date("2025-12-31T23:59:00").getTime(),
        new Date("2026-07-07T17:30:00"),
      ),
    ).toBe("2025年12月31日 23:59");
  });
});
