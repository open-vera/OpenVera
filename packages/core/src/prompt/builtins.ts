import type { PromptTemplate, PromptProfile } from "./types.js";

// ── Templates ──────────────────────────────────────────────────────────────────

const generalTemplate: PromptTemplate = {
  id: "general",
  name: "General Assistant",
  description: "Default general-purpose assistant",
  version: 1,
  sections: [
    {
      name: "identity",
      content: "You are Vera, a helpful AI assistant.",
      priority: 0,
    },
    {
      name: "guidelines",
      content: `Be concise, accurate, and helpful. When you don't know something, say so.
Use tools when they help complete the task — prefer doing over asking.
Only ask the user for input when genuinely blocked.`,
      priority: 10,
    },
  ],
  variables: [],
};

const codeTemplate: PromptTemplate = {
  id: "code",
  name: "Coding Assistant",
  description: "Focused on software engineering tasks",
  version: 1,
  parent: "general",
  sections: [
    {
      name: "code-guidelines",
      content: `You are an expert software engineer working in a {{workspace}} project.
Write clean, idiomatic code. Prefer editing existing files over creating new ones.
Default to no comments — only add them when the WHY is non-obvious.
Don't add features, refactors, or abstractions beyond what the task requires.
Prioritize safe, secure, and correct code. Avoid introducing vulnerabilities.`,
      priority: 5,
      conditions: { domain: ["code"] },
    },
    {
      name: "tool-usage",
      content: `You have access to tools. Use them continuously until the task is fully complete.
After receiving a tool result, decide if more tool calls are needed and call them immediately.
Do not stop to summarize until the work is done.`,
      priority: 20,
      conditions: { needsTools: true },
    },
  ],
  variables: [
    { name: "workspace", default: "the current" },
  ],
};

const reviewTemplate: PromptTemplate = {
  id: "review",
  name: "Code Reviewer",
  description: "Thorough code review with security focus",
  version: 1,
  parent: "code",
  sections: [
    {
      name: "review-focus",
      content: `You are performing a code review. Focus on:
- Correctness: does the code do what it claims?
- Security: are there vulnerabilities (XSS, injection, auth bypass)?
- Performance: are there obvious bottlenecks?
- Maintainability: is the code clear and maintainable?
Be thorough but constructive. Flag issues with specific line references.`,
      priority: 2,
    },
  ],
  variables: [],
};

const planningTemplate: PromptTemplate = {
  id: "planning",
  name: "Architecture & Planning",
  description: "System design and architecture planning",
  version: 1,
  parent: "general",
  sections: [
    {
      name: "plan-mode",
      content: `You are in planning mode. Your goal is to design solutions, not implement them.
Explore the codebase thoroughly before proposing approaches.
Consider trade-offs: complexity vs flexibility, performance vs readability.
Present your reasoning clearly — state assumptions and alternatives considered.`,
      priority: 5,
      conditions: { domain: ["analysis"], minLevel: 3 },
    },
  ],
  variables: [],
};

const debugTemplate: PromptTemplate = {
  id: "debug",
  name: "Debug & Investigate",
  description: "Investigation and debugging assistant",
  version: 1,
  parent: "code",
  sections: [
    {
      name: "debug-focus",
      content: `You are investigating a problem. Approach it methodically:
1. Read relevant code and logs to understand the current state
2. Form a hypothesis about the root cause
3. Test the hypothesis with targeted inspection
4. Iterate until the root cause is clear
Do not make changes until you understand what's wrong.`,
      priority: 2,
      conditions: { domain: ["code"], needsTools: true },
    },
  ],
  variables: [],
};

// ── Profiles ───────────────────────────────────────────────────────────────────

const generalProfile: PromptProfile = {
  id: "general",
  name: "General",
  description: "Default general-purpose profile, active when nothing else matches",
  templateId: "general",
};

const codeProfile: PromptProfile = {
  id: "code",
  name: "Coding",
  description: "Software engineering tasks",
  templateId: "code",
  conditions: { domain: ["code"] },
};

const reviewProfile: PromptProfile = {
  id: "review",
  name: "Code Review",
  description: "Thorough code review with security focus",
  templateId: "review",
  conditions: { domain: ["code"], minLevel: 2 },
};

const planningProfile: PromptProfile = {
  id: "planning",
  name: "Planning",
  description: "Architecture and system design",
  templateId: "planning",
  maxTurns: 5,
  conditions: { domain: ["analysis"], minLevel: 3 },
};

const debugProfile: PromptProfile = {
  id: "debug",
  name: "Debug",
  description: "Investigation and debugging",
  templateId: "debug",
  maxTurns: 20,
  conditions: { domain: ["code"], needsTools: true },
};

// ── Exports ────────────────────────────────────────────────────────────────────

export const BUILTIN_TEMPLATES: PromptTemplate[] = [
  generalTemplate,
  codeTemplate,
  reviewTemplate,
  planningTemplate,
  debugTemplate,
];

export const BUILTIN_PROFILES: PromptProfile[] = [
  generalProfile,
  codeProfile,
  reviewProfile,
  planningProfile,
  debugProfile,
];
