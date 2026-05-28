// desktop-input — 鼠标键盘模拟工具
//
// 支持：鼠标点击、鼠标移动、键盘输入、快捷键
// 跨平台：macOS (cliclick/osascript) / Linux (xdotool)

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ToolDef, ToolResult, ToolContext } from "./types.js";
import { errorResult } from "./types.js";

const execFileAsync = promisify(execFile);

type InputAction = "click" | "doubleClick" | "rightClick" | "move" | "type" | "key" | "hotkey" | "scroll";

interface DesktopInputArgs {
  /** Action to perform */
  action: InputAction;
  /** X coordinate (for click/move) */
  x?: number;
  /** Y coordinate (for click/move) */
  y?: number;
  /** Text to type (for type action) */
  text?: string;
  /** Key name (for key action, e.g., 'return', 'tab', 'escape') */
  key?: string;
  /** Modifier keys (for hotkey action, e.g., ['ctrl', 'shift']) */
  modifiers?: string[];
  /** Scroll direction and amount (for scroll action) */
  scrollX?: number;
  /** Scroll direction and amount (for scroll action) */
  scrollY?: number;
  /** Delay between keystrokes in ms (for type action) */
  typeDelay?: number;
}

async function detectPlatform(): Promise<"darwin" | "linux" | "unknown"> {
  const p = process.platform;
  if (p === "darwin") return "darwin";
  if (p === "linux") return "linux";
  return "unknown";
}

async function runCliclick(args: string[]): Promise<string> {
  try {
    await execFileAsync("cliclick", args);
    return "ok";
  } catch {
    throw new Error("cliclick not installed. Install: brew install cliclick");
  }
}

async function runXdotool(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("xdotool", args);
    return stdout.trim();
  } catch {
    throw new Error("xdotool not installed. Install: sudo apt install xdotool");
  }
}

async function runOsascript(script: string): Promise<string> {
  const { stdout } = await execFileAsync("osascript", ["-e", script]);
  return stdout.trim();
}

// ── macOS implementations ──────────────────────────────────────────────────────

async function macClick(x: number, y: number, button?: "left" | "right"): Promise<void> {
  if (button === "right") {
    await runCliclick(["rc:", `${x},${y}`]);
  } else {
    await runCliclick(["c:", `${x},${y}`]);
  }
}

async function macDoubleClick(x: number, y: number): Promise<void> {
  await runCliclick(["dc:", `${x},${y}`]);
}

async function macMove(x: number, y: number): Promise<void> {
  await runCliclick(["m:", `${x},${y}`]);
}

async function macType(text: string, delay?: number): Promise<void> {
  if (delay && delay > 0) {
    // Type character by character with delay
    for (const char of text) {
      await runCliclick(["t:", char]);
      await new Promise((r) => setTimeout(r, delay));
    }
  } else {
    await runOsascript(`tell application "System Events" to keystroke "${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
  }
}

async function macKey(key: string): Promise<void> {
  const keyMap: Record<string, string> = {
    return: "return",
    enter: "return",
    tab: "tab",
    escape: "escape",
    backspace: "delete",
    delete: "forward_delete",
    space: "space",
    up: "up arrow",
    down: "down arrow",
    left: "left arrow",
    right: "right arrow",
    home: "home",
    end: "end",
    pageup: "page up",
    pagedown: "page down",
  };
  const mapped = keyMap[key.toLowerCase()] ?? key;
  await runOsascript(`tell application "System Events" to key code (ASCII number "${mapped}")`);
}

async function macHotkey(modifiers: string[], key: string): Promise<void> {
  const modMap: Record<string, string> = {
    ctrl: "control",
    control: "control",
    cmd: "command",
    command: "command",
    alt: "option",
    option: "option",
    shift: "shift",
  };
  const mods = modifiers.map((m) => modMap[m.toLowerCase()] ?? m).join(" down, ");
  await runOsascript(
    `tell application "System Events" to keystroke "${key}" using {${mods} down}`
  );
}

async function macScroll(x: number, y: number): Promise<void> {
  await runCliclick(["sf:0,0", `scroll:${x},${y}`]);
}

// ── Linux implementations ──────────────────────────────────────────────────────

async function linuxClick(x: number, y: number, button?: "left" | "right"): Promise<void> {
  await runXdotool(["mousemove", String(x), String(y)]);
  if (button === "right") {
    await runXdotool(["click", "3"]);
  } else {
    await runXdotool(["click", "1"]);
  }
}

async function linuxDoubleClick(x: number, y: number): Promise<void> {
  await runXdotool(["mousemove", String(x), String(y)]);
  await runXdotool(["click", "--repeat", "2", "1"]);
}

async function linuxMove(x: number, y: number): Promise<void> {
  await runXdotool(["mousemove", String(x), String(y)]);
}

async function linuxType(text: string, delay?: number): Promise<void> {
  if (delay && delay > 0) {
    await runXdotool(["type", "--delay", String(delay), text]);
  } else {
    await runXdotool(["type", text]);
  }
}

async function linuxKey(key: string): Promise<void> {
  await runXdotool(["key", key]);
}

async function linuxHotkey(modifiers: string[], key: string): Promise<void> {
  const combo = [...modifiers, key].join("+");
  await runXdotool(["key", combo]);
}

async function linuxScroll(_x: number, y: number): Promise<void> {
  // xdotool uses button 4/5 for scroll up/down
  const button = y > 0 ? "5" : "4";
  const count = Math.abs(y);
  for (let i = 0; i < count; i++) {
    await runXdotool(["click", button]);
  }
}

export const desktopInputTool: ToolDef<DesktopInputArgs> = {
  name: "desktop_input",
  description:
    "Simulate mouse and keyboard input on the desktop. " +
    "Actions: click, doubleClick, rightClick, move (mouse), " +
    "type (type text), key (press single key), hotkey (key combination), scroll. " +
    "Supports macOS (cliclick/osascript) and Linux (xdotool).",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["click", "doubleClick", "rightClick", "move", "type", "key", "hotkey", "scroll"],
        description: "Input action to perform",
      },
      x: {
        type: "number",
        description: "X coordinate (for click/move actions)",
      },
      y: {
        type: "number",
        description: "Y coordinate (for click/move actions)",
      },
      text: {
        type: "string",
        description: "Text to type (for type action)",
      },
      key: {
        type: "string",
        description: "Key name (for key/hotkey actions, e.g., 'return', 'tab', 'a')",
      },
      modifiers: {
        type: "array",
        items: { type: "string" },
        description: "Modifier keys (for hotkey action, e.g., ['ctrl', 'shift'])",
      },
      scrollX: {
        type: "number",
        description: "Horizontal scroll amount (for scroll action)",
      },
      scrollY: {
        type: "number",
        description: "Vertical scroll amount (positive=down, negative=up)",
      },
      typeDelay: {
        type: "number",
        description: "Delay between keystrokes in ms (for type action)",
      },
    },
    required: ["action"],
  },
  options: { timeoutMs: 15_000, riskLevel: "medium" },

  async execute(args: DesktopInputArgs, _ctx: ToolContext): Promise<ToolResult> {
    const platform = await detectPlatform();
    if (platform === "unknown") {
      return errorResult("EXEC_ERROR", `Unsupported platform: ${process.platform}`);
    }

    try {
      switch (args.action) {
        case "click": {
          if (args.x == null || args.y == null) {
            return errorResult("UNKNOWN", "x and y are required for click action");
          }
          if (platform === "darwin") {
            await macClick(args.x, args.y);
          } else {
            await linuxClick(args.x, args.y);
          }
          return { ok: true, content: `Clicked at (${args.x}, ${args.y})` };
        }

        case "doubleClick": {
          if (args.x == null || args.y == null) {
            return errorResult("UNKNOWN", "x and y are required for doubleClick action");
          }
          if (platform === "darwin") {
            await macDoubleClick(args.x, args.y);
          } else {
            await linuxDoubleClick(args.x, args.y);
          }
          return { ok: true, content: `Double-clicked at (${args.x}, ${args.y})` };
        }

        case "rightClick": {
          if (args.x == null || args.y == null) {
            return errorResult("UNKNOWN", "x and y are required for rightClick action");
          }
          if (platform === "darwin") {
            await macClick(args.x, args.y, "right");
          } else {
            await linuxClick(args.x, args.y, "right");
          }
          return { ok: true, content: `Right-clicked at (${args.x}, ${args.y})` };
        }

        case "move": {
          if (args.x == null || args.y == null) {
            return errorResult("UNKNOWN", "x and y are required for move action");
          }
          if (platform === "darwin") {
            await macMove(args.x, args.y);
          } else {
            await linuxMove(args.x, args.y);
          }
          return { ok: true, content: `Mouse moved to (${args.x}, ${args.y})` };
        }

        case "type": {
          if (args.text == null) {
            return errorResult("UNKNOWN", "text is required for type action");
          }
          if (platform === "darwin") {
            await macType(args.text, args.typeDelay);
          } else {
            await linuxType(args.text, args.typeDelay);
          }
          return { ok: true, content: `Typed: "${args.text}"` };
        }

        case "key": {
          if (!args.key) {
            return errorResult("UNKNOWN", "key is required for key action");
          }
          if (platform === "darwin") {
            await macKey(args.key);
          } else {
            await linuxKey(args.key);
          }
          return { ok: true, content: `Pressed key: ${args.key}` };
        }

        case "hotkey": {
          if (!args.key) {
            return errorResult("UNKNOWN", "key is required for hotkey action");
          }
          if (!args.modifiers || args.modifiers.length === 0) {
            return errorResult("UNKNOWN", "modifiers array is required for hotkey action");
          }
          if (platform === "darwin") {
            await macHotkey(args.modifiers, args.key);
          } else {
            await linuxHotkey(args.modifiers, args.key);
          }
          return { ok: true, content: `Hotkey: ${[...args.modifiers, args.key].join("+")}` };
        }

        case "scroll": {
          const sx = args.scrollX ?? 0;
          const sy = args.scrollY ?? 0;
          if (sx === 0 && sy === 0) {
            return errorResult("UNKNOWN", "scrollX or scrollY is required for scroll action");
          }
          if (platform === "darwin") {
            await macScroll(sx, sy);
          } else {
            await linuxScroll(sx, sy);
          }
          return { ok: true, content: `Scrolled (${sx}, ${sy})` };
        }

        default:
          return errorResult("UNKNOWN", `Unknown action: ${String(args.action)}`);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return errorResult("EXEC_ERROR", `Desktop input failed: ${msg}`);
    }
  },
};
