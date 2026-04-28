// 核心协议：工具定义

export interface ToolParameter {
  type: string;
  description?: string;
  enum?: string[];
  items?: ToolParameter;
  properties?: Record<string, ToolParameter>;
  required?: string[];
}

export interface Tool {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, ToolParameter>;
    required?: string[];
  };
  /**
   * Maximum tool result size in characters before the output is persisted to
   * disk and replaced with a preview + filepath message.
   * Defaults to DEFAULT_MAX_RESULT_SIZE_CHARS (50 000).
   * Set to Infinity for tools that self-bound their output (e.g. read_file
   * uses its own maxTokens parameter and needs no external truncation).
   */
  maxResultSizeChars?: number;
}
