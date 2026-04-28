// Prompt Management System — core types

export type IntentDomain = "chat" | "code" | "search" | "writing" | "analysis" | "other";

/** Minimal intent signal used to match sections and profiles. */
export interface PromptIntent {
  domain: IntentDomain;
  level: 0 | 1 | 2 | 3;
  needs_tools: boolean;
}

/** Conditions that gate a section — all specified conditions must match. */
export interface PromptCondition {
  domain?: IntentDomain[];
  minLevel?: number;
  needsTools?: boolean;
}

/** A named block of the system prompt, conditionally included. */
export interface PromptSection {
  name: string;
  content: string;
  /** Lower numbers appear first. Default 0. */
  priority?: number;
  /** If set, the section is only rendered when conditions match. */
  conditions?: PromptCondition;
}

/** Variable placeholder for template substitution. */
export interface PromptVariable {
  name: string;
  default?: string;
  required?: boolean;
}

/** A versioned system-prompt template composed of sections. */
export interface PromptTemplate {
  id: string;
  name: string;
  description: string;
  version: number;
  sections: PromptSection[];
  variables: PromptVariable[];
  /** Extend another template (sections merged, child sections appended after parent). */
  parent?: string;
}

/** A profile bundles a template reference with optional model / tool preferences. */
export interface PromptProfile {
  id: string;
  name: string;
  description: string;
  templateId: string;
  templateVersion?: number;
  /** Override model selection when this profile is active. */
  model?: string;
  /** Override max turns. */
  maxTurns?: number;
  /** If set, only these tools are available. */
  toolWhitelist?: string[];
  /** If set, these tools are excluded. */
  toolBlacklist?: string[];
  /** Trigger conditions for auto-activation. */
  conditions?: PromptCondition;
  /** Template variable overrides. */
  variables?: Record<string, string>;
}

/** The fully rendered result ready to pass to streamAgent. */
export interface RenderedPrompt {
  system: string;
  templateId: string;
  templateVersion: number;
  profileId: string;
  maxTurns?: number;
}
