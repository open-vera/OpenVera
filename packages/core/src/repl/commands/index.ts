import type { ReplContext } from "../context.js";
import { modelCommand } from "./model.js";
import { helpCommand } from "./help.js";
import { providerCommand } from "./provider.js";
import { sessionsCommand } from "./sessions.js";
import { resumeCommand } from "./resume.js";
import { titleCommand } from "./title.js";

type CommandFn = (args: string[], ctx: ReplContext) => Promise<void>;

const COMMANDS: Record<string, CommandFn> = {
  model: modelCommand,
  provider: providerCommand,
  help: helpCommand,
  sessions: sessionsCommand,
  resume: resumeCommand,
  title: titleCommand,
};

export async function handleCommand(
  cmd: string,
  args: string[],
  ctx: ReplContext
): Promise<void> {
  const handler = COMMANDS[cmd];
  if (!handler) {
    console.log(
      `Unknown command: /${cmd}  (type /help for available commands)`
    );
    return;
  }
  await handler(args, ctx);
}
