import React from "react";
import { Box, Text } from "ink";
import type { RoutingInfo, StreamStatus, TokenUsage } from "./types.js";

interface StatusPanelProps {
  routing: RoutingInfo;
  usage: TokenUsage;
  status: StreamStatus;
  width: number;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function fmt(n: number): string {
  return n.toLocaleString();
}

export function StatusPanel({ routing, usage, status, width }: StatusPanelProps) {
  const labelWidth = width - 2;

  const statusColor = status === "idle" ? "green" : "yellow";
  const statusDot = status === "idle" ? "●" : "◉";
  const statusText =
    status === "idle" ? "Ready" : status === "thinking" ? "Thinking..." : "Streaming...";

  return (
    <Box flexDirection="column" width={width} paddingLeft={1}>
      <Text bold color="cyan">Provider</Text>
      <Text>{truncate(routing.provider, labelWidth)}</Text>
      <Text> </Text>

      <Text bold color="cyan">Model</Text>
      <Text>{truncate(routing.model, labelWidth)}</Text>
      <Text> </Text>

      <Text bold color="cyan">Tokens</Text>
      <Text> in:  {fmt(usage.inputTotal)}</Text>
      <Text> out: {fmt(usage.outputTotal)}</Text>
      <Text> </Text>

      {routing.intent && (
        <>
          <Text bold color="cyan">Intent</Text>
          <Text> L{routing.intent.level} · {routing.intent.domain}</Text>
          <Text> {"→"} {routing.provider}</Text>
          <Text> </Text>
        </>
      )}

      <Text color={statusColor}>{statusDot} {statusText}</Text>
    </Box>
  );
}
