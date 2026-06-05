export const PLUGIN_API_VERSION = "1";

export type PluginScope = "builtin" | "project" | "workspace" | "user";

export type PluginSourceType = "builtin" | "local" | "user" | "workspace" | "npm";

export interface PluginSource {
  type: PluginSourceType;
  path?: string;
  packageName?: string;
}

export interface PluginPermissionFs {
  mode: "read" | "write" | "readwrite";
  paths: string[];
}

export interface PluginPermissionNetwork {
  host: string;
}

export interface PluginPermissions {
  fs?: PluginPermissionFs[];
  network?: PluginPermissionNetwork[];
  env?: string[];
  secrets?: string[];
  tools?: string[];
  [key: string]: unknown;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  apiVersion: string;
  entry: string;
  scope: PluginScope;
  activationEvents: string[];
  contributes?: Record<string, unknown>;
  permissions?: PluginPermissions;
}

export interface DiscoveredPlugin {
  manifest: PluginManifest;
  manifestPath: string;
  rootDir: string;
  source: PluginSource;
  checksum: string;
}

export function validatePluginManifest(input: unknown): PluginManifest {
  if (!isRecord(input)) {
    throw new Error("Plugin manifest must be an object");
  }

  const manifest = input as Record<string, unknown>;
  const id = requiredString(manifest, "id");
  const name = requiredString(manifest, "name");
  const version = requiredString(manifest, "version");
  const apiVersion = requiredString(manifest, "apiVersion");
  const entry = requiredString(manifest, "entry");
  const scope = requiredString(manifest, "scope");
  const activationEvents = requiredStringArray(manifest, "activationEvents");

  if (!["builtin", "project", "workspace", "user"].includes(scope)) {
    throw new Error(`Plugin manifest scope is unsupported: ${scope}`);
  }

  const manifestApiMajor = apiVersion.split(".")[0];
  const runtimeApiMajor = PLUGIN_API_VERSION.split(".")[0];
  if (manifestApiMajor !== runtimeApiMajor) {
    throw new Error(
      `Plugin manifest apiVersion ${apiVersion} is incompatible with runtime API ${PLUGIN_API_VERSION}`,
    );
  }

  const contributes = optionalRecord(manifest, "contributes");
  const permissions = optionalRecord(manifest, "permissions") as PluginPermissions | undefined;

  return {
    id,
    name,
    version,
    apiVersion,
    entry,
    scope: scope as PluginScope,
    activationEvents,
    ...(contributes ? { contributes } : {}),
    ...(permissions ? { permissions } : {}),
  };
}

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Plugin manifest field "${key}" is required`);
  }
  return value;
}

function requiredStringArray(input: Record<string, unknown>, key: string): string[] {
  const value = input[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Plugin manifest field "${key}" must be a string array`);
  }
  return value;
}

function optionalRecord(input: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error(`Plugin manifest field "${key}" must be an object`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
