// desktop-accessibility — Accessibility API 工具
//
// 通过系统 Accessibility API 检查 UI 元素
// macOS: osascript -l JavaScript (AXUIElement)
// Linux: xdotool + at-spi2 (limited)

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ToolDef, ToolResult, ToolContext } from "./types.js";
import { errorResult } from "./types.js";

const execFileAsync = promisify(execFile);

type AccessibilityAction = "listApps" | "listWindows" | "getElementAt" | "getFocusedElement" | "dumpTree";

interface AccessibilityArgs {
  /** Action to perform */
  action: AccessibilityAction;
  /** X coordinate (for getElementAt) */
  x?: number;
  /** Y coordinate (for getElementAt) */
  y?: number;
  /** Application name to query (for listWindows/dumpTree) */
  appName?: string;
  /** Max depth for dumpTree (default 3) */
  maxDepth?: number;
}

interface UIElement {
  role?: string;
  title?: string;
  value?: string;
  description?: string;
  enabled?: boolean;
  position?: { x: number; y: number };
  size?: { width: number; height: number };
  children?: UIElement[];
}

async function detectPlatform(): Promise<"darwin" | "linux" | "unknown"> {
  const p = process.platform;
  if (p === "darwin") return "darwin";
  if (p === "linux") return "linux";
  return "unknown";
}

// ── macOS Accessibility (osascript -l JavaScript) ────────────────────────────

const MAC_LIST_APPS_JS = `
const app = Application("System Events");
const procs = app.processes.whose({ visible: true });
return procs.map(p => ({
  name: p.name(),
  bundleId: p.bundleIdentifier ? p.bundleIdentifier() : "",
  pid: p.unixId()
}));
`;

const MAC_LIST_WINDOWS_JS = (appName: string) => `
const app = Application("System Events");
const proc = app.processes.byName("${appName.replace(/"/g, '\\"')}");
const wins = proc.windows();
return wins.map(w => ({
  title: w.name(),
  position: w.position(),
  size: w.size(),
  index: w.index()
}));
`;

const MAC_GET_FOCUSED_JS = `
const app = Application("System Events");
const proc = app.processes.whose({ frontmost: true })[0];
if (!proc) return { error: "No frontmost process" };
const win = proc.windows[0];
if (!win) return { process: proc.name(), window: null };
return {
  process: proc.name(),
  window: {
    title: win.name(),
    position: win.position(),
    size: win.size()
  }
};
`;

async function macListApps(): Promise<string> {
  const { stdout } = await execFileAsync("osascript", ["-l", "JavaScript", "-e", MAC_LIST_APPS_JS], {
    timeout: 10_000,
  });
  return stdout.trim();
}

async function macListWindows(appName: string): Promise<string> {
  const script = MAC_LIST_WINDOWS_JS(appName);
  const { stdout } = await execFileAsync("osascript", ["-l", "JavaScript", "-e", script], {
    timeout: 10_000,
  });
  return stdout.trim();
}

async function macGetFocused(): Promise<string> {
  const { stdout } = await execFileAsync("osascript", ["-l", "JavaScript", "-e", MAC_GET_FOCUSED_JS], {
    timeout: 10_000,
  });
  return stdout.trim();
}

const MAC_DUMP_TREE_JS = (appName: string, maxDepth: number) => `
function dumpElement(elem, depth) {
  if (depth > ${maxDepth}) return null;
  try {
    const info = {
      role: elem.role(),
      title: elem.title ? elem.title() : null,
      value: elem.value ? elem.value() : null,
      description: elem.description ? elem.description() : null,
      enabled: elem.enabled(),
      position: elem.position(),
      size: elem.size()
    };
    const children = elem.uiElements ? elem.uiElements() : [];
    if (children.length > 0 && depth < ${maxDepth}) {
      info.children = children.slice(0, 20).map(c => dumpElement(c, depth + 1)).filter(Boolean);
    }
    return info;
  } catch(e) {
    return { role: "error", message: e.message };
  }
}
const app = Application("System Events");
const proc = app.processes.byName("${appName.replace(/"/g, '\\"')}");
const win = proc.windows[0];
if (!win) return { error: "No window found" };
return dumpElement(win, 0);
`;

async function macDumpTree(appName: string, maxDepth: number): Promise<string> {
  const script = MAC_DUMP_TREE_JS(appName, maxDepth);
  const { stdout } = await execFileAsync("osascript", ["-l", "JavaScript", "-e", script], {
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

// ── Linux Accessibility (limited) ─────────────────────────────────────────────

async function linuxListApps(): Promise<string> {
  // Use wmctrl to list windows
  try {
    const { stdout } = await execFileAsync("wmctrl", ["-l"], { timeout: 5_000 });
    const lines = stdout.trim().split("\n").filter(Boolean);
    const apps = lines.map((line) => {
      const parts = line.split(/\s{2,}/);
      return { windowId: parts[0], desktop: parts[1], title: parts[parts.length - 1] };
    });
    return JSON.stringify(apps, null, 2);
  } catch {
    // Fallback: xdotool
    try {
      const { stdout } = await execFileAsync("xdotool", ["search", "--name", ""], { timeout: 5_000 });
      return JSON.stringify({ windowIds: stdout.trim().split("\n").filter(Boolean) });
    } catch {
      throw new Error("No accessibility tools available. Install wmctrl or xdotool.");
    }
  }
}

async function linuxGetFocused(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("xdotool", ["getactivewindow", "getwindowname"], {
      timeout: 5_000,
    });
    return JSON.stringify({ focusedWindow: stdout.trim() });
  } catch {
    throw new Error("xdotool not installed. Install: sudo apt install xdotool");
  }
}

export const desktopAccessibilityTool: ToolDef<AccessibilityArgs> = {
  name: "desktop_accessibility",
  description:
    "Inspect UI elements via system Accessibility API. " +
    "Actions: listApps (list visible applications), " +
    "listWindows (list windows of an app), " +
    "getFocusedElement (get currently focused window), " +
    "dumpTree (dump UI element hierarchy). " +
    "macOS uses osascript JavaScript; Linux uses wmctrl/xdotool (limited).",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["listApps", "listWindows", "getFocusedElement", "dumpTree"],
        description: "Accessibility action to perform",
      },
      appName: {
        type: "string",
        description: "Application name (for listWindows/dumpTree)",
      },
      x: {
        type: "number",
        description: "X coordinate (for getElementAt)",
      },
      y: {
        type: "number",
        description: "Y coordinate (for getElementAt)",
      },
      maxDepth: {
        type: "number",
        description: "Max tree depth for dumpTree (default 3)",
      },
    },
    required: ["action"],
  },
  options: { timeoutMs: 30_000, riskLevel: "low" },

  async execute(args: AccessibilityArgs, _ctx: ToolContext): Promise<ToolResult> {
    const platform = await detectPlatform();
    if (platform === "unknown") {
      return errorResult("EXEC_ERROR", `Unsupported platform: ${process.platform}`);
    }

    try {
      let output: string;

      switch (args.action) {
        case "listApps":
          if (platform === "darwin") {
            output = await macListApps();
          } else {
            output = await linuxListApps();
          }
          return {
            ok: true,
            content: output,
            metadata: { renderHint: { type: "code", lang: "json" } },
          };

        case "listWindows":
          if (!args.appName) {
            return errorResult("UNKNOWN", "appName is required for listWindows action");
          }
          if (platform === "darwin") {
            output = await macListWindows(args.appName);
          } else {
            output = await linuxListApps(); // Linux: list all windows
          }
          return {
            ok: true,
            content: output,
            metadata: { renderHint: { type: "code", lang: "json" } },
          };

        case "getFocusedElement":
          if (platform === "darwin") {
            output = await macGetFocused();
          } else {
            output = await linuxGetFocused();
          }
          return {
            ok: true,
            content: output,
            metadata: { renderHint: { type: "code", lang: "json" } },
          };

        case "dumpTree":
          if (!args.appName) {
            return errorResult("UNKNOWN", "appName is required for dumpTree action");
          }
          if (platform === "darwin") {
            output = await macDumpTree(args.appName, args.maxDepth ?? 3);
          } else {
            return errorResult("EXEC_ERROR", "dumpTree is only supported on macOS");
          }
          return {
            ok: true,
            content: output,
            metadata: { renderHint: { type: "code", lang: "json" } },
          };

        default:
          return errorResult("UNKNOWN", `Unknown action: ${String(args.action)}`);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return errorResult("EXEC_ERROR", `Accessibility query failed: ${msg}`);
    }
  },
};
