import { dirname } from "node:path";
import type { MutableRefObject } from "react";
import {
  SUBAGENT_TOOL_NAME,
  runSubagentTool,
} from "../../../agent/subagent.js";
import type { AgentDefinition } from "../../../agent/subagent.js";
import { loadNestedProjectContext } from "../../../project-context/index.js";
import type { ReplContext } from "../../context.js";
import type { ToolResult } from "../../../tools/types.js";
import type { Usage, Tool } from "../../../types/index.js";
import type { SessionStore } from "../../../session/index.js";
import {
  ASK_USER_QUESTION_TOOL_NAME,
  type AskUserQuestionArgs,
  type QuestionAnswers,
} from "../../../tools/ask-user-question.js";
import type { BlockingPrompt } from "../state/blockingPrompt.js";
import { pathApprovalPrompt, questionPrompt } from "../state/blockingPrompt.js";

export interface ToolCallHandlerParams {
  ctxRef: MutableRefObject<ReplContext>;
  store: SessionStore;
  userUuid: string;
  controller: AbortController;
  activeAdapter: ReplContext["adapter"];
  activeModel: string;
  activeProvider: string;
  activeTools: Tool[];
  activeSystem: string;
  activeExecutors: Map<string, (args: Record<string, unknown>) => Promise<string> | string> | undefined;
  agentDefinitions: AgentDefinition[];
  loadedVeraContextPathsRef: MutableRefObject<Set<string>>;
  turnToolCalls: string[];
  captureUsage: (u: Usage) => void;
  setBlockingPrompt: (prompt: BlockingPrompt | null) => void;
}

export function buildToolCallHandler(params: ToolCallHandlerParams) {
  const {
    ctxRef, store, userUuid, controller,
    activeAdapter, activeModel, activeProvider,
    activeTools, activeSystem, activeExecutors,
    agentDefinitions, loadedVeraContextPathsRef,
    turnToolCalls, captureUsage, setBlockingPrompt,
  } = params;

  const runDir = dirname(store.filePath);

  const executeOnce = async (n: string, a: Record<string, unknown>, onOutput?: (chunk: string) => void): Promise<ToolResult> => {
    if (n === SUBAGENT_TOOL_NAME) {
      const result = await runSubagentTool({
        args: a,
        adapter: activeAdapter,
        model: activeModel,
        tools: activeTools,
        system: activeSystem,
        runDir,
        signal: controller.signal,
        onUsage: captureUsage,
        eventBus: ctxRef.current.toolHost?.eventBus,
        llmService: ctxRef.current.llmService,
        traceId: `subagent:${String(a.subagent_type ?? a.subagentType ?? "general-purpose")}`,
        cwd: ctxRef.current.cwd,
        provider: activeProvider,
        parentSessionId: store.sessionId,
        definitions: agentDefinitions,
        createToolHandlerForCwd: ({ cwd, sessionStore }) => {
          const bundle = ctxRef.current.createToolRegistry?.({ cwd, sessionStore });
          return async (childName, childArgs) => {
            if (activeExecutors?.has(childName)) return activeExecutors.get(childName)!(childArgs);
            if (!bundle) return (await executeOnce(childName, childArgs)).content;
            const r = await bundle.toolHost.execute(childName, childArgs, {
              cwd,
              sessionId: sessionStore?.sessionId ?? store.sessionId,
            });
            return r.content;
          };
        },
        onToolCall: async (childName, childArgs) => {
          const childResult = await finalizeToolResult(childName, childArgs, await executeOnce(childName, childArgs));
          return childResult.content;
        },
      });
      return result.ok
        ? { ok: true, content: result.content, metadata: { renderHint: { type: "text" } } }
        : { ok: false, content: result.content, error: { code: "UNKNOWN", message: result.content, retryable: false } };
    }

    if (n === ASK_USER_QUESTION_TOOL_NAME) {
      const args = a as unknown as AskUserQuestionArgs;
      const answers = await new Promise<QuestionAnswers>((res) => {
        setBlockingPrompt(questionPrompt({ questions: args.questions, resolve: res }));
      });
      setBlockingPrompt(null);
      const resultContent = JSON.stringify({
        questions: args.questions.map((q) => q.question),
        answers,
      });
      return { ok: true, content: resultContent, metadata: { renderHint: { type: "text" } } };
    }


    const registry = ctxRef.current.registry;
    const toolHost = ctxRef.current.toolHost;
    // Registry tools must always go through ToolHost/registry execution so security hooks
    // (including needsConfirm) run. activeExecutors wraps registry tools via
    // RegistryToolProvider but drops ToolResult metadata — skip it for known tools.
    if (registry?.has(n) && toolHost) {
      return toolHost.execute(n, a, { cwd: ctxRef.current.cwd, sessionId: store.sessionId, onOutput });
    }
    if (registry?.has(n)) return registry.execute(n, a, { cwd: ctxRef.current.cwd, sessionId: store.sessionId, onOutput });

    if (activeExecutors?.has(n)) {
      const content = await activeExecutors.get(n)!(a);
      return { ok: true, content };
    }

    if (toolHost) return toolHost.execute(n, a, { cwd: ctxRef.current.cwd, sessionId: store.sessionId, onOutput });
    if (registry) return registry.execute(n, a, { cwd: ctxRef.current.cwd, sessionId: store.sessionId, onOutput });
    return { ok: false, content: `Tool "${n}" is not implemented yet.`, error: { code: "UNKNOWN", message: `Tool "${n}" is not implemented yet.`, retryable: false } };
  };

  const finalizeToolResult = async (n: string, a: Record<string, unknown>, initialResult: ToolResult): Promise<ToolResult> => {
    let result = initialResult;

    if (result.needsConfirm) {
      const confirm = result.needsConfirm;
      const approved = await new Promise<boolean>((res) => {
        setBlockingPrompt(pathApprovalPrompt({
          message: confirm.message,
          allowDir: confirm.allowDir,
          resolve: res,
        }));
      });
      setBlockingPrompt(null);
      if (approved) {
        ctxRef.current.security?.allowPath(confirm.allowDir);
        result = await executeOnce(confirm.retry.name, confirm.retry.args);
      }
    }

    if (result.ok && n === "read_file" && typeof a.path === "string") {
      const nested = loadNestedProjectContext({
        cwd: ctxRef.current.cwd,
        targetPath: a.path,
        loadedPaths: loadedVeraContextPathsRef.current,
      });
      if (nested.system) {
        for (const file of nested.files) loadedVeraContextPathsRef.current.add(file.path);
        result = {
          ...result,
          content: [result.content, `<nested-vera-context>\n${nested.system}\n</nested-vera-context>`].join("\n\n"),
        };
      }
    }

    return result;
  };

  return async (name: string, args: Record<string, unknown>, onOutput?: (chunk: string) => void): Promise<ToolResult> => {
    turnToolCalls.push(name);
    const toolCallUuid = store.writeToolCall({ parentUuid: userUuid, toolName: name, toolCallId: name, arguments: args });
    const toolResult = await finalizeToolResult(name, args, await executeOnce(name, args, onOutput));
    store.writeToolResult({ parentUuid: toolCallUuid, toolCallId: name, content: toolResult.content });
    return toolResult;
  };
}
