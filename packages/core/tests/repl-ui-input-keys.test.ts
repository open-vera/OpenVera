import { describe, expect, it } from "vitest";
import { parseInputChunk, parseInputKey } from "../src/repl/ui/inputKeys.js";

describe("inputKeys", () => {
  it("parses return, tab, escape, and backspace keys", () => {
    expect(parseInputKey("\r").return).toBe(true);
    expect(parseInputKey("\t").tab).toBe(true);
    expect(parseInputKey("\x1b").escape).toBe(true);
    expect(parseInputKey("\x7f").delete).toBe(true);
    expect(parseInputKey("\b").backspace).toBe(true);
  });

  it("parses arrows and page keys", () => {
    expect(parseInputKey("\x1b[A").upArrow).toBe(true);
    expect(parseInputKey("\x1b[B").downArrow).toBe(true);
    expect(parseInputKey("\x1b[C").rightArrow).toBe(true);
    expect(parseInputKey("\x1b[D").leftArrow).toBe(true);
    expect(parseInputKey("\x1b[5~").pageUp).toBe(true);
    expect(parseInputKey("\x1b[6~").pageDown).toBe(true);
  });

  it("parses ctrl and meta input", () => {
    expect(parseInputChunk("\x03")).toMatchObject({ input: "c", key: { ctrl: true } });
    expect(parseInputChunk("\x1bo")).toMatchObject({ input: "o", key: { meta: true } });
    expect(parseInputChunk("\x1b\x1b[D")).toMatchObject({ input: "", key: { leftArrow: true, meta: true } });
  });

  it("returns printable text", () => {
    expect(parseInputChunk("a")).toMatchObject({ input: "a" });
    expect(parseInputChunk("A")).toMatchObject({ input: "A", key: { shift: true } });
    expect(parseInputChunk("中文")).toMatchObject({ input: "中文" });
    expect(parseInputChunk("a\r\nb")).toMatchObject({ input: "a\nb" });
  });
});
