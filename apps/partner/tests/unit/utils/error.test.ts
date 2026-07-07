import { describe, expect, it } from "vitest";
import { formatErrorMessage } from "@/utils/error";

describe("formatErrorMessage", () => {
  it("returns string errors from Tauri invoke", () => {
    expect(formatErrorMessage("Sidecar 未就绪")).toBe("Sidecar 未就绪");
  });

  it("returns Error message when available", () => {
    expect(formatErrorMessage(new Error("network failed"))).toBe("network failed");
  });

  it("falls back for unknown errors", () => {
    expect(formatErrorMessage({ code: 1 })).toBe("Agent 运行失败");
  });

  it("explains API key scenario mismatch errors", () => {
    const message = formatErrorMessage(
      new Error('403 {"error":"API key scenario mismatch"}'),
    );

    expect(message).toContain("API Key 与所选模型/协议场景不匹配");
    expect(message).toContain("协议是否匹配服务类型");
  });

  it("explains Anthropic cache control limit errors", () => {
    const message = formatErrorMessage(
      '400 {"error":"A maximum of 4 blocks with cache_control may be provided. Found 24."}',
    );

    expect(message).toContain("最多允许 4 个 cache_control");
    expect(message).toContain("请重试本次消息");
  });
});
