import { Box, Text } from "ink";
import React from "react";
import { theme } from "./theme.js";
import type { ToolResult } from "../../tools/types.js";
import { DiffView } from "./DiffView.js";
import { ErrorView } from "./renderers/ErrorView.js";
import { TextView } from "./renderers/TextView.js";
import { CodeView } from "./renderers/CodeView.js";
import { BashOutputView } from "./renderers/BashOutputView.js";
import { FileListView } from "./renderers/FileListView.js";
import { compactToolSummary, toolArgsLabel } from "./controller/toolProjection.js";

interface ToolResultViewProps {
  toolName: string;
  args: Record<string, unknown>;
  result: ToolResult;
  width: number;
  preface?: string;
  expanded?: boolean;
}

export function ToolResultView({ toolName, args, result, width, preface, expanded }: ToolResultViewProps) {
  const label = toolArgsLabel(toolName, args);

  const header = (
    <Box>
      <Text color={theme.toolName} bold>{toolName}</Text>
      {label ? <Text color={toolName === "bash" ? theme.text : theme.suggestion}>{"  "}{label}</Text> : null}
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
    const compactSummary = compactToolSummary(toolName, result);
    if (!expanded && compactSummary) {
      body = <Text>{compactSummary}</Text>;
    } else switch (hint?.type) {
      case "diff":
        body = diffMeta ? (
          <DiffView filePath={diffMeta.filePath} hunks={diffMeta.hunks} width={width} />
        ) : (
          <TextView content={result.content} width={width} expanded={expanded} />
        );
        break;
      case "code":
        body = <CodeView content={result.content} lang={hint.lang} width={width} expanded={expanded} />;
        break;
      case "file-list":
        body = <FileListView content={result.content} expanded={expanded} />;
        break;
      case "bash-output":
        body = <BashOutputView content={result.content} exitCode={hint.exitCode} width={width} expanded={expanded} />;
        break;
      default:
        body = <TextView content={result.content} width={width} expanded={expanded} />;
    }
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      {preface ? <Text>{preface}</Text> : null}
      {header}
      {body}
    </Box>
  );
}
