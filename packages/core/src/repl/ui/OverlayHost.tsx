import type { MutableRefObject, ReactNode } from "react";
import { Box } from "ink";
import { SessionStore } from "../../session/index.js";
import type { ReplContext } from "../context.js";
import { debugLog } from "../debugLog.js";
import type { ChatMessage } from "./types.js";
import { resumedVisibleMessages } from "./utils.js";
import type { OverlayState } from "./state/overlayStore.js";
import { AskUserQuestion } from "./AskUserQuestion/index.js";
import { DiffDialog } from "./DiffDialog.js";
import { SelectPrompt } from "./SelectPrompt.js";
import { SessionPicker } from "./SessionPicker.js";

export interface OverlayHostProps {
  overlay: OverlayState;
  ctx: ReplContext;
  ctxRef: MutableRefObject<ReplContext>;
  columns: number;
  rows: number;
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  onClose: () => void;
  children?: ReactNode;
}

export function OverlayHost({
  overlay,
  ctx,
  ctxRef,
  columns,
  rows,
  setMessages,
  onClose,
  children,
}: OverlayHostProps) {
  if (overlay.type === "diff") {
    return <DiffDialog cwd={ctx.cwd} width={columns} height={rows} onClose={onClose} />;
  }

  if (overlay.type === "sessionPicker") {
    debugLog(`[OverlayHost] rendering sessionPicker, cwd=${ctx.cwd}`);
    const t0 = Date.now();
    const sessionPage = SessionStore.listSessionsPaged({ cwd: ctx.cwd, limit: 30 });
    debugLog(`[OverlayHost] loaded ${sessionPage.sessions.length} sessions (${Date.now() - t0}ms)`);
    return (
      <Box flexDirection="column">
        <SessionPicker
          cwd={ctx.cwd}
          initialSessions={sessionPage.sessions}
          initialNextOffset={sessionPage.nextOffset}
          width={columns}
          onSelect={(sessionId) => {
            debugLog(`[OverlayHost.onSelect] sessionId=${sessionId}, onResume=${!!ctxRef.current.onResume}`);
            const t1 = Date.now();
            debugLog(`[OverlayHost.onSelect] → calling onClose()`);
            onClose();
            debugLog(`[OverlayHost.onSelect] ← onClose() returned (${Date.now() - t1}ms)`);
            try {
              debugLog(`[OverlayHost.onSelect] → loadSession(${sessionId})`);
              const t2 = Date.now();
              const loaded = SessionStore.loadSession(sessionId, ctx.cwd);
              debugLog(`[OverlayHost.onSelect] ← loadSession done (${Date.now() - t2}ms): turns=${loaded.turnCount} history=${loaded.history.length}`);
              debugLog(`[OverlayHost.onSelect] → loadTranscriptPreview`);
              const t3 = Date.now();
              const preview = SessionStore.loadTranscriptPreview(sessionId, ctx.cwd);
              debugLog(`[OverlayHost.onSelect] ← loadTranscriptPreview done (${Date.now() - t3}ms): ${preview.messages.length} msgs`);
              debugLog(`[OverlayHost.onSelect] → calling onResume`);
              const t4 = Date.now();
              ctxRef.current.onResume!(loaded);
              debugLog(`[OverlayHost.onSelect] ← onResume returned (${Date.now() - t4}ms)`);
              const resumed = resumedVisibleMessages(sessionId, preview, loaded);
              debugLog(`[OverlayHost.onSelect] → setMessages (+${resumed.length} msgs)`);
              setMessages((prev) => [...prev, ...resumed]);
              debugLog(`[OverlayHost.onSelect] ← setMessages done — resume complete (${Date.now() - t1}ms total)`);
            } catch (err) {
              debugLog(`[OverlayHost.onSelect] ✗ FAILED: ${err}`);
              console.error(`[OverlayHost] session resume failed:`, err);
              setMessages((prev) => [...prev, { role: "assistant", content: `Failed to load session: ${err instanceof Error ? err.message : String(err)}` }]);
            }
          }}
          onClose={onClose}
        />
      </Box>
    );
  }

  if (overlay.type === "prompt" && overlay.prompt.kind === "question") {
    return <AskUserQuestion state={overlay.prompt} columns={columns} />;
  }

  if (overlay.type === "prompt" && overlay.prompt.kind === "approval") {
    const prompt = overlay.prompt;
    return (
      <SelectPrompt
        message={prompt.message}
        options={prompt.options}
        onConfirm={([selected]) => {
          onClose();
          prompt.resolve(selected ?? false);
        }}
        onCancel={() => {
          onClose();
          prompt.resolve(false);
        }}
      />
    );
  }

  return <>{children}</>;
}
