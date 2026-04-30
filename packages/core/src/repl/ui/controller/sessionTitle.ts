import type { LLMAdapter } from "../../../adapters/base.js";
import { generateSessionTitle } from "../../../session/index.js";
import type { GenerateSessionTitleOptions } from "../../../session/index.js";

export interface AiTitleState {
  hasCustomTitle: boolean;
  generated: boolean;
  attempts: number;
}

export interface AiTitleConfig {
  enabled?: boolean;
  provider?: string;
  model?: string;
}

export interface MaybeGenerateAiTitleOptions {
  state: AiTitleState;
  config?: AiTitleConfig;
  turnCount: number;
  maxAttempts?: number;
  userPrompt: string;
  assistantText: string;
  toolCalls: string[];
  activeAdapter: LLMAdapter;
  activeModel: string;
  buildAdapter: (provider: string) => LLMAdapter;
  writeAiTitle: (title: string) => void;
  generateTitle?: (opts: GenerateSessionTitleOptions) => Promise<string | null>;
}

export function markCustomTitle(state: AiTitleState): AiTitleState {
  state.hasCustomTitle = true;
  return state;
}

export function shouldGenerateAiTitle(
  state: AiTitleState,
  config: AiTitleConfig | undefined,
  turnCount: number,
  maxAttempts = 2,
): boolean {
  if (config?.enabled === false) return false;
  if (state.hasCustomTitle || state.generated || state.attempts >= maxAttempts) return false;
  return turnCount <= 1;
}

export function maybeGenerateAiTitle(options: MaybeGenerateAiTitleOptions): AiTitleState {
  const {
    state,
    config,
    turnCount,
    maxAttempts,
    userPrompt,
    assistantText,
    toolCalls,
    activeAdapter,
    activeModel,
    buildAdapter,
    writeAiTitle,
    generateTitle = generateSessionTitle,
  } = options;

  if (!shouldGenerateAiTitle(state, config, turnCount, maxAttempts)) return state;

  state.generated = true;
  state.attempts += 1;
  const toolsSummary = toolCalls.length ? `Tools used: ${[...new Set(toolCalls)].slice(0, 8).join(", ")}` : undefined;

  void generateTitle({
    adapter: config?.provider ? buildAdapter(config.provider) : activeAdapter,
    model: config?.model ?? activeModel,
    userPrompt,
    assistantText: assistantText.trim() || toolsSummary,
  }).then((title) => {
    if (title && !state.hasCustomTitle) writeAiTitle(title);
    if (!title) state.generated = false;
  }).catch(() => {
    state.generated = false;
  });

  return state;
}
