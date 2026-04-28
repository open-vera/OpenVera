import type { ReplContext } from "../context.js";
import { modelCommand } from "./model.js";
import { helpCommand } from "./help.js";
import { providerCommand } from "./provider.js";
import { sessionsCommand } from "./sessions.js";
import { resumeCommand } from "./resume.js";
import { titleCommand } from "./title.js";
import { branchCommand } from "./branch.js";
import { branchesCommand } from "./branches.js";
import { switchCommand } from "./switch.js";
import { dropCommand } from "./drop.js";
import { adoptCommand } from "./adopt.js";
import { tryCommand } from "./try.js";
import { mergeCommand } from "./merge.js";
import { subCommand, transcriptCommand } from "./transcript.js";
import { subjobsCommand } from "./subjobs.js";

type CommandFn = (args: string[], ctx: ReplContext) => Promise<void>;

const COMMANDS: Record<string, CommandFn> = {
  model: modelCommand,
  provider: providerCommand,
  help: helpCommand,
  sessions: sessionsCommand,
  resume: resumeCommand,
  title: titleCommand,
  branch: branchCommand,
  branches: branchesCommand,
  switch: switchCommand,
  drop: dropCommand,
  adopt: adoptCommand,
  try: tryCommand,
  merge: mergeCommand,
  sub: subCommand,
  subjobs: subjobsCommand,
  transcript: transcriptCommand,
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
