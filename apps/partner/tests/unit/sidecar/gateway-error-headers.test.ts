import { describe, expect, it } from "vitest";
import {
  appendGatewayErrorHeaders,
  extractGatewayErrorHeaders,
  formatGatewayErrorHeaders,
} from "../../../sidecar/src/gateway-error-headers.js";

describe("gateway-error-headers", () => {
  it("extracts gw-* and x-gw-* from Headers-like objects", () => {
    const headers = new Headers({
      "content-type": "application/json",
      "gw-request-id": "req-123",
      "X-Gw-Error-Code": "quota_exceeded",
      "x-request-id": "ignore-me",
    });
    expect(extractGatewayErrorHeaders({ headers })).toEqual({
      "gw-request-id": "req-123",
      "x-gw-error-code": "quota_exceeded",
    });
  });

  it("extracts from plain header maps", () => {
    expect(
      extractGatewayErrorHeaders({
        headers: {
          "gw-trace": "abc",
          authorization: "secret",
        },
      }),
    ).toEqual({ "gw-trace": "abc" });
  });

  it("returns empty when headers are missing", () => {
    expect(extractGatewayErrorHeaders(new Error("boom"))).toEqual({});
    expect(extractGatewayErrorHeaders(null)).toEqual({});
  });

  it("formats and appends a gateway header block", () => {
    const block = formatGatewayErrorHeaders({
      "gw-request-id": "req-9",
      "gw-error": "denied",
    });
    expect(block).toContain("网关 Headers：");
    expect(block).toContain("gw-error: denied");
    expect(block).toContain("gw-request-id: req-9");

    const message = appendGatewayErrorHeaders("429 rate limited", {
      headers: { "gw-request-id": "req-9" },
    });
    expect(message).toBe("429 rate limited\n\n网关 Headers：\ngw-request-id: req-9");
    expect(appendGatewayErrorHeaders(message, { headers: { "gw-request-id": "req-9" } })).toBe(
      message,
    );
  });
});
