import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import type { StreamStatus } from "./types.js";
import { theme } from "./theme.js";

const BREATH_FRAMES = theme.spinnerFrames.map((color) => ({ char: "●", color }));
const BREATH_MS = 120;

interface StatusBarProps {
  status: StreamStatus;
  inputTokens: number;
  outputTokens: number;
  pendingCount: number;
  scrollOffset?: number;
  expandToolOutput?: boolean;
}

export function StatusBar({
  status,
  inputTokens,
  outputTokens,
  pendingCount,
  scrollOffset = 0,
  expandToolOutput,
}: StatusBarProps) {
  const [elapsedSec, setElapsedSec] = useState(0);
  const [breathFrame, setBreathFrame] = useState(0);

  useEffect(() => {
    if (status === "idle") {
      setElapsedSec(0);
      return;
    }
    setElapsedSec(0);
    const timer = setInterval(() => setElapsedSec((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [status]);

  useEffect(() => {
    if (status === "idle") {
      setBreathFrame(0);
      return;
    }
    const anim = setInterval(
      () => setBreathFrame((f) => (f + 1) % BREATH_FRAMES.length),
      BREATH_MS,
    );
    return () => clearInterval(anim);
  }, [status]);

  if (status === "idle") {
    // Show a scroll hint when user has scrolled up
    if (scrollOffset > 0) {
      return (
        <Box gap={1}>
          <Text color={theme.warning}>↑</Text>
          <Text color={theme.textDim}>
            滚动中  PageDown 向下  PageUp 继续上滚  ⌥O {expandToolOutput ? "折叠工具输出" : "展开工具输出"}
          </Text>
        </Box>
      );
    }
    return (
      <Box gap={1}>
        <Text color={theme.textDim}>⌥O {expandToolOutput ? "折叠工具输出" : "展开工具输出"}</Text>
      </Box>
    );
  }

  const frame = BREATH_FRAMES[breathFrame]!;
  const statusLabel =
    status === "thinking" ? "thinking" :
    status === "planning" ? "planning" :
    `↑ ${inputTokens} · ↓ ${outputTokens} tokens`;

  const parts = [
    `${elapsedSec}s`,
    statusLabel,
    "esc to cancel",
    `⌥O ${expandToolOutput ? "collapse tools" : "expand tools"}`,
  ];
  if (pendingCount > 0) parts.push(`${pendingCount} queued`);

  return (
    <Box gap={1}>
      <Text color={frame.color}>{frame.char}</Text>
      <Text color={theme.textDim}>{parts.join(" · ")}</Text>
    </Box>
  );
}
