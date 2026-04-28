import type { PromptIntent, PromptSection, PromptTemplate } from "./types.js";

/** Check whether an intent satisfies a section's conditions. */
function matchesCondition(
  intent: PromptIntent,
  section: PromptSection
): boolean {
  const c = section.conditions;
  if (!c) return true;
  if (c.domain && !c.domain.includes(intent.domain)) return false;
  if (c.minLevel !== undefined && intent.level < c.minLevel) return false;
  if (c.needsTools !== undefined && intent.needs_tools !== c.needsTools)
    return false;
  return true;
}

/** Replace {{varName}} placeholders with values from the map. */
function substitute(
  content: string,
  variables: Record<string, string>
): string {
  return content.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
    return variables[name] ?? `{{${name}}}`;
  });
}

/** Resolve a template chain (parent → child) into a flat section list. */
function resolveChain(
  template: PromptTemplate,
  getTemplate: (id: string) => PromptTemplate | undefined
): PromptTemplate {
  if (!template.parent) return template;

  const parent = getTemplate(template.parent);
  if (!parent) return template;

  const resolvedParent = resolveChain(parent, getTemplate);

  return {
    ...template,
    sections: [
      ...resolvedParent.sections.filter(
        (ps) =>
          !template.sections.some((cs) => cs.name === ps.name)
      ),
      ...template.sections,
    ],
    variables: [
      ...resolvedParent.variables.filter(
        (pv) => !template.variables.some((cv) => cv.name === pv.name)
      ),
      ...template.variables,
    ],
  };
}

/**
 * Render a template into a final system-prompt string.
 *
 * 1. Resolve parent chain (inheritance)
 * 2. Filter sections by intent conditions
 * 3. Sort by priority
 * 4. Substitute {{variables}}
 * 5. Join with "\n\n"
 */
export function renderTemplate(
  template: PromptTemplate,
  intent: PromptIntent,
  variableOverrides?: Record<string, string>,
  getTemplate?: (id: string) => PromptTemplate | undefined
): string {
  const resolved = getTemplate
    ? resolveChain(template, getTemplate)
    : template;

  // Build variable map: defaults → overrides
  const vars: Record<string, string> = {};
  for (const v of resolved.variables) {
    if (v.default !== undefined) vars[v.name] = v.default;
  }
  if (variableOverrides) {
    for (const [k, v] of Object.entries(variableOverrides)) {
      vars[k] = v;
    }
  }

  const active = resolved.sections.filter((s) =>
    matchesCondition(intent, s)
  );

  const ordered = [...active].sort(
    (a, b) => (a.priority ?? 0) - (b.priority ?? 0)
  );

  return ordered
    .map((s) => substitute(s.content, vars))
    .join("\n\n");
}
