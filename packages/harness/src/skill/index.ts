// Skill 系统入口

export { SkillResolver } from "./resolver.js";
export { loadSkillFile, loadSkillDir } from "./loader.js";
export { RegistryToolProvider } from "./registry-provider.js";
export type {
  Skill,
  SkillTrigger,
  SkillBundle,
  SkillTool,
  ToolExecutor,
  IntentDomain,
  IntentSignal,
} from "./types.js";
export type { BuiltinToolProvider } from "./loader.js";
export type { RegistryLike } from "./registry-provider.js";

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SkillResolver } from "./resolver.js";
import { loadSkillDir } from "./loader.js";
import type { BuiltinToolProvider } from "./loader.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

/** 内置 skill 目录（编译后位于 dist/ 同级的 skills/） */
const BUILTIN_SKILLS_DIR = join(__dirname, "..", "..", "skills");

/**
 * 创建并预加载内置 skills 的 SkillResolver。
 * @param toolProvider  提供内置工具 schema + executor（通常是 RegistryToolProvider）
 * @param extraSkillDirs  额外 skill 目录（项目级 / 用户级）
 */
export function createSkillResolver(
  toolProvider?: BuiltinToolProvider,
  ...extraSkillDirs: string[]
): SkillResolver {
  const resolver = new SkillResolver();

  // 加载内置 skills
  const builtins = loadSkillDir(BUILTIN_SKILLS_DIR, toolProvider);
  resolver.registerAll(builtins);

  // 加载额外目录
  for (const dir of extraSkillDirs) {
    const extras = loadSkillDir(dir, toolProvider);
    resolver.registerAll(extras);
  }

  return resolver;
}
