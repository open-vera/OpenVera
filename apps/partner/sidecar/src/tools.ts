import type { Tool } from "@open-vera/core/types";

export const PARTNER_TOOLS: Tool[] = [
  {
    name: "read_file",
    description: "Read a text file from the local filesystem.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or relative file path" },
      },
      required: ["path"],
    },
    maxResultSizeChars: Number.POSITIVE_INFINITY,
  },
  {
    name: "write_file",
    description: "Write text content to a file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Target file path" },
        content: { type: "string", description: "File content" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "list_dir",
    description: "List entries in a directory.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path" },
      },
      required: ["path"],
    },
  },
  {
    name: "execute_shell",
    description: "Run a whitelisted shell command.",
    parameters: {
      type: "object",
      properties: {
        cmd: { type: "string", description: "Command name (whitelist only)" },
        args: {
          type: "array",
          items: { type: "string" },
          description: "Command arguments",
        },
        cwd: { type: "string", description: "Working directory" },
      },
      required: ["cmd"],
    },
  },
];
