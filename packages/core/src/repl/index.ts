import { render } from "ink";
import React from "react";
import { App } from "./ui/App.js";
import type { ReplContext } from "./context.js";

export { type ReplContext } from "./context.js";

function assertInteractiveInput(): void {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    throw new Error("REPL requires an interactive TTY. Use single-shot mode for piped or non-interactive execution.");
  }
}

export async function startRepl(ctx: ReplContext, resumeSessionId?: string): Promise<void> {
  assertInteractiveInput();

  process.stdin.on("error", (err) => {
    if ((err as NodeJS.ErrnoException).code === "EIO") process.exit(0);
  });
  process.on("SIGTERM", () => process.exit(0));

  const { waitUntilExit } = render(
    React.createElement(App, { ctx, resumeSessionId }),
    { stdin: process.stdin, stdout: process.stdout, exitOnCtrlC: false }
  );

  await waitUntilExit();
}
