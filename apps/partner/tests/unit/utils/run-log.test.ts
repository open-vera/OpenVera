import { describe, expect, it } from "vitest";
import {
  buildPartnerRunLogPath,
  formatPartnerRunLogEntry,
  formatRunLogPlaceholder,
} from "@/utils/run-log";

describe("run log utilities", () => {
  it("builds the daily partner run log path", () => {
    const date = new Date("2026-07-07T08:30:00.000Z");

    expect(buildPartnerRunLogPath("/workspace/project/", date)).toBe(
      "/workspace/project/.vera/partner-runs/2026-07-07.jsonl",
    );
  });

  it("formats a visible placeholder when the log is not ready", () => {
    const message = formatRunLogPlaceholder(
      "/workspace/project/.vera/partner-runs/2026-07-07.jsonl",
      new Error("file not found"),
    );

    expect(message).toContain("日志文件尚未生成");
    expect(message).toContain("/workspace/project/.vera/partner-runs/2026-07-07.jsonl");
    expect(message).toContain("file not found");
  });

  it("formats JSONL entries for user input events", () => {
    const line = formatPartnerRunLogEntry(
      {
        event: "user_message",
        messagePreview: "hi",
      },
      new Date("2026-07-07T08:55:00.000Z"),
    );

    expect(JSON.parse(line)).toEqual({
      timestamp: "2026-07-07T08:55:00.000Z",
      event: "user_message",
      messagePreview: "hi",
    });
    expect(line.endsWith("\n")).toBe(true);
  });
});
