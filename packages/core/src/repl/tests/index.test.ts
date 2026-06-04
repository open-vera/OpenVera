import { afterEach, describe, expect, it, vi } from "vitest";
import { startRepl } from "../index.js";
import type { ReplContext } from "../context.js";

const { render } = vi.hoisted(() => ({
  render: vi.fn(),
}));

vi.mock("ink", () => ({
  render,
}));

const isTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const setRawModeDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");

function restoreStdin(): void {
  if (isTTYDescriptor) {
    Object.defineProperty(process.stdin, "isTTY", isTTYDescriptor);
  }
  if (setRawModeDescriptor) {
    Object.defineProperty(process.stdin, "setRawMode", setRawModeDescriptor);
  } else {
    Reflect.deleteProperty(process.stdin, "setRawMode");
  }
}

describe("startRepl", () => {
  afterEach(() => {
    restoreStdin();
    vi.clearAllMocks();
  });

  it("fails fast when stdin is not an interactive TTY", async () => {
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
    Object.defineProperty(process.stdin, "setRawMode", { configurable: true, value: undefined });

    await expect(startRepl({} as ReplContext)).rejects.toThrow("REPL requires an interactive TTY");
    expect(render).not.toHaveBeenCalled();
  });
});
