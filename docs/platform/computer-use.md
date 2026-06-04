# Computer Use -- Desktop and Browser Automation

## Overview

Enables agents to directly operate UIs: open web pages, fill forms, click buttons, take screenshots for verification, and control native desktop applications. This is the core capability that moves agents from "language tasks" to "actual execution."

Computer Use is exposed as a **unified meta-tool** (`computer_use`) to the agent loop: agents simply describe the task goal, and the meta-tool automatically detects the environment and routes to the appropriate sub-tool. It also supports **composite task decomposition** and **multi-step orchestration**, enabling complex workflows like "open a website, log in, download a file, and parse it" in a single call.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────┐
│            computer_use (Meta-tool)              │
│  Environment detection → Task decomposition     │
│  → Single dispatch / Multi-step orchestration    │
├─────────────────────────────────────────────────┤
│  Sub-tools (6)                                  │
│  ├─ browser          Playwright browser control  │
│  ├─ desktop_input    Mouse/keyboard simulation  │
│  ├─ desktop_script   Script execution           │
│  ├─ desktop_screenshot  Desktop screenshot      │
│  ├─ desktop_accessibility  Accessibility tree   │
│  └─ bash             Shell command execution    │
├─────────────────────────────────────────────────┤
│  MultiStepOrchestrator (orchestration engine)    │
│  Sequential execution · Variable passing        │
│  · Conditional branching · Retry/skip on error  │
└─────────────────────────────────────────────────┘
```

Meta-tool execution flow:

```
agent → tool_call: computer_use({ task: "open example.com and screenshot" })
      → Detect environment (browser / desktop / cli)
      → Try multi-step orchestration (login / downloadAndParse patterns)
      → Try simple task decomposition (navigate+screenshot combos)
      → Single dispatch (route to specific sub-tool)
      → Return result
```

---

## Automatic Environment Detection

`computer_use` automatically determines the target environment from keywords in the task description:

| Environment | Trigger Keywords |
|-------------|------------------|
| `browser` | website, url, http, navigate, browse, web page, click link, fill form, login, browser, chromium, chrome, playwright |
| `desktop` | desktop, mouse, keyboard, click at, type text, hotkey, shortcut, finder, spotlight, drag, scroll, double click, right click |
| `cli` | run command, shell, execute, terminal, install, npm, pnpm, git, curl, docker, apt, brew, pip |

Detection logic: scores are counted per environment based on keyword matches; the highest scorer wins. Ties favor `browser` if a URL is present in the task, otherwise `cli`.

You can also explicitly set the `environment` parameter: `"browser" | "desktop" | "cli" | "auto"` (default is `"auto"`).

---

## computer_use Meta-tool

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task` | string | Yes | High-level task description, e.g. `"navigate to example.com and take a screenshot"` |
| `environment` | string | No | Target environment: `auto` (default) / `browser` / `desktop` / `cli` |
| `action` | string | No | Explicit sub-action override, e.g. `navigate`, `click`, `screenshot` |
| `url` | string | No | Browser navigation target URL |
| `selector` | string | No | CSS selector |
| `text` | string | No | Text to type (browser or desktop) |
| `expression` | string | No | JavaScript expression for browser evaluate |
| `inputAction` | string | No | Desktop input action: `click` / `doubleClick` / `rightClick` / `move` / `type` / `key` / `hotkey` / `scroll` |
| `x` / `y` | number | No | Desktop mouse coordinates |
| `key` | string | No | Desktop key name |
| `modifiers` | string[] | No | Modifier keys, e.g. `["ctrl", "shift"]` |
| `script` | string | No | Desktop script content |
| `scriptType` | string | No | Script type: `applescript` / `shell` / `javascript` |
| `command` | string | No | Shell command for CLI environment |
| `screenshotPath` | string | No | Screenshot output path |
| `timeout` | number | No | Timeout override in ms, default 120000 |

### Risk Level: `medium`

### Task Decomposition

The meta-tool supports three execution paths:

1. **Multi-step orchestration** (priority): Matches complex patterns (login flows, download-and-parse) and uses `MultiStepOrchestrator`
2. **Simple composite decomposition**: Matches predefined composite patterns in `decomposeTask` (navigate+screenshot, navigate+click, navigate+type) and executes sub-steps sequentially
3. **Single dispatch**: Routes the task to the best-matching sub-tool

---

## browser -- Browser Automation

Playwright-based Chromium driver supporting 18 actions.

### Technical Approach

- **Playwright** (default): Launches headless Chromium; headed mode available for debugging
- **CDP direct**: Use the `connect` action to attach to an existing Chrome instance (via the `cdpUrl` parameter, e.g. `http://localhost:9222`), operating on the user's current browser
- **Session management**: Each session maintains an independent browser context with cookie persistence and multi-tab management

### Actions

| Action | Description | Required Parameters |
|--------|-------------|---------------------|
| `navigate` | Navigate to a URL | `url` |
| `click` | Click an element | `selector` |
| `type` | Type text into an element | `selector`, `text` |
| `screenshot` | Capture page screenshot | None (optional `path`, `fullPage`) |
| `evaluate` | Execute JS in the page | `expression` |
| `waitForSelector` | Wait for an element to appear | `selector` |
| `close` | Close browser session | None |
| `connect` | Connect to existing Chrome via CDP | `cdpUrl` |
| `disconnect` | Disconnect CDP session | None |
| `newTab` | Open a new tab | None (optional `url`) |
| `switchTab` | Switch to a specific tab | `tabIndex` |
| `closeTab` | Close a specific tab | `tabIndex` |
| `listTabs` | List all tab information | None |
| `saveCookies` | Save cookies to file | `sessionPath` |
| `loadCookies` | Load cookies from file | `sessionPath` |
| `saveSession` | Save full session (cookies + tabs) | `sessionPath` |
| `loadSession` | Restore full session | `sessionPath` |

### Configuration Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `timeout` | number | 30000 | Operation timeout in ms |
| `headed` | boolean | false | Headed mode for debugging |
| `width` | number | 1280 | Viewport width |
| `height` | number | 720 | Viewport height |
| `fullPage` | boolean | false | Full-page screenshot |
| `waitUntil` | string | `"load"` | Navigation completion condition: `load` / `domcontentloaded` / `networkidle` |

### Risk Level: `medium`

### Usage Examples

```json
// Navigate and take a screenshot
{ "action": "navigate", "url": "https://example.com" }
{ "action": "screenshot", "path": "/tmp/page.png", "fullPage": true }

// CDP connect to an existing Chrome (start it first: chrome --remote-debugging-port=9222)
{ "action": "connect", "cdpUrl": "http://localhost:9222" }

// Save and restore sessions
{ "action": "saveSession", "sessionPath": "/tmp/session.json" }
{ "action": "loadSession", "sessionPath": "/tmp/session.json" }
```

---

## desktop_input -- Mouse and Keyboard Simulation

Cross-platform input simulation tool that controls mouse and keyboard at the system level.

### Platform Support

| Platform | Approach | Install Command |
|----------|----------|-----------------|
| macOS | cliclick + osascript | `brew install cliclick` |
| Linux | xdotool | `sudo apt install xdotool` |

### Actions

| Action | Description | Required Parameters |
|--------|-------------|---------------------|
| `click` | Left mouse click | `x`, `y` |
| `doubleClick` | Left mouse double-click | `x`, `y` |
| `rightClick` | Right mouse click | `x`, `y` |
| `move` | Move mouse | `x`, `y` |
| `type` | Type text | `text` |
| `key` | Press a single key | `key` |
| `hotkey` | Key combination | `key`, `modifiers` |
| `scroll` | Scroll wheel | `scrollX` or `scrollY` |

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | string | Yes | Input action |
| `x` / `y` | number | Per action | Coordinates |
| `text` | string | Per action | Text to type |
| `key` | string | Per action | Key name, supports `return`, `tab`, `escape`, `backspace`, `space`, arrow keys, etc. |
| `modifiers` | string[] | Per action | Modifier keys: `ctrl`/`control`, `cmd`/`command`, `alt`/`option`, `shift` |
| `scrollX` / `scrollY` | number | Per action | Scroll amount (positive = down/right) |
| `typeDelay` | number | No | Keystroke delay in ms |

### Risk Level: `medium`

---

## desktop_script -- Script Execution

Executes scripts in the desktop environment for system application control.

### Script Types

| Type | Platform | Use Case | Underlying Mechanism |
|------|----------|----------|----------------------|
| `applescript` | macOS only | Control Finder, Safari, and other system apps | `osascript -e` |
| `shell` | Cross-platform | General shell commands | `child_process.exec` |
| `javascript` | macOS only | Access UI elements via osascript JS | `osascript -l JavaScript -e` |

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `type` | string | Yes | Script type |
| `script` | string | Yes | Script content |
| `timeout` | number | No | Timeout in ms, default 30000 |
| `cwd` | string | No | Working directory (shell only) |
| `env` | object | No | Environment variables (shell only) |

### Risk Level: `high`

### Usage Examples

```json
// macOS: Activate Safari
{ "type": "applescript", "script": "tell application \"Safari\" to activate" }

// Cross-platform: List processes
{ "type": "shell", "script": "ps aux | head -20" }

// macOS: Access UI elements via JavaScript
{ "type": "javascript", "script": "Application('System Events').processes[0].name()" }
```

---

## desktop_screenshot -- Desktop Screenshot

Captures the desktop screen. Supports fullscreen, window, and region modes.

### Platform Support

| Platform | Approach |
|----------|----------|
| macOS | `screencapture` (native) |
| Linux | scrot → import (ImageMagick) → gnome-screenshot (auto-fallback) |

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `mode` | string | No | Screenshot mode: `fullscreen` (default) / `window` / `region` |
| `path` | string | No | Output path (auto-generated in cwd by default) |
| `delay` | number | No | Delay in seconds |
| `format` | string | No | Image format: `png` (default) / `jpg` |
| `windowTitle` | string | No | Window title (macOS only, for window mode) |
| `display` | number | No | Display index (macOS only, multi-monitor) |

### Risk Level: `low`

---

## desktop_accessibility -- Accessibility Tree Inspection

Inspects UI element structure and properties through the system Accessibility API, enabling agents to "see" on-screen elements without relying on vision models.

### Platform Support

| Platform | Approach |
|----------|----------|
| macOS | osascript -l JavaScript (AXUIElement, full support) |
| Linux | wmctrl / xdotool (limited, no element tree) |

### Actions

| Action | Description | Required Parameters |
|--------|-------------|---------------------|
| `listApps` | List all visible apps (including bundleId, PID) | None |
| `listWindows` | List all windows of a specific app (position, size) | `appName` |
| `getFocusedElement` | Get the currently focused window info | None |
| `dumpTree` | Export UI element hierarchy tree (role, title, value, enabled, position, size) | `appName` |

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | string | Yes | Action |
| `appName` | string | Per action | Application name |
| `maxDepth` | number | No | Max tree depth for dumpTree, default 3 |

### Risk Level: `low`

### Returned UIElement Structure

```ts
interface UIElement {
  role?: string;        // AXRole: button, textField, window...
  title?: string;       // Element title
  value?: string;       // Current value
  description?: string; // Accessibility description
  enabled?: boolean;    // Whether the element is enabled
  position?: { x: number; y: number };
  size?: { width: number; height: number };
  children?: UIElement[]; // Child elements (depth controlled by maxDepth, max 20)
}
```

---

## MultiStepOrchestrator -- Multi-Step Orchestration Engine

The orchestration engine combines multiple tool calls into an ordered execution sequence, supporting variable passing, conditional branching, and error recovery.

### Core Features

| Feature | Description |
|---------|-------------|
| **Sequential execution** | Steps execute in defined order; a preceding step's output can serve as the next step's input |
| **Variable passing** | `${stepId.output}` references the output content of a preceding step |
| **Conditional branching** | Whether a step executes is determined by the result of a preceding step |
| **Error recovery** | Three strategies: `abort` (terminate), `skip` (skip and continue), `retry` (retry) |
| **Timeout control** | Global timeout (default 5 minutes) + per-step independent timeout |

### StepDefinition Structure

```ts
interface StepDefinition {
  id: string;            // Unique step identifier
  tool: string;          // Tool name (browser, bash, visual_analyze, etc.)
  args: Record<string, unknown>; // Tool arguments, supports ${var} interpolation
  description?: string;  // Human-readable description
  onError?: "abort" | "skip" | "retry"; // Default "abort"
  maxRetries?: number;   // Max retries, default 0
  condition?: StepCondition; // Execution condition
  timeoutMs?: number;    // Per-step timeout
}
```

### Condition Operators

| Operator | Description |
|----------|-------------|
| `success` | Preceding step executed successfully |
| `failure` | Preceding step failed |
| `contains` | Preceding step output contains the specified string |
| `equals` | Preceding step output equals the specified string |
| `matches` | Preceding step output matches the regex |

### Predefined Patterns (StepPatterns)

The orchestration engine includes three built-in composite patterns for direct use:

| Pattern | Step Sequence | Use Case |
|---------|---------------|----------|
| `browseAndAnalyze(url)` | navigate → screenshot → visual_analyze | Open a webpage, screenshot, and analyze with LLM vision |
| `login(url, credentials)` | navigate → fill_username → fill_password → submit | Automated login flow |
| `downloadAndParse(url, selector, cmd)` | navigate → click_download → wait → parse | Download a file and parse with a command |

---

## Security Model

Computer use capabilities are powerful and directly operate on real systems, requiring strict security boundaries:

| Restriction | Policy |
|-------------|--------|
| Risk grading | Each sub-tool has a risk label: `low` (screenshot/accessibility), `medium` (browser/input), `high` (script) |
| Script execution | `desktop_script` marked as `high` risk, requires user confirmation |
| CDP connection | Only localhost CDP endpoints are allowed |
| Browser isolation | Each session uses an independent Playwright context, isolating cookies and storage |
| Operation audit | Every tool call logs complete args and result |

---

## Sandbox Integration

Computer use tools integrate with the sandbox system through `ToolContext`:

- **sandboxProvider**: When a sandbox provider is injected into `ToolContext`, script execution can be confined within the sandbox
- **allowedPaths**: File paths for screenshots and scripts are constrained by the `allowedPaths` allowlist
- **dryRun**: Dry-run mode is supported; tools return simulated results

---

## Current Status

| Component | Status | Notes |
|-----------|--------|-------|
| `computer_use` meta-tool | Complete | Environment detection, task decomposition, single/multi-step dispatch |
| `browser` | Complete | Playwright + CDP dual mode, 18 actions |
| `desktop_input` | Complete | macOS (cliclick/osascript) + Linux (xdotool) |
| `desktop_script` | Complete | AppleScript + Shell + JavaScript (osascript) |
| `desktop_screenshot` | Complete | macOS (screencapture) + Linux (scrot/import) |
| `desktop_accessibility` | Complete | macOS full support, Linux limited |
| `MultiStepOrchestrator` | Complete | Variable passing, conditional branching, error recovery, predefined patterns |
| Visual localization (visual_analyze) | Complete | Created dynamically via `createVisualAnalyzeTool`, depends on LLM adapter |
| Windows support | Not implemented | Currently macOS and Linux only |
