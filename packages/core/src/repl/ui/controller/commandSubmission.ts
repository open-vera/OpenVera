import type { AccumulatedCost } from "../../../session/index.js";
import type { ReplContext } from "../../context.js";
import { debugLog } from "../../debugLog.js";
import type { ChatMessage, RoutingInfo, TokenUsage } from "../types.js";
import type { OverlayAction, ProviderEntry, ModelEntry } from "../state/overlayStore.js";
import {
  formatStatusMessage,
  handleQueueCommand,
  isProcessCommand,
  isUiCommand,
  type ParsedSlashCommand,
} from "./slashCommands.js";
import { captureCommandOutput } from "./commandCapture.js";
import type { AiTitleState } from "./sessionTitle.js";
import { markCustomTitle } from "./sessionTitle.js";

export interface CommandSubmissionQueue {
  items: string[];
  clearQueue: () => void;
  removeQueued: (index: number) => void;
  updateQueued: (index: number, input: string) => void;
}

export interface HandleSlashCommandSubmissionOptions {
  line: string;
  slashCommand: ParsedSlashCommand;
  ctx: ReplContext;
  routing: RoutingInfo;
  usage: TokenUsage;
  latestInputTokens: number;
  turnCount: number;
  cost: AccumulatedCost;
  lastInput?: string;
  aiTitleState: AiTitleState;
  queue: CommandSubmissionQueue;
  setMessages: (updater: (prev: ChatMessage[]) => ChatMessage[]) => void;
  dispatchOverlay: (action: OverlayAction) => void;
  exit: () => void;
  captureCommand?: typeof captureCommandOutput;
}

export type SlashCommandSubmissionResult =
  | { handled: true; exit?: boolean }
  | { handled: false };

export async function handleSlashCommandSubmission(
  options: HandleSlashCommandSubmissionOptions,
): Promise<SlashCommandSubmissionResult> {
  const { cmd, args } = options.slashCommand;

  if (isProcessCommand(cmd)) {
    options.ctx.sessionStore.writeEnd(
      options.cost.totalUsage,
      options.cost.totalUsd,
      options.turnCount,
      options.lastInput,
    );
    options.exit();
    return { handled: true, exit: true };
  }

  if (isUiCommand(cmd, "diff")) {
    options.dispatchOverlay({ type: "open.diff" });
    return { handled: true };
  }

  if (cmd === "provider" && args.length === 0) {
    const providers = options.ctx.config.providers ?? {};
    const entries: ProviderEntry[] = Object.entries(providers).map(([name, p]) => ({
      name,
      adapter: p.adapter,
      base_url: p.base_url,
    }));
    if (entries.length === 0) {
      options.setMessages((prev) => [...prev, { role: "assistant", content: "No providers configured." }]);
      return { handled: true };
    }
    options.dispatchOverlay({
      type: "open.providerPicker",
      providers: entries,
      currentProvider: options.ctx.config.default_provider ?? "",
    });
    return { handled: true };
  }

  if (cmd === "model") {
    const providerNames = args.length > 0 ? args : Object.keys(options.ctx.config.providers ?? {});
    if (providerNames.length === 0) {
      options.setMessages((prev) => [...prev, { role: "assistant", content: "No providers configured." }]);
      return { handled: true };
    }

    options.setMessages((prev) => [...prev, { role: "user", content: options.line }]);
    options.setMessages((prev) => [...prev, { role: "assistant", content: "Fetching models..." }]);

    const results = await Promise.allSettled(
      providerNames.map(async (name) => {
        const adapter = options.ctx.buildAdapter(name);
        if (!adapter.listModels) {
          return { name, models: [] as { id: string; display_name?: string; context_window?: number }[] };
        }
        const models = await adapter.listModels();
        return { name, models };
      }),
    );

    const modelEntries: ModelEntry[] = [];
    for (const result of results) {
      if (result.status === "fulfilled") {
        for (const m of result.value.models) {
          modelEntries.push({
            id: m.id,
            provider: result.value.name,
            display_name: m.display_name,
            context_window: m.context_window,
          });
        }
      }
    }

    if (modelEntries.length === 0) {
      options.setMessages((prev) => [...prev, { role: "assistant", content: "No models found." }]);
      return { handled: true };
    }

    // Replace the "Fetching..." message by triggering the overlay.
    // setMessages to remove the fetching message, then open overlay.
    options.setMessages((prev) => prev.slice(0, -1));
    options.dispatchOverlay({
      type: "open.modelPicker",
      models: modelEntries,
      currentModel: options.ctx.model,
      currentProvider: options.routing.provider,
    });
    return { handled: true };
  }

  if (cmd === "title") markCustomTitle(options.aiTitleState);

  options.setMessages((prev) => [...prev, { role: "user", content: options.line }]);

  if (isUiCommand(cmd, "status")) {
    options.setMessages((prev) => [
      ...prev,
      {
        role: "assistant",
        content: formatStatusMessage(
          options.routing,
          options.usage,
          options.latestInputTokens,
          options.turnCount,
          options.cost,
        ),
      },
    ]);
    return { handled: true };
  }

  if (isUiCommand(cmd, "queue")) {
    const result = handleQueueCommand(args, options.queue.items);
    if (result.type === "clear") options.queue.clearQueue();
    if (result.type === "remove") options.queue.removeQueued(result.index);
    if (result.type === "update") options.queue.updateQueued(result.index, result.input);
    options.setMessages((prev) => [...prev, { role: "assistant", content: result.content }]);
    return { handled: true };
  }

  debugLog(`[commandSubmission] /${cmd} — dispatching to captureCommandOutput, args=${JSON.stringify(args)}`);
  const t0 = Date.now();
  const output = await (options.captureCommand ?? captureCommandOutput)(cmd, args, options.ctx);
  debugLog(`[commandSubmission] /${cmd} — returned in ${Date.now() - t0}ms, output=${output === null ? "null (overlay)" : `${output.length} chars`}`);
  if (output) {
    debugLog(`[commandSubmission] /${cmd} — adding assistant message with captured output`);
    options.setMessages((prev) => [...prev, { role: "assistant", content: output }]);
  } else {
    debugLog(`[commandSubmission] /${cmd} — no output to add (overlay should be open)`);
  }
  return { handled: true };
}
