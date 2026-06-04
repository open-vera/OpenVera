/**
 * Shared fixtures for WeCom channel tests.
 */
import { vi } from "vitest";

export const baseConfig = {
  corpId: "wx00000000000000",
  corpSecret: "00000000000000000000000000000000",
  agentId: 1000002,
  token: "00000000000000000000000000",
  encodingAesKey: "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
};

export const mockApiFetch = vi.fn();

export function mockTokenResponse(token = "00000000000000000000000000000000", expiresIn = 7200) {
  return {
    ok: true,
    json: () =>
      Promise.resolve({
        errcode: 0,
        errmsg: "ok",
        access_token: token,
        expires_in: expiresIn,
      }),
  };
}

export function mockSendMessageResponse() {
  return {
    ok: true,
    json: () =>
      Promise.resolve({
        errcode: 0,
        errmsg: "ok",
      }),
  };
}

export const originalFetch = globalThis.fetch;

vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
  const urlStr =
    typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
  if (urlStr.includes("qyapi.weixin.qq.com") || urlStr.includes("/cgi-bin/")) {
    return mockApiFetch(url, init);
  }
  return originalFetch(url, init);
});
