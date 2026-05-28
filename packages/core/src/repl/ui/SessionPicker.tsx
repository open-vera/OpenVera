import { Box, Text, useStdin } from "ink";
import { useState, useRef, useLayoutEffect, useCallback, useEffect } from "react";
import { SessionStore } from "../../session/index.js";
import type { SessionSummary, SessionTranscriptPreview } from "../../session/index.js";
import { debugLog } from "../debugLog.js";
import { ConversationPanel } from "./ConversationPanel.js";
import { parseInputKey } from "./inputKeys.js";
import type { ChatMessage } from "./types.js";

const VISIBLE_LIMIT = 12;
const PREVIEW_HEIGHT = 12;
const SEARCH_BATCH_SIZE = 60;
const SEARCH_DEBOUNCE_MS = 120;

function formatRelativeTime(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const minutes = Math.max(0, Math.floor(diffMs / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return date.toISOString().slice(0, 10);
}

function formatTokens(n: number | undefined): string {
  const value = n ?? 0;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, Math.max(0, n - 3))}...`;
}

function sessionLabel(s: SessionSummary): string {
  return s.summary ?? s.lastUserInput ?? "No prompt recorded";
}

function formatFileSize(bytes: number | undefined): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function sessionMeta(s: SessionSummary): string {
  const tokens = [
    `in ${formatTokens(s.totalUsage.input_tokens)}`,
    `out ${formatTokens(s.totalUsage.output_tokens)}`,
  ];
  const cacheWrite = s.totalUsage.cache_creation_input_tokens ?? 0;
  const cacheRead = s.totalUsage.cache_read_input_tokens ?? 0;
  if (cacheWrite || cacheRead) tokens.push(`cache ${formatTokens(cacheWrite)}/${formatTokens(cacheRead)}`);
  const turnsLabel = s.messageCount
    ? `${s.turnCount} turns / ${s.messageCount} msgs`
    : `${s.turnCount} turns`;
  const sizePart = s.fileSize ? formatFileSize(s.fileSize) : undefined;
  const meta = [
    s.sessionId.slice(0, 8),
    s.gitBranch ? `branch:${s.gitBranch}` : undefined,
    s.tag ? `tag:${s.tag}` : undefined,
    s.pr ? `pr:${s.pr.number ?? s.pr.url}` : undefined,
    turnsLabel,
    sizePart,
    tokens.join(" "),
    `$${s.totalCostUsd.toFixed(4)}`,
  ].filter(Boolean);
  return meta.join(" | ");
}

export interface SearchFilter {
  text: string[];
  branch?: string;
  tag?: string;
  costLt?: number;
  costGt?: number;
  after?: Date;
  before?: Date;
}

export function parseSearchFilter(query: string): SearchFilter {
  const filter: SearchFilter = { text: [] };
  for (const rawToken of query.trim().split(/\s+/).filter(Boolean)) {
    const token = rawToken.toLowerCase();
    if (token.startsWith("branch:")) {
      filter.branch = rawToken.slice("branch:".length).toLowerCase();
    } else if (token.startsWith("tag:")) {
      filter.tag = rawToken.slice("tag:".length).toLowerCase();
    } else if (token.startsWith("cost>")) {
      filter.costGt = Number(token.slice("cost>".length));
    } else if (token.startsWith("cost<")) {
      filter.costLt = Number(token.slice("cost<".length));
    } else if (token.startsWith("after:")) {
      filter.after = parseDateToken(token.slice("after:".length));
    } else if (token.startsWith("before:")) {
      filter.before = parseDateToken(token.slice("before:".length));
    } else {
      filter.text.push(token);
    }
  }
  return filter;
}

function parseDateToken(value: string): Date | undefined {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function matchesSession(s: SessionSummary, filter: SearchFilter): boolean {
  if (filter.branch && !s.gitBranch?.toLowerCase().includes(filter.branch)) return false;
  if (filter.tag && !s.tag?.toLowerCase().includes(filter.tag)) return false;
  if (filter.costGt !== undefined && Number.isFinite(filter.costGt) && s.totalCostUsd <= filter.costGt) return false;
  if (filter.costLt !== undefined && Number.isFinite(filter.costLt) && s.totalCostUsd >= filter.costLt) return false;
  if (filter.after && s.lastActivityAt < filter.after) return false;
  if (filter.before && s.lastActivityAt > filter.before) return false;
  if (filter.text.length === 0) return true;
  const haystack = [s.summary, s.lastUserInput, s.gitBranch, s.tag, s.sessionId]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return filter.text.every((term) => haystack.includes(term));
}

export function buildBranchCompareSessions(
  selected: SessionSummary | undefined,
  branches: SessionSummary[],
): SessionSummary[] {
  if (!selected) return [];
  const base = selected.branch
    ? branches
    : branches.some((s) => s.sessionId === selected.sessionId)
      ? branches
      : [selected, ...branches];
  return base
    .slice()
    .sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime());
}

function Highlighted({ text, query }: { text: string; query: string }) {
  const term = parseSearchFilter(query).text[0];
  if (!term) return <Text>{text}</Text>;
  const idx = text.toLowerCase().indexOf(term);
  if (idx < 0) return <Text>{text}</Text>;
  return (
    <Text>
      {text.slice(0, idx)}
      <Text color="yellow" bold>{text.slice(idx, idx + term.length)}</Text>
      {text.slice(idx + term.length)}
    </Text>
  );
}

interface SessionPickerProps {
  cwd: string;
  initialSessions: SessionSummary[];
  initialNextOffset?: number;
  onSelect: (sessionId: string) => void;
  onClose: () => void;
  width: number;
}

export function SessionPicker({
  cwd,
  initialSessions,
  initialNextOffset,
  onSelect,
  onClose,
  width: _width,
}: SessionPickerProps) {
  debugLog(`[SessionPicker] ▸ mount, ${initialSessions.length} initial sessions, cwd=${cwd}`);
  const [sessions, setSessions] = useState(initialSessions);
  const [nextOffset, setNextOffset] = useState<number | undefined>(initialNextOffset);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [search, setSearch] = useState("");
  const [searchMode, setSearchMode] = useState(false);
  const [preview, setPreview] = useState<SessionTranscriptPreview | null>(null);
  const [previewStatus, setPreviewStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [searchScanStatus, setSearchScanStatus] = useState<"idle" | "scanning">("idle");
  const [previewScrollOffset, setPreviewScrollOffset] = useState(0);
  const [expandPreviewTools, setExpandPreviewTools] = useState(false);
  const [showBranchCompare, setShowBranchCompare] = useState(true);
  const [branchCompare, setBranchCompare] = useState<SessionSummary[]>([]);
  const selectedIdxRef = useRef(0);
  selectedIdxRef.current = selectedIdx;

  useEffect(() => {
    return () => { debugLog("[SessionPicker] ◂ unmount"); };
  }, []);

  const searchFilter = parseSearchFilter(search);
  const filteredSessions = search ? sessions.filter((s) => matchesSession(s, searchFilter)) : sessions;

  const visibleRef = useRef(filteredSessions);
  visibleRef.current = filteredSessions;

  const loadMore = useCallback(() => {
    if (nextOffset === undefined) return;
    const result = SessionStore.listSessionsPaged({ cwd, limit: 30, offset: nextOffset });
    setSessions((prev) => {
      const seen = new Set(prev.map((s) => s.sessionId));
      return [...prev, ...result.sessions.filter((s) => !seen.has(s.sessionId))];
    });
    setNextOffset(result.nextOffset);
  }, [cwd, nextOffset]);

  useEffect(() => {
    if (!search || nextOffset === undefined) return;
    let cancelled = false;
    let offset: number | undefined = nextOffset;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setSearchScanStatus("scanning");

    const appendSessions = (loaded: SessionSummary[]) => {
      setSessions((prev) => {
        const seen = new Set(prev.map((s) => s.sessionId));
        return [...prev, ...loaded.filter((s) => !seen.has(s.sessionId))];
      });
    };

    const scanBatch = () => {
      if (cancelled || offset === undefined) {
        if (!cancelled) setSearchScanStatus("idle");
        return;
      }
      const result = SessionStore.listSessionsPaged({ cwd, limit: SEARCH_BATCH_SIZE, offset });
      offset = result.nextOffset;
      appendSessions(result.sessions);
      if (offset === undefined) {
        setNextOffset(undefined);
        setSearchScanStatus("idle");
        return;
      }
      timer = setTimeout(scanBatch, 0);
    };

    timer = setTimeout(scanBatch, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      setSearchScanStatus("idle");
    };
  }, [cwd, search, nextOffset]);

  const handleKey = useCallback((chunk: string) => {
    const key = parseInputKey(chunk);
    if (key.escape) {
      if (searchMode) {
        setSearchMode(false);
        setSearch("");
        setSelectedIdx(0);
        return;
      }
      onClose();
      return;
    }
    if (chunk === "/" && !searchMode) {
      setSearchMode(true);
      setSearch("");
      setSelectedIdx(0);
      return;
    }
    if (!searchMode && chunk === "o") {
      setExpandPreviewTools((v) => !v);
      return;
    }
    if (!searchMode && chunk === "b") {
      setShowBranchCompare((v) => !v);
      return;
    }
    if (!searchMode && chunk === "u") {
      setPreviewScrollOffset((v) => v + Math.floor(PREVIEW_HEIGHT / 2));
      return;
    }
    if (!searchMode && chunk === "d") {
      setPreviewScrollOffset((v) => Math.max(0, v - Math.floor(PREVIEW_HEIGHT / 2)));
      return;
    }
    if (searchMode && (chunk === "\x7f" || chunk === "\b")) {
      setSearch((s) => s.slice(0, -1));
      setSelectedIdx(0);
      return;
    }
    if (searchMode && !key.return && !key.upArrow && !key.downArrow && chunk >= " ") {
      setSearch((s) => s + chunk);
      setSelectedIdx(0);
      return;
    }
    if (key.upArrow) {
      setSelectedIdx(i => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedIdx(i => {
        const next = Math.min(visibleRef.current.length - 1, i + 1);
        if (next >= visibleRef.current.length - 3) loadMore();
        return next;
      });
      return;
    }
    if (key.pageUp) {
      setSelectedIdx(i => Math.max(0, i - VISIBLE_LIMIT));
      return;
    }
    if (key.pageDown) {
      loadMore();
      setSelectedIdx(i => Math.min(visibleRef.current.length - 1, i + VISIBLE_LIMIT));
      return;
    }
    if (key.return) {
      const s = visibleRef.current[selectedIdxRef.current];
      debugLog(`[SessionPicker] Enter pressed, selectedIdx=${selectedIdxRef.current}, session=${s?.sessionId ?? "(none)"}`);
      if (s) {
        debugLog(`[SessionPicker] → calling onSelect(${s.sessionId})`);
        onSelect(s.sessionId);
        debugLog(`[SessionPicker] ← onSelect returned`);
      }
      return;
    }
  }, [loadMore, onClose, onSelect, searchMode]);

  const { internal_eventEmitter } = useStdin();
  useLayoutEffect(() => {
    debugLog("[SessionPicker] stdin handler attached");
    const onData = (chunk: string) => handleKey(chunk);
    internal_eventEmitter.on("input", onData);
    return () => {
      debugLog("[SessionPicker] stdin handler detached");
      internal_eventEmitter.off("input", onData);
    };
  }, [internal_eventEmitter, handleKey]);

  const selected = filteredSessions[selectedIdx];
  useEffect(() => {
    if (selectedIdx >= filteredSessions.length) {
      setSelectedIdx(Math.max(0, filteredSessions.length - 1));
    }
  }, [filteredSessions.length, selectedIdx]);

  useEffect(() => {
    setPreview(null);
    setPreviewStatus(selected ? "loading" : "idle");
    setPreviewScrollOffset(0);
    if (!selected) return;
    const timer = setTimeout(() => {
      try {
        setPreview(SessionStore.loadTranscriptPreview(selected.sessionId, cwd));
        setPreviewStatus("ready");
      } catch {
        setPreview(null);
        setPreviewStatus("error");
      }
    }, 150);
    return () => clearTimeout(timer);
  }, [cwd, selected?.sessionId]);

  useEffect(() => {
    if (!selected) {
      setBranchCompare([]);
      return;
    }
    const parentSessionId = selected.branch?.parentSessionId ?? selected.sessionId;
    const branches = SessionStore.listBranches(parentSessionId, cwd);
    setBranchCompare(buildBranchCompareSessions(selected, branches));
  }, [cwd, selected?.sessionId, selected?.branch?.parentSessionId, selected?.branch]);

  if (sessions.length === 0) {
    return (
      <Box flexDirection="column" paddingLeft={2}>
        <Text color="gray">No sessions found.</Text>
        <Text color="gray" dimColor>esc to close</Text>
      </Box>
    );
  }

  if (filteredSessions.length === 0) {
    return (
      <Box flexDirection="column" paddingLeft={2}>
        <Text color="gray" dimColor>{`--- Resume session /${search} ------------------------------`}</Text>
        <Text color="gray">No matching sessions.</Text>
        <Text color="gray" dimColor>type to search  esc clear/close</Text>
      </Box>
    );
  }

  const start = Math.max(0, Math.min(selectedIdx - Math.floor(VISIBLE_LIMIT / 2), filteredSessions.length - VISIBLE_LIMIT));
  const visibleSessions = filteredSessions.slice(start, start + VISIBLE_LIMIT);
  const titleSuffix = filteredSessions.length > VISIBLE_LIMIT ? ` (${selectedIdx + 1} of ${filteredSessions.length})` : "";
  const titleWidth = Math.max(24, _width - 42);
  const previewMessages = preview ? toChatMessages(preview.messages) : [];
  const footer = preview?.summary
    ? `${preview.summary.turnCount} messages · ${formatRelativeTime(preview.summary.lastActivityAt)}${preview.summary.gitBranch ? ` · ${preview.summary.gitBranch}` : ""} · $${preview.summary.totalCostUsd.toFixed(4)}`
    : "";

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Text color="gray" dimColor>{`--- Resume session${titleSuffix}${searchMode ? ` /${search}` : ""}${searchScanStatus === "scanning" ? " scanning..." : ""} --------------------------------`}</Text>
      <Box marginLeft={2}>
        <Text bold color="gray">UPDATED     SESSION</Text>
      </Box>
      {visibleSessions.map((s, localIdx) => {
        const i = start + localIdx;
        const active = i === selectedIdx;
        const label = truncate(sessionLabel(s), titleWidth);
        return (
          <Box key={s.sessionId} flexDirection="column">
            <Box gap={1}>
              <Text color={active ? "cyan" : "gray"} bold={active}>
                {active ? ">" : " "}
              </Text>
              <Text color={active ? "cyan" : "gray"} dimColor={!active}>
                {formatRelativeTime(s.lastActivityAt).padEnd(10)}
              </Text>
              <Text color={active ? "white" : "gray"} bold={active} wrap="truncate-end">
                <Highlighted text={label} query={search} />
              </Text>
            </Box>
            <Box marginLeft={2}>
              <Text color={active ? "gray" : "gray"} dimColor>
                {sessionMeta(s)}
              </Text>
            </Box>
          </Box>
        );
      })}
      <Box marginTop={1} flexDirection="column">
        <Text color="gray" dimColor>--- Preview --------------------------------</Text>
        {previewStatus === "loading" ? (
          <Text color="gray" dimColor>Loading preview...</Text>
        ) : previewStatus === "error" ? (
          <Text color="red">Failed to load preview.</Text>
        ) : (
          <>
            <ConversationPanel
              messages={previewMessages}
              width={_width - 4}
              availableHeight={PREVIEW_HEIGHT}
              scrollOffset={previewScrollOffset}
              expandToolOutput={expandPreviewTools}
            />
            <Text color="gray" dimColor>{footer}</Text>
          </>
        )}
      </Box>
      {showBranchCompare && branchCompare.length > 1 ? (
        <Box marginTop={1} flexDirection="column">
          <Text color="gray" dimColor>--- Branch Compare -------------------------</Text>
          {branchCompare
            .slice()
            .slice(0, 8)
            .map((session) => {
              const status = session.branch?.status ?? "active";
              const marker = session.sessionId === selected?.sessionId ? ">" : " ";
              const title = truncate(sessionLabel(session), 40);
              return (
                <Text key={session.sessionId} color={session.sessionId === selected?.sessionId ? "cyan" : "gray"}>
                  {`${marker} ${session.sessionId.slice(0, 8)}  ${status.padEnd(9)}  ${String(session.turnCount).padStart(3)} turns  $${session.totalCostUsd.toFixed(4)}  ${title}`}
                </Text>
              );
            })}
        </Box>
      ) : null}
      <Text color="gray" dimColor>↑↓ select  pgup/pgdn load/jump  u/d preview scroll  o tools  b compare  / search  enter resume  esc close</Text>
    </Box>
  );
}

function toChatMessages(messages: SessionTranscriptPreview["messages"]): ChatMessage[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
    ...(message.toolUses?.length
      ? {
          toolUses: message.toolUses.map((toolUse) => ({
            name: toolUse.name,
            args: toolUse.args,
            result: {
              ok: toolUse.result.ok,
              content: toolUse.result.content,
            },
          })),
        }
      : {}),
  }));
}
