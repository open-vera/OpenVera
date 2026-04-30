import { describe, expect, it } from "vitest";
import { findCommandMeta, isKnownCommand, REPL_COMMANDS } from "../src/repl/commands/metadata.js";

describe("REPL command metadata", () => {
  it("contains unique command names", () => {
    const names = REPL_COMMANDS.map((command) => command.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("marks UI-only commands separately from runtime commands", () => {
    expect(findCommandMeta("diff")).toMatchObject({ name: "diff", surface: "ui" });
    expect(findCommandMeta("status")).toMatchObject({ name: "status", surface: "ui" });
    expect(findCommandMeta("resume")).toMatchObject({ name: "resume", surface: "runtime" });
  });

  it("supports aliases", () => {
    expect(findCommandMeta("quit")).toMatchObject({ name: "exit", surface: "process" });
    expect(isKnownCommand("quit")).toBe(true);
    expect(isKnownCommand("missing")).toBe(false);
  });
});
