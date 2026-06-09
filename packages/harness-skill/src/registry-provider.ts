// RegistryToolProvider — 把 Core ToolHost/ToolRegistry 适配为 BuiltinToolProvider
//
// Skill loader 通过这个 adapter 把 skill 文件里的工具 id（如 "read_file"）
// 解析成 { definition: Tool, executor: ToolExecutor }，不需要感知 ToolHost 内部。

import type { BuiltinToolProvider } from "./loader.js";
import type { ToolExecutor } from "./types.js";
import type { Tool } from "@open-vera/core/types";

export interface ToolExecutionHostLike {
  getSchemas(): Tool[];
  execute(
    name: string,
    args: Record<string, unknown>,
    ctx: { cwd: string; sessionId: string }
  ): Promise<{ content: string }>;
}

export type RegistryLike = ToolExecutionHostLike;

export class RegistryToolProvider implements BuiltinToolProvider {
  constructor(
    private registry: ToolExecutionHostLike,
    private cwd: string,
    private sessionId: string
  ) {}

  resolve(name: string): { definition: Tool; executor: ToolExecutor } | null {
    const schema = this.registry.getSchemas().find((t) => t.name === name);
    if (!schema) return null;

    const executor: ToolExecutor = async (args) => {
      const result = await this.registry.execute(name, args, {
        cwd: this.cwd,
        sessionId: this.sessionId,
      });
      return result.content;
    };

    return { definition: schema, executor };
  }
}
