export interface ExternalEditorRequest {
  initialValue: string;
  cursor: number;
}

export interface ExternalEditorResult {
  value: string;
  cursor: number;
}

export interface ExternalEditorCommand {
  command: string;
  args: string[];
}

export function createExternalEditorRequest(value: string, cursor: number): ExternalEditorRequest {
  return { initialValue: value, cursor };
}

export function applyExternalEditorResult(result: { value: string; cursor?: number | undefined }): ExternalEditorResult {
  const cursor = Math.max(0, Math.min(result.cursor ?? result.value.length, result.value.length));
  return { value: result.value, cursor };
}

export function resolveExternalEditorCommand(env: NodeJS.ProcessEnv = process.env): ExternalEditorCommand | null {
  const editor = env.VISUAL || env.EDITOR;
  if (!editor?.trim()) return null;
  const parts = splitCommand(editor.trim());
  const command = parts[0];
  if (!command) return null;
  return { command, args: parts.slice(1) };
}

function splitCommand(command: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let escaped = false;

  for (const char of command) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (escaped) current += "\\";
  if (current) parts.push(current);
  return parts;
}
