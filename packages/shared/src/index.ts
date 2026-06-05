export type CapabilityKind =
  | "config"
  | "provider"
  | "model"
  | "prompt"
  | "context"
  | "memory"
  | "rag"
  | "skill"
  | "plugin"
  | "mcp"
  | "channel"
  | "sandbox"
  | "flow"
  | "conversation"
  | "tool"
  | "log"
  | "cost";

export type CapabilityScope = "global" | "project" | "session" | "run";

export type CapabilityStatus = "available" | "disabled" | "error" | "unknown" | "shadow";

export type CapabilityAction =
  | "view"
  | "edit"
  | "enable"
  | "disable"
  | "test"
  | "reload"
  | "reindex"
  | "connect"
  | "disconnect";

export interface CapabilityHealth {
  ok: boolean;
  message?: string;
  checkedAt: string;
}

export interface CapabilityDescriptor {
  id: string;
  kind: CapabilityKind;
  name: string;
  status: CapabilityStatus;
  scope: CapabilityScope;
  source: string;
  projectId?: string;
  configPath?: string;
  health?: CapabilityHealth;
  actions: CapabilityAction[];
  metadata: Record<string, unknown>;
}

export interface GatewayProject {
  id: string;
  name: string;
  rootDir: string;
  veraDir: string;
  flowsDir: string;
  source: "explicit" | "discovered";
}

export interface ProjectRegistryOptions {
  roots: string[];
  includeChildren?: boolean;
}

export type DoctorStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  id: string;
  label: string;
  status: DoctorStatus;
  scope: "gateway" | "project" | "capability";
  message: string;
  projectId?: string;
  capabilityId?: string;
  details: Record<string, unknown>;
}

export interface DoctorReport {
  generatedAt: string;
  status: DoctorStatus;
  checks: DoctorCheck[];
}
