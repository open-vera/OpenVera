// SkillResolver — 按 intent 决定激活哪些 skills，组装 SkillBundle

import type { Skill, SkillBundle, SkillTrigger, IntentSignal } from "./types.js";

export class SkillResolver {
  private skills: Map<string, Skill> = new Map();

  register(skill: Skill): void {
    this.skills.set(skill.id, skill);
  }

  registerAll(skills: Skill[]): void {
    for (const skill of skills) this.register(skill);
  }

  /**
   * 按 intent 选择激活的 skills，组装出 streamAgent 需要的参数。
   * @param intent   意图信号（domain / level / needs_tools / explicitIds）
   * @param baseSystem  基础 system prompt
   */
  resolve(intent: IntentSignal, baseSystem: string): SkillBundle {
    const active = [...this.skills.values()].filter((s) =>
      s.triggers.some((t) => this.matches(t, intent, s.id))
    );

    const fragments: string[] = [];
    const tools: SkillBundle["tools"] = [];
    const executors: SkillBundle["executors"] = new Map();

    for (const skill of active) {
      if (skill.systemFragment) fragments.push(skill.systemFragment);
      for (const t of skill.tools ?? []) {
        // Last-registered wins on name collision
        if (!executors.has(t.definition.name)) {
          tools.push(t.definition);
          executors.set(t.definition.name, t.executor);
        }
      }
    }

    return {
      system: fragments.length
        ? [baseSystem, ...fragments].join("\n\n")
        : baseSystem,
      tools,
      executors,
    };
  }

  /** List skills visible to the user (for /skill command). */
  list(): Array<{ id: string; name: string; description: string; auto: boolean }> {
    return [...this.skills.values()].map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      auto: s.triggers.some((t) => t.type !== "explicit"),
    }));
  }

  private matches(trigger: SkillTrigger, intent: IntentSignal, skillId: string): boolean {
    switch (trigger.type) {
      case "always":
        return true;
      case "domain":
        return trigger.domains.includes(intent.domain);
      case "level":
        return intent.level >= trigger.minLevel;
      case "needs_tools":
        return intent.needs_tools;
      case "explicit":
        return intent.explicitIds?.includes(skillId) ?? false;
    }
  }
}
