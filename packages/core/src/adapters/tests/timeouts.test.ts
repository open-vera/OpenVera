import { describe, expect, it } from "vitest";
import {
  DEFAULT_LLM_REQUEST_TIMEOUT_MS,
  resolveLlmRequestTimeoutMs,
} from "../timeouts.js";

describe("resolveLlmRequestTimeoutMs", () => {
  it("falls back to the default when unset", () => {
    expect(resolveLlmRequestTimeoutMs({})).toBe(DEFAULT_LLM_REQUEST_TIMEOUT_MS);
  });

  it("accepts an override", () => {
    expect(resolveLlmRequestTimeoutMs({ VERA_LLM_TIMEOUT_MS: "45000" })).toBe(
      45_000
    );
  });

  it("floors fractional overrides", () => {
    expect(resolveLlmRequestTimeoutMs({ VERA_LLM_TIMEOUT_MS: "1500.9" })).toBe(
      1500
    );
  });

  it("ignores blank, non-numeric and non-positive values", () => {
    for (const value of ["", "   ", "abc", "0", "-1", "NaN", "Infinity"]) {
      expect(resolveLlmRequestTimeoutMs({ VERA_LLM_TIMEOUT_MS: value })).toBe(
        DEFAULT_LLM_REQUEST_TIMEOUT_MS
      );
    }
  });

  it("keeps the default at two minutes so slow gateways still finish", () => {
    expect(DEFAULT_LLM_REQUEST_TIMEOUT_MS).toBe(120_000);
  });
});
