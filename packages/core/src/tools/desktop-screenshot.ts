// desktop-screenshot — 截图工具，封装系统截图命令
//
// 支持：全屏截图、窗口截图、区域截图
// 跨平台：macOS (screencapture) / Linux (scrot/import/xdg-screenshot)

import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ToolDef, ToolResult, ToolContext } from "./types.js";
import { errorResult } from "./types.js";

const execFileAsync = promisify(execFile);

type ScreenshotMode = "fullscreen" | "window" | "region";

interface ScreenshotArgs {
  /** Screenshot mode */
  mode?: ScreenshotMode;
  /** Output file path (default: auto-generated in cwd) */
  path?: string;
  /** Delay in seconds before capture */
  delay?: number;
  /** Image format: png (default) or jpg */
  format?: "png" | "jpg";
  /** Window title to capture (macOS only, for window mode) */
  windowTitle?: string;
  /** Display index for multi-monitor (macOS only) */
  display?: number;
}

async function ensureDir(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}

function getDefaultPath(format: string, cwd: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return join(cwd, `screenshot-${ts}.${format}`);
}

async function detectPlatform(): Promise<"darwin" | "linux" | "unknown"> {
  const p = process.platform;
  if (p === "darwin") return "darwin";
  if (p === "linux") return "linux";
  return "unknown";
}

async function captureMacOS(args: ScreenshotArgs, outputPath: string): Promise<string> {
  const cmdArgs: string[] = [];

  // Mode flags
  if (args.mode === "window") {
    cmdArgs.push("-w"); // capture window
  } else if (args.mode === "region") {
    cmdArgs.push("-s"); // interactive region select
  }
  // fullscreen is default (no flag)

  // Delay
  if (args.delay && args.delay > 0) {
    cmdArgs.push("-T", String(args.delay));
  }

  // Format
  if (args.format === "jpg") {
    cmdArgs.push("-t", "jpg");
  } else {
    cmdArgs.push("-t", "png");
  }

  // Display
  if (args.display != null) {
    cmdArgs.push("-D", String(args.display));
  }

  // Output path
  cmdArgs.push(outputPath);

  await execFileAsync("screencapture", cmdArgs);
  return `Screenshot saved to ${outputPath} (${args.mode ?? "fullscreen"})`;
}

async function captureLinux(args: ScreenshotArgs, outputPath: string): Promise<string> {
  // Try scrot first, then import (ImageMagick), then gnome-screenshot
  const tools = [
    {
      name: "scrot",
      buildArgs: (): string[] => {
        const a: string[] = [];
        if (args.delay && args.delay > 0) a.push("-d", String(args.delay));
        if (args.mode === "window") a.push("-u"); // focused window
        if (args.mode === "region") a.push("-s"); // select region
        a.push(outputPath);
        return a;
      },
    },
    {
      name: "import",
      buildArgs: (): string[] => {
        const a: string[] = [];
        if (args.mode === "window") a.push("-window", "root");
        a.push(outputPath);
        return a;
      },
    },
  ];

  for (const tool of tools) {
    try {
      await execFileAsync(tool.name, tool.buildArgs());
      return `Screenshot saved to ${outputPath} via ${tool.name} (${args.mode ?? "fullscreen"})`;
    } catch {
      // Try next tool
    }
  }

  return errorResult("EXEC_ERROR", "No screenshot tool available. Install scrot or imagemagick.").content;
}

export const desktopScreenshotTool: ToolDef<ScreenshotArgs> = {
  name: "desktop_screenshot",
  description:
    "Capture a screenshot of the desktop. " +
    "Modes: fullscreen (default), window (capture a window), region (interactive select). " +
    "Supports macOS (screencapture) and Linux (scrot/import).",
  parameters: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["fullscreen", "window", "region"],
        description: "Screenshot mode (default: fullscreen)",
      },
      path: {
        type: "string",
        description: "Output file path (default: auto-generated in cwd)",
      },
      delay: {
        type: "number",
        description: "Delay in seconds before capture (default: 0)",
      },
      format: {
        type: "string",
        enum: ["png", "jpg"],
        description: "Image format (default: png)",
      },
      windowTitle: {
        type: "string",
        description: "Window title to capture (macOS only, for window mode)",
      },
      display: {
        type: "number",
        description: "Display index for multi-monitor (macOS only)",
      },
    },
    required: [],
  },
  options: { timeoutMs: 30_000, riskLevel: "low" },

  async execute(args: ScreenshotArgs, ctx: ToolContext): Promise<ToolResult> {
    const platform = await detectPlatform();
    if (platform === "unknown") {
      return errorResult("EXEC_ERROR", `Unsupported platform: ${process.platform}`);
    }

    const format = args.format ?? "png";
    const outputPath = args.path ?? getDefaultPath(format, ctx.cwd);

    try {
      await ensureDir(outputPath);

      let message: string;
      if (platform === "darwin") {
        message = await captureMacOS(args, outputPath);
      } else {
        const result = await captureLinux(args, outputPath);
        if (result.startsWith("No screenshot tool")) {
          return errorResult("EXEC_ERROR", result);
        }
        message = result;
      }

      return {
        ok: true,
        content: message,
        metadata: {
          renderHint: { type: "image", mimeType: format === "jpg" ? "image/jpeg" : "image/png" },
        },
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return errorResult("EXEC_ERROR", `Screenshot failed: ${msg}`);
    }
  },
};
