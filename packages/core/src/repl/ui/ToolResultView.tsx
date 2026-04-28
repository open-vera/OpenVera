import { Box, Text } from "ink";
import React from "react";
import type { ToolResult } from "../../tools/types.js";
import { DiffView } from "./DiffView.js";
import { ErrorView } from "./renderers/ErrorView.js";
import { TextView } from "./renderers/TextView.js";
import { CodeView } from "./renderers/CodeView.js";
import { BashOutputView } from "./renderers/BashOutputView.js";
import { FileListView } from "./renderers/FileListView.js";

interface ToolResultViewProps {
  toolName: string;
  args: Record<string, unknown>;
  result: ToolResult;
  width: number;
}

// Summarise args into a short label for the header line
function argsLabel(toolName: string, args: Record<string, unknown>): string {
  const path = args.path ?? args.command ?? args.pattern ?? args.query;
  if (typeof path === "string") return path.length > 50 ? path.slice(0, 50) + "…" : path;
  return "";
}

export function ToolResultView({ toolName, args, result, width }: ToolResultViewProps) {
  const label = argsLabel(toolName, args);
  const divider = "─".repeat(Math.min(width, 40));

  const header = (
    <Box>
      <Text color="yellow" bold>{toolName}</Text>
      {label ? <Text color="gray">{"  "}{label}</Text> : null}
    </Box>
  );

  let body: React.ReactNode;

  if (!result.ok) {
    body = (
      <ErrorView
        message={result.error?.message ?? result.content}
        code={result.error?.code}
      />
    );
  } else {
    const hint = result.metadata?.renderHint;
    const diffMeta = result.metadata?.diff;
    switch (hint?.type) {
      case "diff":
        body = diffMeta ? (
          <DiffView filePath={diffMeta.filePath} hunks={diffMeta.hunks} width={width} />
        ) : (
          <TextView content={result.content} width={width} />
        );
        break;
      case "code":
        body = <CodeView content={result.content} lang={hint.lang} width={width} />;
        break;
      case "file-list":
        body = <FileListView content={result.content} />;
        break;
      case "bash-output":
        body = <BashOutputView content={result.content} exitCode={hint.exitCode} width={width} />;
        break;
      default:
        body = <TextView content={result.content} width={width} />;
    }
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      {header}
      <Text color="gray">{divider}</Text>
      {body}
    </Box>
  );
}
