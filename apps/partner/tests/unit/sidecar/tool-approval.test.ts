import { describe, expect, it } from "vitest";
import {
  resolveToolApproval,
  waitForToolApproval,
} from "../../../sidecar/src/tool-approval.js";

describe("sidecar tool-approval", () => {
  it("resolves pending approval with user decision", async () => {
    const callId = "approval-1";
    const pending = waitForToolApproval(callId, 5_000);
    expect(resolveToolApproval(callId, true)).toBe(true);
    await expect(pending).resolves.toBe(true);
  });

  it("returns false when approval is denied", async () => {
    const callId = "approval-2";
    const pending = waitForToolApproval(callId, 5_000);
    expect(resolveToolApproval(callId, false)).toBe(true);
    await expect(pending).resolves.toBe(false);
  });

  it("returns false when approval times out", async () => {
    await expect(waitForToolApproval("approval-3", 20)).resolves.toBe(false);
  });

  it("returns false when resolving unknown approval id", () => {
    expect(resolveToolApproval("missing", true)).toBe(false);
  });
});
