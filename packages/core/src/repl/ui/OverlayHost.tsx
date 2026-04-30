import type { MutableRefObject, ReactNode } from "react";
import { Box } from "ink";
import { SessionStore } from "../../session/index.js";
import type { ReplContext } from "../context.js";
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
    const sessionPage = SessionStore.listSessionsPaged({ cwd: ctx.cwd, limit: 30 });
    return (
      <Box flexDirection="column">
        <SessionPicker
          cwd={ctx.cwd}
          initialSessions={sessionPage.sessions}
          initialNextOffset={sessionPage.nextOffset}
          width={columns}
          onSelect={(sessionId) => {
            onClose();
            try {
              const loaded = SessionStore.loadSession(sessionId, ctx.cwd);
              const preview = SessionStore.loadTranscriptPreview(sessionId, ctx.cwd);
              ctxRef.current.onResume!(loaded);
              setMessages((prev) => [...prev, ...resumedVisibleMessages(sessionId, preview, loaded)]);
            } catch (err) {
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
