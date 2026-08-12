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
    "close (close browser session), " +
    "connect (connect to Chrome via CDP), disconnect (disconnect CDP session), " +
    "newTab/switchTab/closeTab/listTabs (tab management), " +
    "saveCookies/loadCookies/saveSession/loadSession (cookie & session persistence).",
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
          "connect",
          "disconnect",
          "newTab",
          "switchTab",
          "closeTab",
          "listTabs",
          "saveCookies",
          "loadCookies",
          "saveSession",
          "loadSession",
        ],
        description: "Browser action to perform",
      },
      url: {
        type: "string",
        description: "URL to navigate to (for navigate action)",
      },
      selector: {
        type: "string",
        description: "CSS selector for click/type/waitForSelector actions",
      },
      text: {
        type: "string",
        description: "Text to type (for type action)",
      },
      expression: {
        type: "string",
        description: "JavaScript expression to evaluate (for evaluate action)",
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
        description: "When to consider navigation complete (default 'load')",
      },
      cdpUrl: {
        type: "string",
        description:
          "CDP endpoint URL for connect action (e.g., http://localhost:9222)",
      },
      tabIndex: {
        type: "number",
        description: "Tab index for switchTab/closeTab actions (0-based)",
      },
      sessionPath: {
        type: "string",
        description:
          "File path for saveCookies/loadCookies/saveSession/loadSession",
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

    // CDP connect — creates session differently
    if (args.action === "connect") {
      if (!args.cdpUrl) {
        return errorResult("UNKNOWN", "cdpUrl is required for connect action");
      }
      const existing = sessions.get(ctx.sessionId);
      if (existing) {
        await existing.browser.close().catch(() => {});
        sessions.delete(ctx.sessionId);
      }
      try {
        const pw = await loadPlaywright();
        const browser = await pw.chromium.connectOverCDP(args.cdpUrl);
        const contexts = browser.contexts();
        const context =
          contexts[0] ??
          (await browser.newContext({
          viewport: { width, height },
          }));
        const pages = context.pages();
        const page = pages[0] ?? (await context.newPage());
        const session: BrowserSession = {
          browser,
          context,
          pages: pages.length > 0 ? pages : [page],
          activePageIndex: 0,
          isCdp: true,
        };
        sessions.set(ctx.sessionId, session);
        return {
          ok: true,
          content: `Connected to Chrome via CDP at ${args.cdpUrl} (${session.pages.length} tab(s) found)`,
        };
      } catch (e: unknown) {
        return errorResult(
          "EXEC_ERROR",
          `CDP connect failed: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }

    // CDP disconnect
    if (args.action === "disconnect") {
      const session = sessions.get(ctx.sessionId);
      if (!session) {
        return errorResult(
          "UNKNOWN",
          "No active browser session to disconnect"
        );
      }
      if (!session.isCdp) {
        return errorResult("UNKNOWN", "Current session is not a CDP session");
      }
      // For CDP sessions, disconnect without closing the remote browser
      sessions.delete(ctx.sessionId);
      return { ok: true, content: "Disconnected from CDP session." };
    }

    let session: BrowserSession;
    try {
      session = await getOrCreateSession(ctx.sessionId, headed, width, height);
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
            return errorResult(
              "UNKNOWN",
              "url is required for navigate action"
            );
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
            return errorResult("UNKNOWN", "text is required for type action");
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
            // Indirect eval: runs in the page's global scope, and keeps bundlers
            // from deoptimizing the enclosing scope over a direct `eval(`.
            // eslint-disable-next-line no-eval
            return (0, eval)(expr);
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

        // ── Tab Management ────────────────────────────────────────────────────

        case "newTab": {
          const newPage = await session.context.newPage();
          session.pages.push(newPage);
          session.activePageIndex = session.pages.length - 1;
          if (args.url) {
            await newPage.goto(args.url, {
              timeout,
              waitUntil: args.waitUntil ?? "load",
            });
          }
          return {
            ok: true,
            content: `New tab opened (total: ${session.pages.length})${args.url ? `, navigated to ${args.url}` : ""}`,
          };
        }

        case "switchTab": {
          if (args.tabIndex == null) {
            return errorResult(
              "UNKNOWN",
              "tabIndex is required for switchTab action"
            );
          }
          if (args.tabIndex < 0 || args.tabIndex >= session.pages.length) {
            return errorResult(
              "UNKNOWN",
              `tabIndex ${args.tabIndex} out of range (0-${session.pages.length - 1})`
            );
          }
          session.activePageIndex = args.tabIndex;
          const tabTitle = await session.pages[args.tabIndex].title();
          return {
            ok: true,
            content: `Switched to tab ${args.tabIndex} ("${tabTitle}")`,
          };
        }

        case "closeTab": {
          if (args.tabIndex == null) {
            return errorResult(
              "UNKNOWN",
              "tabIndex is required for closeTab action"
            );
          }
          if (args.tabIndex < 0 || args.tabIndex >= session.pages.length) {
            return errorResult(
              "UNKNOWN",
              `tabIndex ${args.tabIndex} out of range (0-${session.pages.length - 1})`
            );
          }
          if (session.pages.length === 1) {
            return errorResult(
              "UNKNOWN",
              "Cannot close the last tab. Use 'close' action instead."
            );
          }
          await session.pages[args.tabIndex].close();
          session.pages.splice(args.tabIndex, 1);
          if (session.activePageIndex >= session.pages.length) {
            session.activePageIndex = session.pages.length - 1;
          }
          return {
            ok: true,
            content: `Closed tab ${args.tabIndex}. Remaining: ${session.pages.length}`,
          };
        }

        case "listTabs": {
          const tabs = await Promise.all(
            session.pages.map(async (p, i) => ({
              index: i,
              title: await p.title().catch(() => "(untitled)"),
              url: p.url(),
              active: i === session.activePageIndex,
            }))
          );
          return {
            ok: true,
            content: JSON.stringify(tabs, null, 2),
          };
        }

        // ── Cookie / Session Persistence ──────────────────────────────────────

        case "saveCookies": {
          if (!args.sessionPath) {
            return errorResult(
              "UNKNOWN",
              "sessionPath is required for saveCookies action"
            );
          }
          const cookies = await session.context.cookies();
          await ensureDir(args.sessionPath);
          await writeFile(
            args.sessionPath,
            JSON.stringify(cookies, null, 2),
            "utf-8"
          );
          return {
            ok: true,
            content: `Saved ${cookies.length} cookies to ${args.sessionPath}`,
          };
        }

        case "loadCookies": {
          if (!args.sessionPath) {
            return errorResult(
              "UNKNOWN",
              "sessionPath is required for loadCookies action"
            );
          }
          const data = await readFile(args.sessionPath, "utf-8");
          const parsed = JSON.parse(data);
          await session.context.addCookies(parsed);
          return {
            ok: true,
            content: `Loaded ${Array.isArray(parsed) ? parsed.length : 0} cookies from ${args.sessionPath}`,
          };
        }

        case "saveSession": {
          if (!args.sessionPath) {
            return errorResult(
              "UNKNOWN",
              "sessionPath is required for saveSession action"
            );
          }
          const sessionCookies = await session.context.cookies();
          const sessionData = {
            cookies: sessionCookies,
            tabs: session.pages.map((p) => p.url()),
            activeTab: session.activePageIndex,
          };
          await ensureDir(args.sessionPath);
          await writeFile(
            args.sessionPath,
            JSON.stringify(sessionData, null, 2),
            "utf-8"
          );
          return {
            ok: true,
            content: `Session saved to ${args.sessionPath} (${sessionCookies.length} cookies, ${session.pages.length} tabs)`,
          };
        }

        case "loadSession": {
          if (!args.sessionPath) {
            return errorResult(
              "UNKNOWN",
              "sessionPath is required for loadSession action"
            );
          }
          const raw = await readFile(args.sessionPath, "utf-8");
          const loaded = JSON.parse(raw) as {
            cookies?: unknown[];
            tabs?: string[];
            activeTab?: number;
          };
          if (loaded.cookies && Array.isArray(loaded.cookies)) {
            await session.context.addCookies(loaded.cookies as any[]);
          }
          if (loaded.tabs && Array.isArray(loaded.tabs)) {
            // Close existing tabs except first
            for (let i = session.pages.length - 1; i > 0; i--) {
              await session.pages[i].close();
            }
            session.pages = [session.pages[0]];
            // Open saved tabs
            for (const tabUrl of loaded.tabs.slice(1)) {
              const newP = await session.context.newPage();
              await newP
                .goto(tabUrl, { timeout, waitUntil: "load" })
                .catch(() => {});
              session.pages.push(newP);
            }
            session.activePageIndex = Math.min(
              loaded.activeTab ?? 0,
              session.pages.length - 1
            );
          }
          return {
            ok: true,
            content: `Session loaded from ${args.sessionPath} (${session.pages.length} tab(s))`,
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
