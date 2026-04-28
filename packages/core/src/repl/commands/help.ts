import type { ReplContext } from "../context.js";

export async function helpCommand(
  _args: string[],
  _ctx: ReplContext
): Promise<void> {
  console.log(`
Commands:
  /status                Show current provider, model, token usage and cost
  /sessions [--all]      List saved sessions for this project (--all: all projects)
  /resume [id-prefix]    Resume a previous session by ID prefix
  /title <name>          Set a title for the current session
  /model [provider...]   List models from all (or specified) providers
  /provider              Show configured providers
  /help                  Show this help
  /exit, /quit           Exit

Type any message to chat with the agent.
`);
}
