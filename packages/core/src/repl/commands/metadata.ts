export type CommandSurface = "ui" | "runtime" | "process";

export interface ReplCommandMeta {
  name: string;
  description: string;
  aliases?: string[];
  surface: CommandSurface;
}

export const REPL_COMMANDS: ReplCommandMeta[] = [
  { name: "diff", description: "View uncommitted changes", surface: "ui" },
  { name: "status", description: "Provider, model & token usage", surface: "ui" },
  { name: "queue", description: "Show or edit queued inputs", surface: "ui" },
  { name: "sessions", description: "List saved sessions", surface: "runtime" },
  { name: "resume", description: "Resume a previous session", surface: "runtime" },
  { name: "sub", description: "View a subagent transcript preview", surface: "runtime" },
  { name: "subjobs", description: "Show background subagent jobs", surface: "runtime" },
  { name: "branch", description: "Fork the current session", surface: "runtime" },
  { name: "try", description: "Fork into an isolated worktree", surface: "runtime" },
  { name: "branches", description: "List session branches", surface: "runtime" },
  { name: "adopt", description: "Adopt a branch route", surface: "runtime" },
  { name: "merge", description: "Merge try branch changes", surface: "runtime" },
  { name: "switch", description: "Switch to a session or branch", surface: "runtime" },
  { name: "drop", description: "Discard a branch", surface: "runtime" },
  { name: "title", description: "Set session title", surface: "runtime" },
  { name: "model", description: "List available models", surface: "runtime" },
  { name: "provider", description: "Show configured providers", surface: "runtime" },
  { name: "help", description: "Show all commands", surface: "runtime" },
  { name: "exit", description: "Exit", aliases: ["quit"], surface: "process" },
];

export function findCommandMeta(nameOrAlias: string): ReplCommandMeta | undefined {
  return REPL_COMMANDS.find((command) =>
    command.name === nameOrAlias || command.aliases?.includes(nameOrAlias)
  );
}

export function isKnownCommand(nameOrAlias: string): boolean {
  return findCommandMeta(nameOrAlias) !== undefined;
}
