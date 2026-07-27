import { describe, expect, it } from "vitest";
import {
  formatRunLogPlaceholder,
  formatRunLogReadFailure,
  formatRunLogTruncationNotice,
} from "@/utils/run-log";

describe("run log utilities", () => {
  it("formats a visible placeholder when the log is not ready", () => {
    const message = formatRunLogPlaceholder(
      "/Users/dev/.vera/partner-runs/-Users-dev-proj",
      new Error("file not found"),
    );

    expect(message).toContain("日志文件尚未生成");
    expect(message).toContain("/Users/dev/.vera/partner-runs/-Users-dev-proj");
    expect(message).toContain("file not found");
  });

  it("omits the details block when no error is supplied", () => {
    const message = formatRunLogPlaceholder("/tmp/logs");

    expect(message).toContain("日志文件尚未生成");
    expect(message).not.toContain("底层读取信息");
  });

  it("formats a read failure with the underlying error", () => {
    const message = formatRunLogReadFailure("/tmp/a.jsonl", new Error("EACCES"));

    expect(message).toContain("日志文件读取失败");
    expect(message).toContain("/tmp/a.jsonl");
    expect(message).toContain("EACCES");
  });

  it("stringifies non-Error read failures", () => {
    const message = formatRunLogReadFailure("/tmp/a.jsonl", "boom");

    expect(message).toContain("boom");
  });

  it("reports how much of a truncated log is shown", () => {
    const notice = formatRunLogTruncationNotice("/tmp/a.jsonl", 400, 12_000);

    expect(notice).toContain("12000 bytes total");
    expect(notice).toContain("showing last 400");
    expect(notice).toContain("/tmp/a.jsonl");
  });
});
