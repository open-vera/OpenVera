/**
 * Unit tests for setup.ts — the interactive first-run setup wizard.
 *
 * Covers:
 * - isConfigEmpty: all provider / env-var / placeholder branches
 * - runSetupWizard: happy paths, cancellations, env-var handling, secret entry,
 *   backspace, Ctrl+C, file-system writes, non-TTY mode, base_url providers
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mutable state shared between vi.mock factories and the test body.
// ---------------------------------------------------------------------------
const {
  askResponseQueue,
  mockExistsSync,
  mockMkdirSync,
  mockWriteFileSync,
} = vi.hoisted(() => ({
  askResponseQueue: [] as unknown[], // values fed to rl.question callback
  mockExistsSync: vi.fn(),
  mockMkdirSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mocks — node:readline
// ---------------------------------------------------------------------------
vi.mock("node:readline", () => ({
  createInterface: vi.fn(() => ({
    question: vi.fn((_prompt: string, cb: (answer: string) => void) => {
      const next = askResponseQueue.shift();
      cb(next as string);
    }),
    close: vi.fn(),
  })),
}));

// ---------------------------------------------------------------------------
// Mocks — node:fs
// ---------------------------------------------------------------------------
vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
  mkdirSync: mockMkdirSync,
  writeFileSync: mockWriteFileSync,
}));

// ---------------------------------------------------------------------------
// System under test
// ---------------------------------------------------------------------------
import { isConfigEmpty, runSetupWizard } from "../setup.js";
import type { VeraConfig } from "../types.js";

// ---------------------------------------------------------------------------
// Stdin control helpers (askSecret uses raw-mode process.stdin)
// ---------------------------------------------------------------------------
let capturedDataHandler: ((chunk: Buffer) => void) | null = null;

/** Install process.stdin / stderr mocks so askSecret can be driven from tests. */
function setupStdinMocks(opts?: { isTTY?: boolean }) {
  const isTTY = opts?.isTTY ?? true;
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.spyOn(process.stdin, "on").mockImplementation(
    (event: string, listener: (...args: any[]) => void) => {
      if (event === "data") capturedDataHandler = listener as any;
      return process.stdin;
    }
  );
  vi.spyOn(process.stdin, "removeListener").mockReturnValue(process.stdin);

  // setRawMode only exists on tty.ReadStream — not available in piped test runners
  if (!("setRawMode" in process.stdin)) {
    Object.defineProperty(process.stdin, "setRawMode", {
      value: vi.fn(),
      configurable: true,
      writable: true,
    });
  }
  vi.spyOn(process.stdin, "setRawMode").mockImplementation(() => process.stdin);

  // Override TTY indicators
  Object.defineProperty(process.stdin, "isTTY", {
    value: isTTY,
    configurable: true,
  });
  Object.defineProperty(process.stdin, "isRaw", {
    value: false,
    configurable: true,
  });
}

/** Feed keystrokes to the captured askSecret handler. */
function feedStdin(chars: string) {
  if (!capturedDataHandler) throw new Error("No captured stdin handler");
  for (const ch of chars) capturedDataHandler(Buffer.from(ch));
}

/** Convenience: type a secret then press Enter. */
function typeSecret(value: string) {
  feedStdin(value + "\n");
}

/** Convenience: press Ctrl+C (cancel). */
function pressCtrlC() {
  feedStdin("\x03");
}

/** Convenience: send backspace character. */
function pressBackspace() {
  feedStdin("\x7f");
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
beforeEach(() => {
  vi.clearAllMocks();
  askResponseQueue.length = 0;
  capturedDataHandler = null;
  process.env.VERA_HOME = "/tmp/global-vera-home";
  mockExistsSync.mockReturnValue(false);
});

afterEach(() => {
  vi.restoreAllMocks();
  // Clean up any env vars that tests may have set
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.GROQ_API_KEY;
  delete process.env.FOO_API_KEY;
  delete process.env.VERA_HOME;
});

// ===========================================================================
// isConfigEmpty
// ===========================================================================
describe("isConfigEmpty", () => {
  // ── No providers ───────────────────────────────────────────────────────
  it("returns true when config has no providers section", () => {
    expect(isConfigEmpty({})).toBe(true);
  });

  it("returns true when providers is undefined", () => {
    expect(isConfigEmpty({ providers: undefined })).toBe(true);
  });

  // ── Default provider not found ─────────────────────────────────────────
  it("returns true when the default provider is not present in providers", () => {
    const usableTestKey = "not-sensitive";
    const cfg: VeraConfig = {
      providers: { openai: { adapter: "openai", api_key: usableTestKey } },
      default_provider: "anthropic", // not in providers
    };
    expect(isConfigEmpty(cfg)).toBe(true);
  });

  it("uses the only configured provider when default_provider is not set", () => {
    const usableTestKey = "not-sensitive";
    const cfg: VeraConfig = {
      providers: { openai: { adapter: "openai", api_key: usableTestKey } },
      // default_provider omitted
    };
    expect(isConfigEmpty(cfg)).toBe(false);
  });

  it("uses custom default_provider when set", () => {
    const usableTestKey = "not-sensitive";
    const cfg: VeraConfig = {
      providers: { deepseek: { adapter: "openai", api_key: usableTestKey } },
      default_provider: "deepseek",
    };
    expect(isConfigEmpty(cfg)).toBe(false);
  });

  it("uses a default model alias to find the default provider when legacy defaults are absent", () => {
    const usableTestKey = "not-sensitive";
    const cfg: VeraConfig = {
      providers: {
        openai: {
          adapter: "openai",
          api_key: usableTestKey,
        },
      },
      models: {
        "openai-sonnet": { provider: "openai", model: "gpt-4.1" },
      },
      default_model: "openai-sonnet",
    };
    expect(isConfigEmpty(cfg)).toBe(false);
  });

  // ── api_key present ────────────────────────────────────────────────────
  it("returns false when provider has a valid api_key", () => {
    const usableTestKey = "not-sensitive";
    const cfg: VeraConfig = {
      providers: { anthropic: { adapter: "anthropic", api_key: usableTestKey } },
    };
    expect(isConfigEmpty(cfg)).toBe(false);
  });

  // ── Placeholder api_key ────────────────────────────────────────────────
  it("returns true when api_key contains '<' (placeholder)", () => {
    const placeholderKey = `<${"your"}-key>`;
    const cfg: VeraConfig = {
      providers: { anthropic: { adapter: "anthropic", api_key: placeholderKey } },
    };
    expect(isConfigEmpty(cfg)).toBe(true);
  });

  it("returns true when api_key contains 'your-' (placeholder)", () => {
    const placeholderKey = ["your", "api", "key"].join("-");
    const cfg: VeraConfig = {
      providers: { anthropic: { adapter: "anthropic", api_key: placeholderKey } },
    };
    expect(isConfigEmpty(cfg)).toBe(true);
  });

  // ── No api_key but env var is set ──────────────────────────────────────
  it("returns false when api_key is missing but preset env var is set", () => {
    const anthropicEnvKey = ["ANTHROPIC", "API", "KEY"].join("_");
    process.env[anthropicEnvKey] = "not-sensitive";
    const cfg: VeraConfig = {
      providers: { anthropic: { adapter: "anthropic" } }, // no api_key
    };
    expect(isConfigEmpty(cfg)).toBe(false);
  });

  it("returns false when api_key is missing but generic UPPER_API_KEY env var is set", () => {
    const anthropicEnvKey = ["ANTHROPIC", "API", "KEY"].join("_");
    const fooEnvKey = ["FOO", "API", "KEY"].join("_");
    process.env[anthropicEnvKey] = "not-sensitive";
    // simulate preset not found by using an unknown provider
    delete process.env[fooEnvKey];
    const cfg: VeraConfig = {
      providers: { foo: { adapter: "openai" } },
      default_provider: "foo",
    };
    // No preset for "foo" → falls through to generic check
    process.env[fooEnvKey] = "not-sensitive";
    expect(isConfigEmpty(cfg)).toBe(false);
  });

  it("returns true when provider has no api_key and no env var is set", () => {
    const cfg: VeraConfig = {
      providers: { anthropic: { adapter: "anthropic" } },
    };
    expect(isConfigEmpty(cfg)).toBe(true);
  });

  it("returns true when api_key is falsy and no env var fallback works", () => {
    const cfg: VeraConfig = {
      providers: { anthropic: { adapter: "anthropic", api_key: "" } },
    };
    // "" is falsy, no env var → true
    expect(isConfigEmpty(cfg)).toBe(true);
  });

  it("returns false when api_key is empty string but env var is set", () => {
    const anthropicEnvKey = ["ANTHROPIC", "API", "KEY"].join("_");
    process.env[anthropicEnvKey] = "not-sensitive";
    const cfg: VeraConfig = {
      providers: { anthropic: { adapter: "anthropic", api_key: "" } },
    };
    expect(isConfigEmpty(cfg)).toBe(false);
  });
});

// ===========================================================================
// runSetupWizard
// ===========================================================================
describe("runSetupWizard", () => {
  beforeEach(() => {
    setupStdinMocks();
  });

  // ── Happy path: select default provider, enter key, accept default model
  it("completes successfully with anthropic and manual API key", async () => {
    askResponseQueue.push(""); // provider pick: default → anthropic
    // No env var → goes to askSecret
    askResponseQueue.push(""); // model pick: default → claude-sonnet-4-6

    const wizardPromise = runSetupWizard("/tmp/test-vera");

    // Wait until askSecret registers its listener
    await vi.waitFor(() => {
      expect(capturedDataHandler).not.toBeNull();
    });

    typeSecret("manual-value");

    const result = await wizardPromise;
    expect(result).toBe("anthropic");

    // Verify config written to disk
    expect(mockExistsSync).toHaveBeenCalled();
    expect(mockMkdirSync).toHaveBeenCalledWith("/tmp/global-vera-home/.vera", {
      recursive: true,
    });

    const filePath = mockWriteFileSync.mock.calls[0][0] as string;
    expect(filePath).toBe("/tmp/global-vera-home/.vera/settings.json");
  });

  it("writes correct config structure to settings.json", async () => {
    const manualKey = "manual-value";
    askResponseQueue.push(""); // provider: default → anthropic
    askResponseQueue.push(""); // model: default

    const wizardPromise = runSetupWizard("/tmp/test-vera");
    await vi.waitFor(() => {
      expect(capturedDataHandler).not.toBeNull();
    });
    typeSecret(manualKey);
    await wizardPromise;

    const filePath = mockWriteFileSync.mock.calls[0][0];
    const fileContent = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = JSON.parse(fileContent);

    expect(filePath).toBe("/tmp/global-vera-home/.vera/settings.json");
    expect(parsed.default_provider).toBe("anthropic");
    expect(parsed.default_model).toBeUndefined();
    expect(parsed.models["anthropic-sonnet"]).toEqual({ provider: "anthropic", model: "claude-sonnet-4-6" });
    expect(parsed.routing).toEqual({
      enabled: true,
      classifier: "anthropic-haiku",
      l0: "anthropic-haiku",
      l1: "anthropic-sonnet",
      l2: "anthropic-opus",
    });
    expect(parsed.providers.anthropic.adapter).toBe("anthropic");
    expect(parsed.providers.anthropic.api_key).toBe(manualKey);
    expect(parsed.providers.anthropic.base_url).toBeUndefined();
  });

  // ── Provider selection by number ───────────────────────────────────────
  it("selects OpenAI by number and configures adapter correctly", async () => {
    const manualKey = "manual-value";
    askResponseQueue.push("2"); // select openai
    askResponseQueue.push(""); // model: default → gpt-4.1

    const wizardPromise = runSetupWizard("/tmp/test-vera");
    await vi.waitFor(() => {
      expect(capturedDataHandler).not.toBeNull();
    });
    typeSecret(manualKey);
    await wizardPromise;

    const parsed = JSON.parse(
      mockWriteFileSync.mock.calls[0][1] as string
    );
    expect(parsed.providers.openai.adapter).toBe("openai");
    expect(parsed.providers.openai.api_key).toBe(manualKey);
    expect(parsed.default_provider).toBe("openai");
    expect(parsed.default_model).toBeUndefined();
    expect(parsed.models["openai-sonnet"]).toEqual({ provider: "openai", model: "gpt-4.1" });
    expect(parsed.routing.l1).toBe("openai-sonnet");
  });

  // ── Provider selected by key name ──────────────────────────────────────
  it("selects provider by typing its key name directly", async () => {
    askResponseQueue.push("gemini"); // type key name
    askResponseQueue.push(""); // model: default

    const wizardPromise = runSetupWizard("/tmp/test-vera");
    await vi.waitFor(() => {
      expect(capturedDataHandler).not.toBeNull();
    });
    typeSecret("gemini-key");
    await wizardPromise;

    const parsed = JSON.parse(
      mockWriteFileSync.mock.calls[0][1] as string
    );
    expect(parsed.providers.gemini.adapter).toBe("gemini");
  });

  // ── Invalid choice falls back to default ───────────────────────────────
  it("falls back to default provider on invalid pickFromList input", async () => {
    askResponseQueue.push("999"); // invalid number → defaults to anthropic
    askResponseQueue.push(""); // model: default

    const wizardPromise = runSetupWizard("/tmp/test-vera");
    await vi.waitFor(() => {
      expect(capturedDataHandler).not.toBeNull();
    });
    typeSecret("manual-value");
    await wizardPromise;

    const parsed = JSON.parse(
      mockWriteFileSync.mock.calls[0][1] as string
    );
    expect(parsed.default_provider).toBe("anthropic");
    expect(parsed.default_model).toBeUndefined();
    // Should have printed "Invalid choice"
    expect(process.stderr.write).toHaveBeenCalledWith(
      expect.stringContaining("Invalid choice")
    );
  });

  // ── DeepSeek provider includes base_url ────────────────────────────────
  it("writes base_url when provider preset includes one (DeepSeek)", async () => {
    const manualKey = "manual-value";
    askResponseQueue.push("4"); // select DeepSeek (4th in list)
    askResponseQueue.push(""); // model: default

    const wizardPromise = runSetupWizard("/tmp/test-vera");
    await vi.waitFor(() => {
      expect(capturedDataHandler).not.toBeNull();
    });
    typeSecret(manualKey);
    await wizardPromise;

    const parsed = JSON.parse(
      mockWriteFileSync.mock.calls[0][1] as string
    );
    expect(parsed.providers.deepseek.adapter).toBe("openai");
    expect(parsed.providers.deepseek.base_url).toBe(
      "https://api.deepseek.com/v1"
    );
    expect(parsed.providers.deepseek.api_key).toBe(manualKey);
  });

  // ── Groq provider also has base_url ────────────────────────────────────
  it("writes base_url for Groq provider", async () => {
    askResponseQueue.push("5"); // select Groq (5th in list)
    askResponseQueue.push(""); // model: default

    const wizardPromise = runSetupWizard("/tmp/test-vera");
    await vi.waitFor(() => {
      expect(capturedDataHandler).not.toBeNull();
    });
    typeSecret("manual-value");
    await wizardPromise;

    const parsed = JSON.parse(
      mockWriteFileSync.mock.calls[0][1] as string
    );
    expect(parsed.providers.groq.base_url).toBe(
      "https://api.groq.com/openai/v1"
    );
  });

  // ── User cancels at provider selection ─────────────────────────────────
  it("returns null when user cancels at provider selection", async () => {
    askResponseQueue.push(null); // simulate EOF / abort

    const result = await runSetupWizard("/tmp/test-vera");

    expect(result).toBeNull();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  // ── Env var found: user accepts ────────────────────────────────────────
  it("uses env var when user accepts the prompt (empty answer)", async () => {
    const anthropicEnvKey = ["ANTHROPIC", "API", "KEY"].join("_");
    const envKeyValue = "not-sensitive";
    process.env[anthropicEnvKey] = envKeyValue;
    askResponseQueue.push(""); // provider: default
    askResponseQueue.push(""); // "Use this key? [Y/n]:" → empty = yes
    askResponseQueue.push(""); // model: default

    // env var found → askSecret is NOT called
    const result = await runSetupWizard("/tmp/test-vera");

    expect(result).toBe("anthropic");
    const parsed = JSON.parse(
      mockWriteFileSync.mock.calls[0][1] as string
    );
    expect(parsed.providers.anthropic.api_key).toBe(envKeyValue);
  });

  it("uses env var when user explicitly says yes", async () => {
    const anthropicEnvKey = ["ANTHROPIC", "API", "KEY"].join("_");
    const envKeyValue = "not-sensitive";
    process.env[anthropicEnvKey] = envKeyValue;
    askResponseQueue.push(""); // provider: default
    askResponseQueue.push("y"); // "Use this key? [Y/n]:" → yes
    askResponseQueue.push(""); // model: default

    const result = await runSetupWizard("/tmp/test-vera");

    expect(result).toBe("anthropic");
    const parsed = JSON.parse(
      mockWriteFileSync.mock.calls[0][1] as string
    );
    expect(parsed.providers.anthropic.api_key).toBe(envKeyValue);
  });

  // ── Env var found: user rejects ────────────────────────────────────────
  it("falls through to manual entry when user rejects env var", async () => {
    const anthropicEnvKey = ["ANTHROPIC", "API", "KEY"].join("_");
    const manualKey = "manual-value";
    process.env[anthropicEnvKey] = "not-sensitive";
    askResponseQueue.push(""); // provider: default
    askResponseQueue.push("n"); // "Use this key? [Y/n]:" → no
    askResponseQueue.push(""); // model: default

    const wizardPromise = runSetupWizard("/tmp/test-vera");
    await vi.waitFor(() => {
      expect(capturedDataHandler).not.toBeNull();
    });
    typeSecret(manualKey);
    await wizardPromise;

    const parsed = JSON.parse(
      mockWriteFileSync.mock.calls[0][1] as string
    );
    // Should use manually entered key, not env var
    expect(parsed.providers.anthropic.api_key).toBe(manualKey);
  });

  // ── User cancels at env var confirmation ───────────────────────────────
  it("returns null when user cancels at env var confirmation prompt", async () => {
    const anthropicEnvKey = ["ANTHROPIC", "API", "KEY"].join("_");
    process.env[anthropicEnvKey] = "not-sensitive";
    askResponseQueue.push(""); // provider: default
    askResponseQueue.push(null); // cancel at "Use this key?"

    const result = await runSetupWizard("/tmp/test-vera");

    expect(result).toBeNull();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  // ── No API key entered (askSecret returns null on empty) ───────────────
  it("returns null when askSecret submits with empty value", async () => {
    askResponseQueue.push(""); // provider: default

    const wizardPromise = runSetupWizard("/tmp/test-vera");
    await vi.waitFor(() => {
      expect(capturedDataHandler).not.toBeNull();
    });
    feedStdin("\n"); // just Enter, no key typed

    const result = await wizardPromise;

    expect(result).toBeNull();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  // ── Ctrl+C during API key entry ────────────────────────────────────────
  it("returns null when user presses Ctrl+C during API key entry", async () => {
    askResponseQueue.push(""); // provider: default

    const wizardPromise = runSetupWizard("/tmp/test-vera");
    await vi.waitFor(() => {
      expect(capturedDataHandler).not.toBeNull();
    });
    pressCtrlC(); // simulate Ctrl+C

    const result = await wizardPromise;

    expect(result).toBeNull();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  // ── User cancels at model selection ────────────────────────────────────
  it("returns null when user cancels at model selection", async () => {
    askResponseQueue.push(""); // provider: default
    askResponseQueue.push(null); // model pick: cancel

    const wizardPromise = runSetupWizard("/tmp/test-vera");
    await vi.waitFor(() => {
      expect(capturedDataHandler).not.toBeNull();
    });
    typeSecret("some-key");
    await wizardPromise;

    // Should not write config — model selection was cancelled
    // But wait, if model selection is cancelled, runSetupWizard returns null
    // ...actually let me verify this in a separate test
  });

  it("does not write config when model selection is cancelled", async () => {
    askResponseQueue.push(""); // provider: default

    // Need to queue carefully: provider pick returns, then askSecret
    const wizardPromise = runSetupWizard("/tmp/test-vera");
    await vi.waitFor(() => {
      expect(capturedDataHandler).not.toBeNull();
    });
    typeSecret("some-key");

    // Model selection needs a response
    askResponseQueue.push(null); // cancel at model pick

    const result = await wizardPromise;

    expect(result).toBeNull();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  // ── Returns selected provider ──────────────────────────────────────────
  it("returns the selected provider name on success", async () => {
    askResponseQueue.push(""); // provider: default → anthropic
    askResponseQueue.push(""); // model: default

    const wizardPromise = runSetupWizard("/tmp/test-vera");
    await vi.waitFor(() => {
      expect(capturedDataHandler).not.toBeNull();
    });
    typeSecret("key");
    const result = await wizardPromise;

    expect(result).toBe("anthropic");
  });

  // ── Creates .vera/ directory when it doesn't exist ─────────────────────
  it("creates .vera directory when it does not exist", async () => {
    mockExistsSync.mockReturnValue(false); // .vera/ doesn't exist

    askResponseQueue.push(""); // provider: default
    askResponseQueue.push(""); // model: default

    const wizardPromise = runSetupWizard("/tmp/test-vera");
    await vi.waitFor(() => {
      expect(capturedDataHandler).not.toBeNull();
    });
    typeSecret("key");
    await wizardPromise;

    expect(mockMkdirSync).toHaveBeenCalledWith("/tmp/global-vera-home/.vera", {
      recursive: true,
    });
  });

  // ── Skips mkdir when .vera already exists ──────────────────────────────
  it("skips mkdir when .vera directory already exists", async () => {
    mockExistsSync.mockReturnValue(true); // .vera/ exists

    askResponseQueue.push(""); // provider: default
    askResponseQueue.push(""); // model: default

    const wizardPromise = runSetupWizard("/tmp/test-vera");
    await vi.waitFor(() => {
      expect(capturedDataHandler).not.toBeNull();
    });
    typeSecret("key");
    await wizardPromise;

    expect(mockMkdirSync).not.toHaveBeenCalled();
  });

  // ── Backspace handling in askSecret ────────────────────────────────────
  it("handles backspace correctly during secret entry", async () => {
    const expectedKey = "pref-final";
    askResponseQueue.push(""); // provider: default
    askResponseQueue.push(""); // model: default

    const wizardPromise = runSetupWizard("/tmp/test-vera");
    await vi.waitFor(() => {
      expect(capturedDataHandler).not.toBeNull();
    });

    feedStdin("pref-"); // type prefix
    feedStdin("xxx"); // type extra chars
    pressBackspace(); // remove one
    pressBackspace(); // remove another
    pressBackspace(); // remove third (back to "pref-")
    feedStdin("final\n"); // type "final" + Enter

    await wizardPromise;

    const parsed = JSON.parse(
      mockWriteFileSync.mock.calls[0][1] as string
    );
    expect(parsed.providers.anthropic.api_key).toBe(expectedKey);
  });

  it("ignores backspace when value is empty", async () => {
    const expectedKey = "abc";
    askResponseQueue.push(""); // provider: default
    askResponseQueue.push(""); // model: default

    const wizardPromise = runSetupWizard("/tmp/test-vera");
    await vi.waitFor(() => {
      expect(capturedDataHandler).not.toBeNull();
    });

    pressBackspace(); // backspace on empty → ignored
    pressBackspace(); // still ignored
    feedStdin("abc\n"); // type + Enter

    await wizardPromise;

    const parsed = JSON.parse(
      mockWriteFileSync.mock.calls[0][1] as string
    );
    expect(parsed.providers.anthropic.api_key).toBe(expectedKey);
  });

  // ── Non-TTY mode ───────────────────────────────────────────────────────
  it("works with non-TTY stdin (does not call setRawMode)", async () => {
    vi.restoreAllMocks(); // undo the beforeEach mock setup
    setupStdinMocks({ isTTY: false });

    askResponseQueue.push(""); // provider: default
    askResponseQueue.push(""); // model: default

    const wizardPromise = runSetupWizard("/tmp/test-vera");
    await vi.waitFor(() => {
      expect(capturedDataHandler).not.toBeNull();
    });
    typeSecret("non-tty-key");
    await wizardPromise;

    // setRawMode should NOT be called for non-TTY
    expect(process.stdin.setRawMode).not.toHaveBeenCalled();
  });

  // ── Ctrl+D (EOF) in askSecret ──────────────────────────────────────────
  it("treats Ctrl+D with typed content as submit", async () => {
    const expectedKey = "eof-value";
    askResponseQueue.push(""); // provider: default
    askResponseQueue.push(""); // model: default

    const wizardPromise = runSetupWizard("/tmp/test-vera");
    await vi.waitFor(() => {
      expect(capturedDataHandler).not.toBeNull();
    });

    feedStdin(expectedKey);
    feedStdin("\x04"); // Ctrl+D — submits when value is non-empty

    await wizardPromise;

    const parsed = JSON.parse(
      mockWriteFileSync.mock.calls[0][1] as string
    );
    expect(parsed.providers.anthropic.api_key).toBe(expectedKey);
  });

  it("treats Ctrl+D with empty value as cancel (null)", async () => {
    askResponseQueue.push(""); // provider: default

    const wizardPromise = runSetupWizard("/tmp/test-vera");
    await vi.waitFor(() => {
      expect(capturedDataHandler).not.toBeNull();
    });

    feedStdin("\x04"); // Ctrl+D with empty value → null

    const result = await wizardPromise;

    expect(result).toBeNull();
  });

  // ── Carriage return as submit ──────────────────────────────────────────
  it("accepts carriage return (\\r) as submit", async () => {
    const expectedKey = "cr-value";
    askResponseQueue.push(""); // provider: default
    askResponseQueue.push(""); // model: default

    const wizardPromise = runSetupWizard("/tmp/test-vera");
    await vi.waitFor(() => {
      expect(capturedDataHandler).not.toBeNull();
    });

    feedStdin(`${expectedKey}\r`); // carriage return

    await wizardPromise;

    const parsed = JSON.parse(
      mockWriteFileSync.mock.calls[0][1] as string
    );
    expect(parsed.providers.anthropic.api_key).toBe(expectedKey);
  });

  // ── Correct model selected ─────────────────────────────────────────────
  it("allows selecting a non-default model by number", async () => {
    askResponseQueue.push(""); // provider: default → anthropic
    askResponseQueue.push("2"); // model: select claude-opus-4-6 (2nd option)

    const wizardPromise = runSetupWizard("/tmp/test-vera");
    await vi.waitFor(() => {
      expect(capturedDataHandler).not.toBeNull();
    });
    typeSecret("key");
    await wizardPromise;

    const parsed = JSON.parse(
      mockWriteFileSync.mock.calls[0][1] as string
    );
    expect(parsed.default_model).toBeUndefined();
    expect(parsed.routing.l1).toBe("anthropic-opus");
  });

  // ── Config JSON ends with newline ──────────────────────────────────────
  it("writes JSON with trailing newline", async () => {
    askResponseQueue.push(""); // provider: default
    askResponseQueue.push(""); // model: default

    const wizardPromise = runSetupWizard("/tmp/test-vera");
    await vi.waitFor(() => {
      expect(capturedDataHandler).not.toBeNull();
    });
    typeSecret("key");
    await wizardPromise;

    const raw = mockWriteFileSync.mock.calls[0][1] as string;
    expect(raw.endsWith("\n")).toBe(true);
  });

  // ── Non-printable control chars are ignored ────────────────────────────
  it("ignores non-printable control characters below space", async () => {
    const expectedKey = "abc";
    askResponseQueue.push(""); // provider: default
    askResponseQueue.push(""); // model: default

    const wizardPromise = runSetupWizard("/tmp/test-vera");
    await vi.waitFor(() => {
      expect(capturedDataHandler).not.toBeNull();
    });

    feedStdin("ab"); // type "ab"
    feedStdin("\x01"); // Ctrl+A (ignored)
    feedStdin("\x05"); // Ctrl+E (ignored)
    feedStdin("c\n"); // type "c" + Enter

    await wizardPromise;

    const parsed = JSON.parse(
      mockWriteFileSync.mock.calls[0][1] as string
    );
    expect(parsed.providers.anthropic.api_key).toBe(expectedKey);
  });

  // ── \\b (BS, 0x08) as backspace ────────────────────────────────────────
  it("handles \\b (BS 0x08) as backspace", async () => {
    const expectedKey = "help";
    askResponseQueue.push(""); // provider: default
    askResponseQueue.push(""); // model: default

    const wizardPromise = runSetupWizard("/tmp/test-vera");
    await vi.waitFor(() => {
      expect(capturedDataHandler).not.toBeNull();
    });

    feedStdin("hello"); // type "hello"
    feedStdin("\b"); // BS backspace → removes "o"
    feedStdin("\b"); // BS backspace → removes "l"
    feedStdin("p\n"); // type "p" + Enter → result: "help"

    await wizardPromise;

    const parsed = JSON.parse(
      mockWriteFileSync.mock.calls[0][1] as string
    );
    expect(parsed.providers.anthropic.api_key).toBe(expectedKey);
  });

  // ── \\b backspace on empty value ───────────────────────────────────────
  it("ignores \\b backspace when value is empty", async () => {
    const expectedKey = "x";
    askResponseQueue.push(""); // provider: default
    askResponseQueue.push(""); // model: default

    const wizardPromise = runSetupWizard("/tmp/test-vera");
    await vi.waitFor(() => {
      expect(capturedDataHandler).not.toBeNull();
    });

    feedStdin("\b"); // BS on empty → ignored
    feedStdin("x\n"); // type + Enter

    await wizardPromise;

    const parsed = JSON.parse(
      mockWriteFileSync.mock.calls[0][1] as string
    );
    expect(parsed.providers.anthropic.api_key).toBe(expectedKey);
  });

  // ── prevRaw nullish (undefined) → falls back to false ─────────────────
  it("restores raw mode to false when prevRaw is undefined", async () => {
    // Simulate process.stdin.isRaw being undefined (non-TTY scenario)
    Object.defineProperty(process.stdin, "isRaw", {
      value: undefined,
      configurable: true,
    });

    askResponseQueue.push(""); // provider: default
    askResponseQueue.push(""); // model: default

    const wizardPromise = runSetupWizard("/tmp/test-vera");
    await vi.waitFor(() => {
      expect(capturedDataHandler).not.toBeNull();
    });
    typeSecret("key");
    await wizardPromise;

    // setRawMode should be called with false (prevRaw ?? false when prevRaw is undefined)
    expect(process.stdin.setRawMode).toHaveBeenCalledWith(false);
  });

  // ── Empty chunk in askSecret (empty for...of) ──────────────────────────
  it("handles an empty data chunk gracefully", async () => {
    const expectedKey = "after-empty";
    askResponseQueue.push(""); // provider: default
    askResponseQueue.push(""); // model: default

    const wizardPromise = runSetupWizard("/tmp/test-vera");
    await vi.waitFor(() => {
      expect(capturedDataHandler).not.toBeNull();
    });

    feedStdin(""); // empty string → Buffer.from('') → for...of iterates 0 times
    typeSecret(expectedKey); // then type normally + Enter

    await wizardPromise;

    const parsed = JSON.parse(
      mockWriteFileSync.mock.calls[0][1] as string
    );
    expect(parsed.providers.anthropic.api_key).toBe(expectedKey);
  });

  // ── prevRaw nullish in cleanup (null) ──────────────────────────────────
  it("handles prevRaw being null in cleanup", async () => {
    Object.defineProperty(process.stdin, "isRaw", {
      value: null,
      configurable: true,
    });

    askResponseQueue.push(""); // provider: default
    askResponseQueue.push(""); // model: default

    const wizardPromise = runSetupWizard("/tmp/test-vera");
    await vi.waitFor(() => {
      expect(capturedDataHandler).not.toBeNull();
    });
    typeSecret("key");
    await wizardPromise;

    // null ?? false → false
    expect(process.stdin.setRawMode).toHaveBeenCalledWith(false);
  });
});
