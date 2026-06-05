import { describe, expect, it } from "vitest";
import { validatePluginManifest } from "../manifest.js";

describe("validatePluginManifest", () => {
  it("accepts a valid v1 manifest", () => {
    const manifest = validatePluginManifest({
      id: "com.example.valid",
      name: "Valid",
      version: "1.0.0",
      apiVersion: "1",
      entry: "./index.js",
      scope: "project",
      activationEvents: ["onStartup"],
    });

    expect(manifest.id).toBe("com.example.valid");
  });

  it("rejects missing required fields", () => {
    expect(() => validatePluginManifest({ id: "com.example.invalid" })).toThrow(/name/);
  });

  it("rejects incompatible API major versions", () => {
    expect(() =>
      validatePluginManifest({
        id: "com.example.invalid",
        name: "Invalid",
        version: "1.0.0",
        apiVersion: "2",
        entry: "./index.js",
        scope: "project",
        activationEvents: ["onStartup"],
      }),
    ).toThrow(/incompatible/);
  });
});
