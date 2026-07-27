export function formatRunLogPlaceholder(path: string, error?: unknown): string {
  const message =
    error instanceof Error ? error.message : error == null ? "" : String(error);
  const details = message
    ? [
        "",
        "底层读取信息：",
        message,
        "",
      ]
    : [""];

  return [
    "日志文件尚未生成。",
    "",
    `路径：${path}`,
    "",
    "Agent 开始写入后会在这里生成运行日志；如果刚刚启动任务，请稍后再点一次日志。",
    ...details,
  ].join("\n");
}

export function formatRunLogReadFailure(path: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return [
    "日志文件读取失败。",
    "",
    `路径：${path}`,
    "",
    "可能原因：当前工作区路径不正确，或日志文件权限异常。",
    "",
    `错误：${message}`,
    "",
  ].join("\n");
}

export function formatRunLogTruncationNotice(
  path: string,
  shownBytes: number,
  totalBytes: number,
): string {
  return [
    `// Log truncated for UI performance (${totalBytes} bytes total; showing last ${shownBytes}).`,
    `// Open in an external editor for the full file: ${path}`,
    "",
  ].join("\n");
}
