import { describe, expect, it } from "vitest";
import type { ReplContext } from "../src/repl/context.js";
import { captureCommandOutput } from "../src/repl/ui/controller/commandCapture.js";

describe("commandCapture", () => {
  it("captures stdout and stderr from command handlers", async () => {
    const output = await captureCommandOutput(
      "test",
      ["arg"],
      {} as ReplContext,
      async (_cmd, args) => {
        console.log("out", args[0]);
        console.error("err");
      },
    );

    expect(output).toBe("out arg\nerr");
  });

  it("returns null when handler produces no output (overlay opened)", async () => {
    await expect(captureCommandOutput(
      "silent",
      [],
      {} as ReplContext,
      async () => {},
    )).resolves.toBeNull();
  });
});
