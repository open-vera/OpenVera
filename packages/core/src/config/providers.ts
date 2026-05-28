/**
 * Provider & model catalog for the interactive setup wizard.
 */

import type { AdapterType } from "./types.js";

export interface ProviderPreset {
  label: string;
  adapter: AdapterType;
  envKey: string;
  models: string[];
  defaultModel: string;
  baseUrl?: string;
}

/** Available provider presets (order = display order in wizard). */
export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  anthropic: {
    label: "Anthropic (Claude)",
    adapter: "anthropic",
    envKey: "ANTHROPIC_API_KEY",
    models: [
      "claude-sonnet-4-6",
      "claude-opus-4-6",
      "claude-haiku-4-5-20251001",
    ],
    defaultModel: "claude-sonnet-4-6",
  },
  openai: {
    label: "OpenAI (GPT)",
    adapter: "openai",
    envKey: "OPENAI_API_KEY",
    models: [
      "gpt-4.1",
      "gpt-4.1-mini",
      "gpt-4o",
      "gpt-4o-mini",
      "o3",
      "o3-mini",
    ],
    defaultModel: "gpt-4.1",
  },
  gemini: {
    label: "Google Gemini",
    adapter: "gemini",
    envKey: "GEMINI_API_KEY",
    models: [
      "gemini-2.5-pro",
      "gemini-2.5-flash",
      "gemini-2.0-flash",
    ],
    defaultModel: "gemini-2.5-flash",
  },
  deepseek: {
    label: "DeepSeek",
    adapter: "openai",
    envKey: "DEEPSEEK_API_KEY",
    models: [
      "deepseek-chat",
      "deepseek-reasoner",
    ],
    defaultModel: "deepseek-chat",
    baseUrl: "https://api.deepseek.com/v1",
  },
  groq: {
    label: "Groq",
    adapter: "openai",
    envKey: "GROQ_API_KEY",
    models: [
      "llama-3.3-70b-versatile",
      "llama-3.1-8b-instant",
      "mixtral-8x7b-32768",
    ],
    defaultModel: "llama-3.3-70b-versatile",
    baseUrl: "https://api.groq.com/openai/v1",
  },
};
