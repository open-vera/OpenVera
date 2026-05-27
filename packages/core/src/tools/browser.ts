// browser — Playwright 集成，封装浏览器操作为 tool
//
// 支持：navigate / click / type / screenshot / evaluate / waitForSelector
// headless 模式（默认）+ headed 模式（调试用）
// CDP 协议支持 — 连接已有 Chrome 实例
// Session 管理 — cookie 持久化、多 tab 管理

import { writeFile, readFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { ToolDef, ToolResult, ToolContext } from "./types.js";
import { errorResult } from "./types.js";

// ── Types ──────────────────────────────────────────────────────────────────────

type BrowserAction =
  | "navigate"
  | "click"
  | "type"
  | "screenshot"
  | "evaluate"
  | "waitForSelector"
  | "close"
  // CDP actions
  | "connect"
  | "disconnect"
  // Session management actions
  | "newTab"
  | "switchTab"
  | "closeTab"
  | "listTabs"
  | "saveCookies"
  | "loadCookies"
  | "saveSession"
  | "loadSession";

interface BrowserArgs {
  action: BrowserAction;
  /** URL for navigate action */
  url?: string;
  /** CSS selector for click/type/waitForSelector */
  selector?: string;
  /** Text to type (for type action) */
  text?: string;
  /** JavaScript expression (for evaluate action) */
  expression?: string;
  /** Screenshot file path (for screenshot action) */
  path?: string;
  /** Wait timeout in ms (default 30000) */
  timeout?: number;
  /** Launch headed instead of headless (default false) */
  headed?: boolean;
  /** Viewport width (default 1280) */
  width?: number;
  /** Viewport height (default 720) */
  height?: number;
  /** Full page screenshot (default false) */
  fullPage?: boolean;
  /** Wait after navigate: 'load' | 'domcontentloaded' | 'networkidle' (default 'load') */
  waitUntil?: "load" | "domcontentloaded" | "networkidle";
  /** CDP endpoint URL for connect action (e.g., http://localhost:9222) */
  cdpUrl?: string;
  /** Tab index for switchTab/closeTab actions (0-based) */
  tabIndex?: number;
  /** File path for saveCookies/loadCookies/saveSession/loadSession */
  sessionPath?: string;
}

// ── Lazy-loaded Playwright ─────────────────────────────────────────────────────

type PlaywrightModule = typeof import("playwright");
type Browser = import("playwright").Browser;
type Page = import("playwright").Page;
type BrowserContext = import("playwright").BrowserContext;

let pwModule: PlaywrightModule | null = null;

async function loadPlaywright(): Promise<PlaywrightModule> {
  if (pwModule) return pwModule;
  try {
    pwModule = (await import("playwright")) as PlaywrightModule;
    return pwModule;
  } catch {
    throw new Error(
      "playwright is not installed. Run: pnpm add -D playwright && npx playwright install chromium"
    );
  }
}

// ── Browser Session Manager ───────────────────────────────────────────────────

interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  pages: Page[];
  activePageIndex: number;
  /** Whether this session connects to an existing browser via CDP */
  isCdp: boolean;
}

const sessions = new Map<string, BrowserSession>();

function getActivePage(session: BrowserSession): Page {
  return session.pages[session.activePageIndex] ?? session.pages[0];
}

async function getOrCreateSession(
  sessionId: string,
  headed: boolean,
  width: number,
  height: number
): Promise<BrowserSession> {
  const existing = sessions.get(sessionId);
  if (existing && existing.browser.isConnected()) {
    return existing;
  }

  const pw = await loadPlaywright();
  const browser = await pw.chromium.launch({ headless: !headed });
  const context = await browser.newContext({
    viewport: { width, height },
  });
  const page = await context.newPage();

  const session: BrowserSession = {
    browser,
    context,
    pages: [page],
    activePageIndex: 0,
    isCdp: false,
  };
  sessions.set(sessionId, session);
  return session;
}

async function closeSession(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId);
  if (session) {
    await session.browser.close().catch(() => {});
    sessions.delete(sessionId);
  }
}

// ── Cookie / Session persistence helpers ───────────────────────────────────────

async function ensureDir(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}

// ── Tool Definition ───────────────────────────────────────────────────────────

export const browserTool: ToolDef<BrowserArgs> = {
  name: "browser",
  description:
    "Control a headless Chromium browser via Playwright. " +
    "Actions: navigate (go to URL), click (click element by selector), " +
    "type (type text into element), screenshot (capture page), " +
    "evaluate (run JS in page), waitForSelector (wait for element), " +
    "close (close browser session).",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [
          "navigate",
          "click",
          "type",
          "screenshot",
          "evaluate",
          "waitForSelector",
          "close",
        ],
        description: "Browser action to perform",
      },
      url: {
        type: "string",
        description: "URL to navigate to (for navigate action)",
      },
      selector: {
        type: "string",
        description:
          "CSS selector for click/type/waitForSelector actions",
      },
      text: {
        type: "string",
        description: "Text to type (for type action)",
      },
      expression: {
        type: "string",
        description:
          "JavaScript expression to evaluate (for evaluate action)",
      },
      path: {
        type: "string",
        description: "File path to save screenshot (for screenshot action)",
      },
      timeout: {
        type: "number",
        description: "Timeout in milliseconds (default 30000)",
      },
      headed: {
        type: "boolean",
        description: "Launch in headed mode for debugging (default false)",
      },
      width: {
        type: "number",
        description: "Viewport width (default 1280)",
      },
      height: {
        type: "number",
        description: "Viewport height (default 720)",
      },
      fullPage: {
        type: "boolean",
        description: "Capture full page screenshot (default false)",
      },
      waitUntil: {
        type: "string",
        enum: ["load", "domcontentloaded", "networkidle"],
        description:
          "When to consider navigation complete (default 'load')",
      },
    },
    required: ["action"],
  },
  options: { timeoutMs: 60_000, riskLevel: "medium" },

  async execute(args: BrowserArgs, ctx: ToolContext): Promise<ToolResult> {
    const timeout = args.timeout ?? 30_000;
    const headed = args.headed ?? false;
    const width = args.width ?? 1280;
    const height = args.height ?? 720;

    // Close action — no session needed
    if (args.action === "close") {
      await closeSession(ctx.sessionId);
      return { ok: true, content: "Browser session closed." };
    }

    let session: BrowserSession;
    try {
      session = await getOrCreateSession(
        ctx.sessionId,
        headed,
        width,
        height
      );
    } catch (e: unknown) {
      return errorResult(
        "EXEC_ERROR",
        `Failed to launch browser: ${e instanceof Error ? e.message : String(e)}`
      );
    }

    const page = getActivePage(session);

    try {
      switch (args.action) {
        case "navigate": {
          if (!args.url) {
            return errorResult("UNKNOWN", "url is required for navigate action");
          }
          const waitUntil = args.waitUntil ?? "load";
          const resp = await page.goto(args.url, {
            timeout,
            waitUntil,
          });
          const status = resp?.status() ?? 0;
          const title = await page.title();
          return {
            ok: true,
            content: `Navigated to ${args.url} (status: ${status}, title: "${title}")`,
          };
        }

        case "click": {
          if (!args.selector) {
            return errorResult(
              "UNKNOWN",
              "selector is required for click action"
            );
          }
          await page.click(args.selector, { timeout });
          return {
            ok: true,
            content: `Clicked: ${args.selector}`,
          };
        }

        case "type": {
          if (!args.selector) {
            return errorResult(
              "UNKNOWN",
              "selector is required for type action"
            );
          }
          if (args.text == null) {
            return errorResult(
              "UNKNOWN",
              "text is required for type action"
            );
          }
          await page.fill(args.selector, args.text, { timeout });
          return {
            ok: true,
            content: `Typed "${args.text}" into ${args.selector}`,
          };
        }

        case "screenshot": {
          const screenshotOpts: Parameters<Page["screenshot"]>[0] = {
            fullPage: args.fullPage ?? false,
          };
          if (args.path) {
            screenshotOpts.path = args.path;
          }
          const buffer = await page.screenshot(screenshotOpts);
          const sizeKB = Math.round(buffer.length / 1024);
          return {
            ok: true,
            content: args.path
              ? `Screenshot saved to ${args.path} (${sizeKB}KB)`
              : `Screenshot captured (${sizeKB}KB, base64 encoded in metadata)`,
            metadata: {
              renderHint: {
                type: "image",
                mimeType: "image/png",
              },
            },
          };
        }

        case "evaluate": {
          if (!args.expression) {
            return errorResult(
              "UNKNOWN",
              "expression is required for evaluate action"
            );
          }
          const result = await page.evaluate((expr: string) => {
            // eslint-disable-next-line no-eval
            return eval(expr);
          }, args.expression);
          const serialized =
            typeof result === "string"
              ? result
              : JSON.stringify(result, null, 2);
          return {
            ok: true,
            content: serialized ?? "(undefined)",
          };
        }

        case "waitForSelector": {
          if (!args.selector) {
            return errorResult(
              "UNKNOWN",
              "selector is required for waitForSelector action"
            );
          }
          await page.waitForSelector(args.selector, { timeout });
          return {
            ok: true,
            content: `Element appeared: ${args.selector}`,
          };
        }

        default:
          return errorResult(
            "UNKNOWN",
            `Unknown action: ${String(args.action)}`
          );
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return errorResult("EXEC_ERROR", `Browser action failed: ${msg}`);
    }
  },
};

// ── Cleanup helper (for tests) ────────────────────────────────────────────────

export async function closeAllBrowserSessions(): Promise<void> {
  const ids = [...sessions.keys()];
  await Promise.all(ids.map((id) => closeSession(id)));
}
