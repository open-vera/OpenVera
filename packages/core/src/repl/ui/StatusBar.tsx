import { Box, Text } from "ink";
import { useState, useEffect } from "react";
import type { StreamStatus } from "./types.js";

// Breathing animation frames — brightness pulses in and out
const BREATH_FRAMES = [
  { char: "●", color: "#1a6b4a" },
  { char: "●", color: "#1f8a5e" },
  { char: "●", color: "#27a872" },
  { char: "●", color: "#33cc8a" },
  { char: "●", color: "#44eea0" },
  { char: "●", color: "#33cc8a" },
  { char: "●", color: "#27a872" },
  { char: "●", color: "#1f8a5e" },
];
const BREATH_MS = 120;

interface StatusBarProps {
  status: StreamStatus;
  outputTokens: number;
  pendingCount: number;
  scrollOffset?: number;
  expandToolOutput?: boolean;
}

export function StatusBar({
  status,
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
          <Text color="yellow">↑</Text>
          <Text color="gray">
            滚动中  PageDown 向下  PageUp 继续上滚  ⌥O {expandToolOutput ? "折叠工具输出" : "展开工具输出"}
          </Text>
        </Box>
      );
    }
    return (
      <Box gap={1}>
        <Text color="gray">⌥O {expandToolOutput ? "折叠工具输出" : "展开工具输出"}</Text>
      </Box>
    );
  }

  const frame = BREATH_FRAMES[breathFrame]!;
  const statusLabel =
    status === "thinking" ? "thinking" :
    status === "planning" ? "planning" :
    `↓ ${outputTokens} tokens`;

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
      <Text color="gray">{parts.join(" · ")}</Text>
    </Box>
  );
}
