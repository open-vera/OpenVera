// computer-use — 统一入口元工具
//
// 自动选择浏览器/桌面/CLI 子工具，提供高层抽象的 computer use 接口
// 支持复合任务编排：将高级任务描述分解为子工具调用序列

import type { ToolDef, ToolResult, ToolContext } from "./types.js";
import { errorResult } from "./types.js";
import { browserTool } from "./browser.js";
import { desktopScreenshotTool } from "./desktop-screenshot.js";
import { desktopInputTool } from "./desktop-input.js";
import { desktopScriptTool } from "./desktop-script.js";
import { desktopAccessibilityTool } from "./desktop-accessibility.js";
import { bashTool } from "./bash.js";
import { createVisualAnalyzeTool } from "./visual-analyze.js";

// ── Types ──────────────────────────────────────────────────────────────────────

type Environment = "browser" | "desktop" | "cli" | "auto";

interface ComputerUseArgs {
  /** High-level task description (e.g., "navigate to example.com and take a screenshot") */
  task: string;
  /** Target environment — auto-detected if not specified */
  environment?: Environment;
  /** Sub-action for explicit routing */
  action?: string;
  /** URL for browser tasks */
  url?: string;
  /** CSS selector for browser element interaction */
  selector?: string;
  /** Text to type */
  text?: string;
  /** JavaScript expression for browser evaluate */
  expression?: string;
  /** Mouse/keyboard action type for desktop_input */
  inputAction?: string;
  /** X coordinate for desktop input */
  x?: number;
  /** Y coordinate for desktop input */
  y?: number;
  /** Key name for desktop input */
  key?: string;
  /** Modifier keys for desktop hotkey */
  modifiers?: string[];
  /** Script content for desktop_script */
  script?: string;
  /** Script type for desktop_script */
  scriptType?: "applescript" | "shell" | "javascript";
  /** Shell command for CLI tasks */
  command?: string;
  /** Screenshot output path */
  screenshotPath?: string;
  /** Timeout override in ms */
  timeout?: number;
}

// ── Environment Detection ──────────────────────────────────────────────────────

function detectEnvironment(task: string): Environment {
  const lower = task.toLowerCase();

  const browserKeywords = [
    "website", "url", "http", "navigate", "browse", "web page",
    "click link", "fill form", "login", "sign in", "open tab",
    "browser", "chromium", "chrome", "playwright",
  ];
  const cliKeywords = [
    "run command", "shell", "execute", "terminal", "install",
    "npm", "pnpm", "git", "curl", "wget", "docker", "apt",
    "brew", "pip", "cargo", "make",
  ];
  const desktopKeywords = [
    "desktop", "mouse", "keyboard", "click at", "type text",
    "hotkey", "shortcut", "finder", "spotlight", "app switch",
    "drag", "scroll", "double click", "right click",
  ];

  const browserScore = browserKeywords.filter((k) => lower.includes(k)).length;
  const cliScore = cliKeywords.filter((k) => lower.includes(k)).length;
  const desktopScore = desktopKeywords.filter((k) => lower.includes(k)).length;

  if (browserScore > cliScore && browserScore > desktopScore) return "browser";
  if (cliScore > desktopScore) return "cli";
  if (desktopScore > 0) return "desktop";

  // Default: if a URL is present, use browser; otherwise cli
  if (/https?:\/\//.test(task)) return "browser";
  return "cli";
}

// ── Sub-tool Dispatch ──────────────────────────────────────────────────────────

async function dispatchBrowserAction(
  args: ComputerUseArgs,
  ctx: ToolContext
): Promise<ToolResult> {
  try {
    // Determine browser action from args
    if (args.url && !args.action) {
      return await browserTool.execute({ action: "navigate", url: args.url, timeout: args.timeout }, ctx);
    }

    if (args.action) {
      const browserArgs: Record<string, unknown> = {
        action: args.action,
        timeout: args.timeout,
      };
      if (args.url) browserArgs.url = args.url;
      if (args.selector) browserArgs.selector = args.selector;
      if (args.text) browserArgs.text = args.text;
      if (args.expression) browserArgs.expression = args.expression;
      if (args.screenshotPath) browserArgs.path = args.screenshotPath;
      return await browserTool.execute(browserArgs as unknown as Parameters<typeof browserTool.execute>[0], ctx);
    }

    // Auto-infer from task description
    const task = args.task.toLowerCase();
    if (task.includes("screenshot") || task.includes("capture")) {
      return await browserTool.execute(
        { action: "screenshot", path: args.screenshotPath, timeout: args.timeout },
        ctx
      );
    }

    // Default: navigate if URL found in task
    const urlMatch = args.task.match(/https?:\/\/[^\s]+/);
    if (urlMatch) {
      return await browserTool.execute({ action: "navigate", url: urlMatch[0], timeout: args.timeout }, ctx);
    }

    return errorResult(
      "UNKNOWN",
      "Could not determine browser action. Provide a URL, an explicit 'action', or a more specific task description."
    );
  } catch (err) {
    return errorResult(
      "EXEC_ERROR",
      err instanceof Error ? err.message : String(err)
    );
  }
}

async function dispatchDesktopAction(
  args: ComputerUseArgs,
  ctx: ToolContext
): Promise<ToolResult> {
  const task = args.task.toLowerCase();

  // Screenshot
  if (task.includes("screenshot") || task.includes("capture") || task.includes("screen shot")) {
    const mode = task.includes("window")
      ? "window"
      : task.includes("region")
        ? "region"
        : "fullscreen";
    return desktopScreenshotTool.execute(
      { mode, path: args.screenshotPath },
      ctx
    );
  }

  // Hotkey / keyboard shortcut
  if (task.includes("hotkey") || task.includes("shortcut") || task.includes("key combination")) {
    if (args.key && args.modifiers) {
      return desktopInputTool.execute(
        { action: "hotkey", key: args.key, modifiers: args.modifiers },
        ctx
      );
    }
  }

  // Mouse click
  if (task.includes("click") && args.x != null && args.y != null) {
    const action = task.includes("double")
      ? "doubleClick"
      : task.includes("right")
        ? "rightClick"
        : "click";
    return desktopInputTool.execute({ action, x: args.x, y: args.y }, ctx);
  }

  // Type text
  if ((task.includes("type") || task.includes("input") || task.includes("enter")) && args.text) {
    return desktopInputTool.execute({ action: "type", text: args.text }, ctx);
  }

  // Explicit input action
  if (args.inputAction) {
    const inputArgs: Record<string, unknown> = { action: args.inputAction };
    if (args.x != null) inputArgs.x = args.x;
    if (args.y != null) inputArgs.y = args.y;
    if (args.text) inputArgs.text = args.text;
    if (args.key) inputArgs.key = args.key;
    if (args.modifiers) inputArgs.modifiers = args.modifiers;
    return desktopInputTool.execute(inputArgs as unknown as Parameters<typeof desktopInputTool.execute>[0], ctx);
  }

  // Script execution
  if (args.script) {
    return desktopScriptTool.execute(
      {
        type: args.scriptType ?? "shell",
        script: args.script,
        timeout: args.timeout,
      },
      ctx
    );
  }

  return errorResult(
    "UNKNOWN",
    "Could not determine desktop action. Provide 'inputAction', 'script', or a more specific task description."
  );
}

async function dispatchCliAction(
  args: ComputerUseArgs,
  ctx: ToolContext
): Promise<ToolResult> {
  if (!args.command) {
    return errorResult("UNKNOWN", "command is required for CLI tasks.");
  }
  return bashTool.execute({ command: args.command, timeout: args.timeout }, ctx);
}

// ── Task Decomposition (composite tasks) ───────────────────────────────────────

interface SubStep {
  tool: "browser" | "desktop" | "cli" | "screenshot" | "accessibility" | "visual_analyze";
  args: Record<string, unknown>;
  description: string;
}

function decomposeTask(task: string, args?: ComputerUseArgs): SubStep[] | null {
  const lower = task.toLowerCase();
  const steps: SubStep[] = [];

  // Pattern: "open <url> and take a screenshot [and analyze]"
  const urlScreenshotMatch = task.match(
    /(?:(?:open|navigate)(?:\s+to)?|go\s+to)\s+(https?:\/\/[^\s]+).*?(?:screenshot|capture|screen\s*shot)/i
  );
  if (urlScreenshotMatch) {
    const wantsAnalysis = lower.includes("analy");
    steps.push({
      tool: "browser",
      args: { action: "navigate", url: urlScreenshotMatch[1] },
      description: `Navigate to ${urlScreenshotMatch[1]}`,
    });
    steps.push({
      tool: "browser",
      args: { action: "screenshot" },
      description: "Take screenshot of the page",
    });
    if (wantsAnalysis) {
      steps.push({
        tool: "visual_analyze",
        args: { imagePath: args?.screenshotPath },
        description: "Analyze screenshot with LLM vision",
      });
    }
    return steps;
  }

  // Pattern: "screenshot and analyze" in browser context (URL present)
  const urlInTask = task.match(/https?:\/\/[^\s]+/);
  if (
    urlInTask &&
    ((lower.includes("screenshot") && lower.includes("analy")) ||
      (lower.includes("take") && lower.includes("screenshot") && lower.includes("then")))
  ) {
    steps.push({
      tool: "browser",
      args: { action: "navigate", url: urlInTask[0] },
      description: `Navigate to ${urlInTask[0]}`,
    });
    steps.push({
      tool: "browser",
      args: { action: "screenshot" },
      description: "Take screenshot",
    });
    steps.push({
      tool: "visual_analyze",
      args: { imagePath: args?.screenshotPath },
      description: "Analyze screenshot with LLM vision",
    });
    return steps;
  }

  // Pattern: "open <url> and click <selector>"
  const urlClickMatch = task.match(
    /(?:(?:open|navigate)(?:\s+to)?|go\s+to)\s+(https?:\/\/[^\s]+).*?(?:click|press)\s+(.+)/i
  );
  if (urlClickMatch) {
    steps.push({
      tool: "browser",
      args: { action: "navigate", url: urlClickMatch[1] },
      description: `Navigate to ${urlClickMatch[1]}`,
    });
    steps.push({
      tool: "browser",
      args: { action: "click", selector: urlClickMatch[2].trim() },
      description: `Click on ${urlClickMatch[2].trim()}`,
    });
    return steps;
  }

  // Pattern: "open <url> and type <text> into <selector>"
  const urlTypeMatch = task.match(
    /(?:(?:open|navigate)(?:\s+to)?|go\s+to)\s+(https?:\/\/[^\s]+).*?(?:type|input|fill)\s+["']?(.+?)["']?\s+(?:into|in|to)\s+(.+)/i
  );
  if (urlTypeMatch) {
    steps.push({
      tool: "browser",
      args: { action: "navigate", url: urlTypeMatch[1] },
      description: `Navigate to ${urlTypeMatch[1]}`,
    });
    steps.push({
      tool: "browser",
      args: { action: "type", text: urlTypeMatch[2].trim(), selector: urlTypeMatch[3].trim() },
      description: `Type "${urlTypeMatch[2].trim()}" into ${urlTypeMatch[3].trim()}`,
    });
    return steps;
  }

  // Pattern: "screenshot and analyze" or "take screenshot then ..."
  if (
    (lower.includes("screenshot") && lower.includes("analy")) ||
    (lower.includes("take") && lower.includes("screenshot") && lower.includes("then"))
  ) {
    steps.push({
      tool: "screenshot",
      args: { mode: "fullscreen", path: args?.screenshotPath },
      description: "Take screenshot",
    });
    steps.push({
      tool: "visual_analyze",
      args: { imagePath: args?.screenshotPath },
      description: "Analyze screenshot with LLM vision",
    });
    return steps;
  }

  return null; // Not a composite task — use single dispatch
}

// ── Meta-tool Definition ───────────────────────────────────────────────────────

export const computerUseTool: ToolDef<ComputerUseArgs> = {
  name: "computer_use",
  description:
    "Unified computer use tool — automatically selects the best sub-tool for the task. " +
    "Supports browser control (navigate, click, type, screenshot), " +
    "desktop automation (mouse, keyboard, screenshots, scripts), " +
    "and CLI commands. " +
    "Provide a 'task' description and the tool routes to the appropriate sub-tool(s). " +
    "Composite tasks (e.g., 'open URL and take screenshot') are decomposed into steps.",
  parameters: {
    type: "object",
    properties: {
      task: {
        type: "string",
        description:
          "High-level task description (e.g., 'navigate to example.com and take a screenshot'). " +
          "The tool auto-detects the environment and routes to the right sub-tool.",
      },
      environment: {
        type: "string",
        enum: ["browser", "desktop", "cli", "auto"],
        description:
          "Target environment. 'auto' (default) detects from task description. " +
          "'browser' uses Playwright, 'desktop' uses system automation, 'cli' uses shell.",
      },
      action: {
        type: "string",
        description:
          "Explicit sub-action override (e.g., 'navigate', 'click', 'type', 'screenshot'). " +
          "Usually auto-detected from 'task'.",
      },
      url: {
        type: "string",
        description: "URL for browser navigation tasks",
      },
      selector: {
        type: "string",
        description: "CSS selector for browser element interaction",
      },
      text: {
        type: "string",
        description: "Text to type (browser or desktop)",
      },
      expression: {
        type: "string",
        description: "JavaScript expression for browser evaluate action",
      },
      inputAction: {
        type: "string",
        description:
          "Desktop input action: click, doubleClick, rightClick, move, type, key, hotkey, scroll",
      },
      x: {
        type: "number",
        description: "X coordinate for desktop mouse actions",
      },
      y: {
        type: "number",
        description: "Y coordinate for desktop mouse actions",
      },
      key: {
        type: "string",
        description: "Key name for desktop keyboard actions",
      },
      modifiers: {
        type: "array",
        items: { type: "string" },
        description: "Modifier keys for desktop hotkey (e.g., ['ctrl', 'shift'])",
      },
      script: {
        type: "string",
        description: "Script content for desktop_script execution",
      },
      scriptType: {
        type: "string",
        enum: ["applescript", "shell", "javascript"],
        description: "Script type for desktop_script (default: shell)",
      },
      command: {
        type: "string",
        description: "Shell command for CLI tasks",
      },
      screenshotPath: {
        type: "string",
        description: "Output path for screenshot tasks",
      },
      timeout: {
        type: "number",
        description: "Timeout override in milliseconds",
      },
    },
    required: ["task"],
  },
  options: { timeoutMs: 120_000, riskLevel: "medium" },

  async execute(args: ComputerUseArgs, ctx: ToolContext): Promise<ToolResult> {
    // If a URL is explicitly provided, prefer browser environment
    const detectedEnv = args.url ? "browser" : detectEnvironment(args.task);
    const environment: Environment = args.environment ?? detectedEnv;

    // Try composite task decomposition first
    const steps = decomposeTask(args.task, args);
    if (steps) {
      const results: string[] = [];
      for (const step of steps) {
        let result: ToolResult;
        try {
          switch (step.tool) {
            case "browser":
              result = await browserTool.execute(
                step.args as unknown as Parameters<typeof browserTool.execute>[0],
                ctx
              );
              break;
            case "screenshot":
              result = await desktopScreenshotTool.execute(
                step.args as unknown as Parameters<typeof desktopScreenshotTool.execute>[0],
                ctx
              );
              break;
            case "desktop":
              result = await desktopInputTool.execute(
                step.args as unknown as Parameters<typeof desktopInputTool.execute>[0],
                ctx
              );
              break;
            case "cli":
              result = await bashTool.execute(
                step.args as unknown as Parameters<typeof bashTool.execute>[0],
                ctx
              );
              break;
            case "accessibility":
              result = await desktopAccessibilityTool.execute(
                step.args as unknown as Parameters<typeof desktopAccessibilityTool.execute>[0],
                ctx
              );
              break;
            case "visual_analyze":
              if (!ctx.llmAdapter) {
                result = errorResult("UNKNOWN", "LLM adapter not available — cannot run visual analysis. Provide llmAdapter in ToolContext.");
              } else {
                const visualTool = createVisualAnalyzeTool(ctx.llmAdapter, ctx.defaultModel);
                result = await visualTool.execute(
                  step.args as unknown as Parameters<typeof visualTool.execute>[0],
                  ctx
                );
              }
              break;
            default:
              result = errorResult("UNKNOWN", `Unknown sub-tool: ${step.tool}`);
          }
        } catch (err) {
          result = errorResult(
            "EXEC_ERROR",
            err instanceof Error ? err.message : String(err)
          );
        }
        results.push(`[${step.description}] ${result.ok ? "✓" : "✗"} ${result.content}`);
        if (!result.ok) {
          return {
            ok: false,
            content: results.join("\n"),
            error: result.error,
          };
        }
      }
      return {
        ok: true,
        content: results.join("\n"),
      };
    }

    // Single-action dispatch
    switch (environment) {
      case "browser":
        return dispatchBrowserAction(args, ctx);
      case "desktop":
        return dispatchDesktopAction(args, ctx);
      case "cli":
        return dispatchCliAction(args, ctx);
      case "auto": {
        // Auto: try each dispatcher based on detection
        const detected = detectEnvironment(args.task);
        switch (detected) {
          case "browser":
            return dispatchBrowserAction(args, ctx);
          case "desktop":
            return dispatchDesktopAction(args, ctx);
          case "cli":
          default:
            return dispatchCliAction(args, ctx);
        }
      }
      default:
        return errorResult("UNKNOWN", `Unknown environment: ${String(environment)}`);
    }
  },
};
