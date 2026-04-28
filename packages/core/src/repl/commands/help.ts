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
  /sub <id-prefix>       View a subagent transcript preview
  /subjobs [job-prefix]  Show background subagent jobs or one job detail
  /branch [name]         Fork the current session and continue in the branch
  /try [name]            Fork into an isolated git worktree and continue there
  /branches              List branches forked from the active session
  /adopt <id-prefix>     Adopt a branch and continue from that route
  /merge [--check] [--drop] [id-prefix]
                         Apply try branch changes back to the original workspace
  /switch <id-prefix>    Switch to a session or branch by ID prefix
  /drop <id-prefix>      Discard a branch by ID prefix
  /title <name>          Set a title for the current session
  /model [provider...]   List models from all (or specified) providers
  /provider              Show configured providers
  /help                  Show this help
  /exit, /quit           Exit

Type any message to chat with the agent.
`);
}
