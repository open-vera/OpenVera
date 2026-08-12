import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  HOST_EVENT,
  HOST_PATCH_EVENT,
  HOST_PATCH_SECTIONS,
  HOST_PROTOCOL_VERSION,
} from "@/shell/types";

describe("shell host protocol constants", () => {
  it("matches Rust host protocol v1 event names", () => {
    expect(HOST_PROTOCOL_VERSION).toBe(1);
    expect(HOST_PATCH_EVENT).toBe("host:patch");
    expect(HOST_EVENT).toBe("host:event");
  });

  // A section name the Shell doesn't know would be dropped from the merge and
  // leave that part of the doc frozen, so the two lists must stay identical.
  it("declares the same omittable sections as the Rust host", () => {
    const statePath = fileURLToPath(
      new URL("../../../src-tauri/src/host/state.rs", import.meta.url),
    );
    const source = readFileSync(statePath, "utf8");
    const names = ["SECTION_SESSIONS", "SECTION_PROJECTS", "SECTION_PROJECT_RUNTIME"].map(
      (constant) => {
        const match = new RegExp(
          `pub const ${constant}: &str = "([^"]+)"`,
        ).exec(source);
        return match?.[1];
      },
    );
    const listed = /pub const PATCH_SECTIONS: \[&str; (\d+)\]/.exec(source);
    expect(listed?.[1]).toBe(String(HOST_PATCH_SECTIONS.length));
    expect(names).toEqual([...HOST_PATCH_SECTIONS]);
  });
});
