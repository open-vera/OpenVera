/**
 * Interactive setup wizard for OpenVera.
 *
 * Prompts the user to select a provider, enter an API key, and choose a
 * default model. Writes the result to the resolved config location.
 *
 * All UI output goes to stderr so Ink (which owns stdout) is not polluted.
 */

import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { resolveConfigLocation, writeConfig } from "./loader.js";
import { resolveDefaultTarget } from "./model-tiers.js";
import { PROVIDER_PRESETS, type ProviderPreset } from "./providers.js";
import type { VeraConfig } from "./types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function out(msg: string) {
  process.stderr.write(msg + "\n");
}

function buildModels(provider: string, preset: ProviderPreset, selectedModel: string): NonNullable<VeraConfig["models"]> {
  const [first, second, third] = preset.models;
  if (provider === "anthropic") {
    return {
      "anthropic-haiku": { provider, model: "claude-haiku-4-5" },
      "anthropic-sonnet": { provider, model: selectedModel === "claude-opus-4-6" ? "claude-sonnet-4-6" : selectedModel },
      "anthropic-opus": { provider, model: "claude-opus-4-6" },
    };
  }
  return {
    [`${provider}-haiku`]: { provider, model: second ?? selectedModel },
    [`${provider}-sonnet`]: { provider, model: selectedModel },
    [`${provider}-opus`]: { provider, model: third ?? first ?? selectedModel },
  };
}

function normalModelAlias(provider: string, selectedModel: string): string {
  if (provider === "anthropic") {
    return selectedModel === "claude-opus-4-6" ? "anthropic-opus" : "anthropic-sonnet";
  }
  return `${provider}-sonnet`;
}

function buildRouting(provider: string, selectedModel: string): NonNullable<VeraConfig["routing"]> {
  const prefix = provider === "anthropic" ? "anthropic" : provider;
  return {
    enabled: true,
    classifier: `${prefix}-haiku`,
    l0: `${prefix}-haiku`,
    l1: normalModelAlias(provider, selectedModel),
    l2: `${prefix}-opus`,
  };
}

/** Prompt on stderr and return user input. Returns null on EOF/abort. */
function ask(prompt: string): Promise<string | null> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * Prompt for a password-like value with masked input (asterisks).
 * Uses raw mode stdin to intercept each keystroke.
 */
function askSecret(prompt: string): Promise<string | null> {
  return new Promise((resolve) => {
    process.stderr.write(prompt);
    let value = "";
    const prevRaw = process.stdin.isRaw;

    const cleanup = () => {
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(prevRaw ?? false);
      }
      process.stdin.removeListener("data", onData);
      process.stderr.write("\n");
    };

    const onData = (chunk: Buffer) => {
      const str = chunk.toString();
      for (const ch of str) {
        if (ch === "\n" || ch === "\r" || ch === "\x04") {
          // Enter or Ctrl+D → submit
          cleanup();
          resolve(value.length > 0 ? value : null);
          return;
        }
        if (ch === "\x03") {
          // Ctrl+C → cancel
          cleanup();
          resolve(null);
          return;
        }
        if (ch === "\x7f" || ch === "\b") {
          // Backspace
          if (value.length > 0) {
            value = value.slice(0, -1);
            process.stderr.write("\b \b");
          }
        } else if (ch >= " ") {
          value += ch;
          process.stderr.write("*");
        }
      }
    };

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.on("data", onData);
  });
}

/** Ask user to pick from a numbered list. Returns the selected key. */
async function pickFromList(
  prompt: string,
  options: Array<{ key: string; label: string }>,
  defaultKey: string
): Promise<string | null> {
  out(prompt);
  for (let i = 0; i < options.length; i++) {
    const marker = options[i].key === defaultKey ? `${i + 1} (default)` : `${i + 1}`;
    out(`  ${marker}. ${options[i].label}`);
  }
  const answer = await ask(`\nChoose [1-${options.length}] (default: 1): `);
  if (answer === null) return null;

  const trimmed = answer.trim();
  if (trimmed === "") return defaultKey;

  const num = parseInt(trimmed, 10);
  if (!isNaN(num) && num >= 1 && num <= options.length) {
    return options[num - 1].key;
  }

  // Allow typing the key name directly
  const match = options.find((o) => o.key === trimmed.toLowerCase());
  if (match) return match.key;

  out("  Invalid choice, using default.");
  return defaultKey;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Check whether the loaded config is "empty" (no usable API key).
 *
 * A config is considered empty when:
 * - It has no providers section, OR
 * - The resolved default provider has no api_key AND no matching env var is set.
 */
export function isConfigEmpty(config: VeraConfig): boolean {
  const defaultProvider = resolveDefaultTarget(config).provider;
  const pc = config.providers?.[defaultProvider];

  // No providers configured at all
  if (!pc) return true;

  // Provider exists but has no api_key
  if (!pc.api_key) {
    // Check env var fallback
    const preset = PROVIDER_PRESETS[defaultProvider];
    if (preset && process.env[preset.envKey]) return false;
    // Generic fallback: <NAME>_API_KEY
    if (process.env[`${defaultProvider.toUpperCase()}_API_KEY`]) return false;
    return true;
  }

  // Has placeholder value?
  if (pc.api_key.includes("<") || pc.api_key.includes("your-")) return true;

  return false;
}

/**
 * Run the interactive setup wizard.
 *
 * Returns the provider name the user selected (so the caller can rebuild
 * the adapter if needed), or null if the user aborted.
 */
export async function runSetupWizard(cwd: string): Promise<string | null> {
  out("");
  out("╔══════════════════════════════════════════════════╗");
  out("║         Welcome to OpenVera — First Setup        ║");
  out("╚══════════════════════════════════════════════════╝");
  out("");
  out("  It looks like this is your first time running Vera.");
  out("  Let's get you configured in just a few steps.");
  out("");

  // ── Step 1: Select provider ──────────────────────────────────────────────

  const providerEntries = Object.entries(PROVIDER_PRESETS);
  const providerOptions = providerEntries.map(([key, p]) => ({
    key,
    label: p.label,
  }));

  const selectedProvider = await pickFromList(
    "Step 1 — Select your LLM provider:",
    providerOptions,
    "anthropic"
  );
  if (!selectedProvider) {
    out("\nSetup cancelled. You can configure manually:");
    out("  .vera/settings.json  (see .vera/settings.example.json)");
    return null;
  }

  const preset = PROVIDER_PRESETS[selectedProvider]!;

  // ── Step 2: API key ─────────────────────────────────────────────────────

  out(`\nStep 2 — Enter your API key for ${preset.label}:`);
  out(`  (You can also set the ${preset.envKey} env var instead)`);
  out("");

  let apiKey: string | null = null;
  const envKey = process.env[preset.envKey];
  if (envKey) {
    out(`  ✓ Found ${preset.envKey} in environment.`);
    const useEnv = await ask("  Use this key? [Y/n]: ");
    if (useEnv === null) return null;
    if (useEnv.trim().toLowerCase() !== "n") {
      apiKey = envKey;
    }
  }

  if (!apiKey) {
    apiKey = await askSecret("  API key: ");
    if (!apiKey) {
      out("\n  No API key entered. Setup cancelled.");
      out("  You can set it later in .vera/settings.json");
      return null;
    }
  }

  // ── Step 3: Select model ─────────────────────────────────────────────────

  const modelOptions = preset.models.map((m) => ({
    key: m,
    label: m,
  }));

  out(`\nStep 3 — Select default model for ${preset.label}:`);
  const selectedModel = await pickFromList(
    "",
    modelOptions,
    preset.defaultModel
  );
  if (!selectedModel) {
    out("\nSetup cancelled.");
    return null;
  }

  // ── Write config ─────────────────────────────────────────────────────────

  const config: VeraConfig = {
    providers: {
      [selectedProvider]: {
        adapter: preset.adapter,
        api_key: apiKey,
        ...(preset.baseUrl ? { base_url: preset.baseUrl } : {}),
      },
    },
    models: buildModels(selectedProvider, preset, selectedModel),
    default_provider: selectedProvider,
    routing: buildRouting(selectedProvider, selectedModel),
  };

  const target = resolveConfigLocation(undefined, cwd);
  writeConfig(config, undefined, cwd);

  out("");
  out("╔══════════════════════════════════════════════════╗");
  out("║               ✓ Setup Complete!                  ║");
  out("╚══════════════════════════════════════════════════╝");
  out("");
  out(`  Provider:  ${preset.label}`);
  out(`  Model:     ${selectedModel}`);
  out(`  Config:    ${target.path}`);
  out("");
  out("  You can change these anytime by editing the config file.");
  out("  Starting Vera...");
  out("");

  return selectedProvider;
}
