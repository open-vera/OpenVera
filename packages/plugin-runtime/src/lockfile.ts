import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PluginPermissions, PluginSource } from "./manifest.js";

export interface PluginLockRecord {
  id: string;
  source: PluginSource;
  version: string;
  checksum: string;
  enabled: boolean;
  approvedPermissions: PluginPermissions;
  activatedAt?: string;
  lastError?: string;
}

export interface PluginLockfile {
  version: 1;
  plugins: Record<string, PluginLockRecord>;
}

export class PluginLockfileStore {
  readonly path: string;

  constructor(rootDir: string, path = join(rootDir, ".vera", "plugins-lock.json")) {
    this.path = path;
  }

  load(): PluginLockfile {
    if (!existsSync(this.path)) {
      return { version: 1, plugins: {} };
    }

    const parsed = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
    if (!isLockfile(parsed)) {
      throw new Error(`Invalid plugin lockfile: ${this.path}`);
    }
    return parsed;
  }

  save(lockfile: PluginLockfile): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, `${JSON.stringify(lockfile, null, 2)}\n`, "utf8");
  }

  get(pluginId: string): PluginLockRecord | undefined {
    return this.load().plugins[pluginId];
  }

  upsert(record: PluginLockRecord): PluginLockRecord {
    const lockfile = this.load();
    lockfile.plugins[record.id] = record;
    this.save(lockfile);
    return record;
  }

  update(pluginId: string, update: Partial<PluginLockRecord>): PluginLockRecord {
    const lockfile = this.load();
    const existing = lockfile.plugins[pluginId];
    if (!existing) {
      throw new Error(`Plugin ${pluginId} is not present in lockfile`);
    }
    const next = { ...existing, ...update, id: pluginId };
    lockfile.plugins[pluginId] = next;
    this.save(lockfile);
    return next;
  }

  remove(pluginId: string): boolean {
    const lockfile = this.load();
    const existed = pluginId in lockfile.plugins;
    delete lockfile.plugins[pluginId];
    if (existed) this.save(lockfile);
    return existed;
  }
}

function isLockfile(value: unknown): value is PluginLockfile {
  return typeof value === "object"
    && value !== null
    && (value as PluginLockfile).version === 1
    && typeof (value as PluginLockfile).plugins === "object"
    && (value as PluginLockfile).plugins !== null;
}
