// 核心协议：消息格式（类 OpenAI）

export type Role = "system" | "user" | "assistant" | "tool";

export interface TextPart {
  type: "text";
  text: string;
}

export interface ImagePart {
  type: "image_url";
  image_url: { url: string };
}

export interface ToolCallPart {
  type: "tool_call";
  id: string;
  name: string;
  arguments: string; // JSON string
}

export interface ToolResultPart {
  type: "tool_result";
  tool_call_id: string;
  content: string;
}

export type ContentPart = TextPart | ImagePart | ToolCallPart | ToolResultPart;

export interface Message {
  role: Role;
  content: string | ContentPart[];
  // tool_call_id 用于 role=tool 时关联结果
  tool_call_id?: string;
}
