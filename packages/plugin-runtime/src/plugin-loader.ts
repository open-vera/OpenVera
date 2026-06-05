import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { PluginDefinition } from "./context.js";
import {
  type DiscoveredPlugin,
  type PluginManifest,
  type PluginSource,
  validatePluginManifest,
} from "./manifest.js";

const MANIFEST_FILENAMES = ["vera-plugin.json", "plugin.json"];

export interface PluginLoaderOptions {
  cwd?: string;
  userPluginDir?: string;
}

export class PluginLoader {
  private readonly cwd: string;
  private readonly userPluginDir?: string;

  constructor(options: PluginLoaderOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.userPluginDir = options.userPluginDir;
  }

  discover(source: PluginSource): DiscoveredPlugin {
    const rootDir = this.resolveSourceRoot(source);
    const { manifest, manifestPath } = loadManifest(rootDir);
    const entryPath = resolve(rootDir, manifest.entry);
    if (!existsSync(entryPath)) {
      throw new Error(`Plugin ${manifest.id} entry does not exist: ${entryPath}`);
    }

    return {
      manifest,
      manifestPath,
      rootDir,
      source,
      checksum: checksumPlugin(manifestPath, entryPath),
    };
  }

  discoverMany(sources: PluginSource[]): DiscoveredPlugin[] {
    return sources.map((source) => this.discover(source));
  }

  async load(plugin: DiscoveredPlugin): Promise<PluginDefinition> {
    const entryPath = resolve(plugin.rootDir, plugin.manifest.entry);
    const mod = await import(pathToFileURL(entryPath).href);
    const definition = (mod as { default?: unknown }).default ?? mod;
    if (!isPluginDefinition(definition)) {
      throw new Error(`Plugin ${plugin.manifest.id} entry must export a plugin definition`);
    }
    return definition;
  }

  private resolveSourceRoot(source: PluginSource): string {
    if (source.path) {
      return isAbsolute(source.path) ? source.path : resolve(this.cwd, source.path);
    }

    if (source.type === "user") {
      if (!this.userPluginDir || !source.packageName) {
        throw new Error("User plugin source requires userPluginDir and packageName when path is omitted");
      }
      return join(this.userPluginDir, source.packageName);
    }

    if ((source.type === "npm" || source.type === "workspace") && source.packageName) {
      const require = createRequire(import.meta.url);
      const packageJsonPath = require.resolve(`${source.packageName}/package.json`, {
        paths: [this.cwd],
      });
      return dirname(packageJsonPath);
    }

    throw new Error(`Plugin source is missing path or packageName: ${source.type}`);
  }
}

function loadManifest(rootDir: string): { manifest: PluginManifest; manifestPath: string } {
  for (const filename of MANIFEST_FILENAMES) {
    const manifestPath = join(rootDir, filename);
    if (existsSync(manifestPath)) {
      const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
      return { manifest: validatePluginManifest(raw), manifestPath };
    }
  }

  const packageJsonPath = join(rootDir, "package.json");
  if (existsSync(packageJsonPath)) {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as Record<string, unknown>;
    const raw = packageJson["veraPlugin"] ?? packageJson["vera.plugin"];
    if (raw) {
      return { manifest: validatePluginManifest(raw), manifestPath: packageJsonPath };
    }
  }

  throw new Error(`No Vera plugin manifest found in ${rootDir}`);
}

function checksumPlugin(manifestPath: string, entryPath: string): string {
  const hash = createHash("sha256");
  hash.update(readFileSync(manifestPath));
  hash.update("\0");
  hash.update(readFileSync(entryPath));
  return `sha256:${hash.digest("hex")}`;
}

function isPluginDefinition(value: unknown): value is PluginDefinition {
  return typeof value === "object"
    && value !== null
    && typeof (value as PluginDefinition).activate === "function";
}
