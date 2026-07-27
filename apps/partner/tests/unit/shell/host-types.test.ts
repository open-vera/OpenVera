import { describe, expect, it } from "vitest";
import { HOST_EVENT, HOST_PATCH_EVENT, HOST_PROTOCOL_VERSION } from "@/shell/types";

describe("shell host protocol constants", () => {
  it("matches Rust host protocol v1 event names", () => {
    expect(HOST_PROTOCOL_VERSION).toBe(1);
    expect(HOST_PATCH_EVENT).toBe("host:patch");
    expect(HOST_EVENT).toBe("host:event");
  });
});
