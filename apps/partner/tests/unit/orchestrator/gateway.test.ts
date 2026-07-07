import { describe, expect, it } from "vitest";
import { Gateway } from "@/orchestrator/gateway";

describe("Gateway", () => {
  it("respects maxInstances limit", () => {
    const gateway = new Gateway(2);
    const first = gateway.createInstance("s1");
    const second = gateway.createInstance("s2");
    const third = gateway.createInstance("s3");

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(third).toBeNull();
    expect(gateway.status().activeInstances).toBe(0);
  });
});
