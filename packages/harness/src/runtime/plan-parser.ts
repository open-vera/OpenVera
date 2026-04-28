import type { ExecutionPlan, PlanStep } from "@open-vera/core/types";

/**
 * Extract a JSON block from LLM text output.
 * Tries ```json fence first, then ``` fence, then raw [ ... ] extraction.
 */
function extractJsonBlock(text: string): string | null {
  // 1. Fenced JSON block
  const fencedJson = text.match(/```json\s*([\s\S]*?)```/);
  if (fencedJson) return fencedJson[1].trim();

  // 2. Any fenced block
  const fenced = text.match(/```\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();

  // 3. Raw JSON object/array in text
  const objStart = text.indexOf("{");
  const arrStart = text.indexOf("[");
  if (objStart === -1 && arrStart === -1) return null;

  const start = objStart === -1 ? arrStart : arrStart === -1 ? objStart : Math.min(objStart, arrStart);
  const endChar = text[start] === "{" ? "}" : "]";
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === text[start]) depth++;
    else if (text[i] === endChar) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

const VALID_TYPES = new Set(["analyze", "tool", "delegate", "critique", "finalize"]);
const VALID_RISKS = new Set(["low", "medium", "high"]);

function normalizeType(raw: string): PlanStep["type"] {
  const t = raw.toLowerCase().trim();
  if (VALID_TYPES.has(t)) return t as PlanStep["type"];
  // Heuristic mapping from common LLM outputs
  if (t.includes("read") || t.includes("analy") || t.includes("inspect")) return "analyze";
  if (t.includes("write") || t.includes("edit") || t.includes("exec") || t.includes("run") || t.includes("bash")) return "tool";
  if (t.includes("delegat") || t.includes("subagent")) return "delegate";
  if (t.includes("final") || t.includes("verify") || t.includes("test") || t.includes("check")) return "finalize";
  return "tool";
}

function normalizeRisk(raw: unknown): ExecutionPlan["risk"] {
  if (typeof raw === "string" && VALID_RISKS.has(raw.toLowerCase())) {
    return raw.toLowerCase() as ExecutionPlan["risk"];
  }
  return "medium";
}

function normalizeStep(s: Record<string, unknown>, index: number): PlanStep {
  return {
    id: typeof s.id === "string" && s.id ? s.id : `step_${index + 1}`,
    type: normalizeType(typeof s.type === "string" ? s.type : "tool"),
    action: typeof s.action === "string" && s.action ? s.action : `Step ${index + 1}`,
    dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn.filter((d): d is string => typeof d === "string") : [],
    assignedAgent: typeof s.assignedAgent === "string" ? s.assignedAgent : "default",
    status: "pending",
  };
}

function parseFromJson(raw: Record<string, unknown>): ExecutionPlan | null {
  if (typeof raw.goal !== "string" || !raw.goal) return null;
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) return null;

  return {
    planId: typeof raw.planId === "string" && raw.planId ? raw.planId : `plan-${Date.now()}`,
    goal: raw.goal,
    assumptions: Array.isArray(raw.assumptions) ? raw.assumptions.filter((a): a is string => typeof a === "string") : [],
    steps: raw.steps.map((s, i) => normalizeStep(s as Record<string, unknown>, i)),
    risk: normalizeRisk(raw.risk),
  };
}

/**
 * Parse a numbered list into a fallback single-step Plan.
 * Example input:
 *   1. Read the source file
 *   2. Edit the config
 *   3. Run the tests
 */
function parseNumberedList(text: string, goal: string): ExecutionPlan {
  const lines = text.split("\n");
  const steps: PlanStep[] = [];
  for (const line of lines) {
    const match = line.trim().match(/^(\d+)[.)]\s+(.+)/);
    if (match) {
      const desc = match[2].trim();
      steps.push({
        id: `step_${steps.length + 1}`,
        type: desc.match(/read|查看|阅读|分析|了解|查看/i) ? "analyze" : "tool",
        action: desc,
        dependsOn: [],
        assignedAgent: "default",
        status: "pending",
      });
    }
  }

  if (steps.length === 0) {
    // Absolute fallback: single-step plan
    steps.push({
      id: "step_1",
      type: "tool",
      action: goal,
      dependsOn: [],
      assignedAgent: "default",
      status: "pending",
    });
  }

  return {
    planId: `plan-${Date.now()}`,
    goal,
    assumptions: ["解析失败，降级为单步 Plan"],
    steps,
    risk: "medium",
  };
}

/**
 * Parse arbitrary LLM text output into a structured ExecutionPlan.
 *
 * Strategy:
 * 1. Try to extract and parse a JSON block (preferred)
 * 2. Fall back to parsing a numbered list
 * 3. Absolute fallback: wrap the goal as a single-step plan
 *
 * This is the "解析器" from the roadmap — it handles the raw LLM output
 * that `planFromPrompt` receives, and can also be used independently to
 * parse plan-like output from a general agent response.
 */
export function parseExecutionPlan(text: string, goal: string): ExecutionPlan {
  // Strategy 1: JSON block
  const jsonBlock = extractJsonBlock(text);
  if (jsonBlock) {
    try {
      const parsed = JSON.parse(jsonBlock);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const plan = parseFromJson(parsed as Record<string, unknown>);
        if (plan) return plan;
      }
      // If JSON is an array of steps, wrap it
      if (Array.isArray(parsed) && parsed.length > 0) {
        return {
          planId: `plan-${Date.now()}`,
          goal,
          assumptions: ["从步骤数组解析"],
          steps: parsed.map((s, i) => normalizeStep(s as Record<string, unknown>, i)),
          risk: "medium",
        };
      }
    } catch {
      // JSON parse failed, fall through to next strategy
    }
  }

  // Strategy 2: Numbered list
  return parseNumberedList(text, goal);
}
