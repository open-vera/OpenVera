#!/usr/bin/env node
/**
 * One-off migration: legacy per-project `<root>/.vera/partner-sessions.json`
 * -> global `~/.vera/partner/app-state.json`.
 *
 * The Workbench Host refactor moved persistence from per-project files to a
 * single global app-state and dropped the legacy reader, orphaning old history.
 * This script backfills it. Delete this file once you've run it.
 *
 * Usage:
 *   node scripts/migrate-legacy-sessions.mjs --scan ~/workspace [--dry-run]
 *   node scripts/migrate-legacy-sessions.mjs /path/to/projectA /path/to/projectB
 *
 * Options:
 *   --dry-run              report only, write nothing
 *   --scan <dir>           also pick up <dir>/<*>/.vera/partner-sessions.json
 *   --max-per-project <n>  keep only the n most recently updated sessions
 *                          (default 30; use --all to migrate everything)
 *   --all                  no per-project cap
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, basename } from "node:path";

const DEFAULT_MAX_PER_PROJECT = 30;

function parseArgs(argv) {
  const options = {
    roots: [],
    scanDirs: [],
    dryRun: false,
    maxPerProject: DEFAULT_MAX_PER_PROJECT,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--all") options.maxPerProject = Infinity;
    else if (arg === "--scan") options.scanDirs.push(expandHome(argv[++i]));
    else if (arg === "--max-per-project") options.maxPerProject = Number(argv[++i]);
    else if (arg.startsWith("--")) throw new Error(`unknown option: ${arg}`);
    else options.roots.push(expandHome(arg));
  }
  return options;
}

function expandHome(input) {
  if (!input) return input;
  return resolve(input.startsWith("~") ? join(homedir(), input.slice(1)) : input);
}

/** Mirrors host::state::normalize_path. */
function normalizePath(path) {
  let out = path.replace(/\\/g, "/");
  while (out.endsWith("/") && out.length > 1) out = out.slice(0, -1);
  return out;
}

/** Mirrors host::state::project_id_from_root — must stay byte-identical. */
function projectIdFromRoot(rootPath) {
  const bytes = Buffer.from(normalizePath(rootPath), "utf8");
  let hash = 0;
  for (const byte of bytes) hash = (Math.imul(hash, 31) + byte) >>> 0;
  return `proj_${hash.toString(16)}`;
}

function projectNameFromRoot(rootPath) {
  const normalized = normalizePath(rootPath);
  return normalized.split("/").filter(Boolean).pop() ?? normalized;
}

function legacyFileFor(root) {
  return join(root, ".vera", "partner-sessions.json");
}

function discoverRoots(options) {
  const found = new Set(options.roots.filter((root) => existsSync(legacyFileFor(root))));
  for (const dir of options.scanDirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const root = join(dir, entry.name);
      if (existsSync(legacyFileFor(root))) found.add(root);
    }
    if (existsSync(legacyFileFor(dir))) found.add(dir);
  }
  return [...found].sort();
}

function messageCount(session) {
  return Array.isArray(session?.messages) ? session.messages.length : 0;
}

/**
 * Legacy history lives in two overlapping places: window chat snapshots and
 * per-task snapshots. Same tab id can appear in both, so keep the richer copy.
 */
function collectLegacySessions(legacy, projectId) {
  const byId = new Map();

  const consider = (id, title, messages, updatedAt, createdAt) => {
    if (!id || !Array.isArray(messages) || messages.length === 0) return;
    const candidate = {
      id,
      projectId,
      title: (title || "").trim() || "未命名会话",
      messages,
      createdAt: Number(createdAt) || Number(updatedAt) || 0,
      updatedAt: Number(updatedAt) || Number(createdAt) || 0,
    };
    const existing = byId.get(id);
    if (!existing || messageCount(candidate) > messageCount(existing)) {
      byId.set(id, candidate);
    }
  };

  for (const window of Object.values(legacy.windows ?? {})) {
    for (const tab of window?.chat?.tabs ?? []) {
      const lastTimestamp = [...(tab.messages ?? [])]
        .reverse()
        .find((message) => message?.timestamp)?.timestamp;
      consider(tab.id, tab.title, tab.messages, lastTimestamp ?? window.updatedAt, undefined);
    }
  }

  for (const task of Object.values(legacy.tasks ?? {})) {
    // Each task holds a full chat snapshot; scan every tab in it, not just the
    // task's own, so sessions that only survive inside another task's snapshot
    // are still recovered. Duplicates collapse via the richer-wins rule above.
    for (const tab of task?.chat?.tabs ?? []) {
      const isOwnTab = tab.id === task.chatTabId;
      const lastTimestamp = [...(tab.messages ?? [])]
        .reverse()
        .find((message) => message?.timestamp)?.timestamp;
      consider(
        tab.id,
        isOwnTab ? task.title : tab.title,
        tab.messages,
        lastTimestamp ?? task.updatedAt,
        isOwnTab ? task.createdAt : undefined,
      );
    }
  }

  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const roots = discoverRoots(options);

  if (roots.length === 0) {
    console.error(
      "No legacy partner-sessions.json found. Pass project roots, or --scan <parentDir>.",
    );
    process.exit(1);
  }

  const appStatePath = join(homedir(), ".vera", "partner", "app-state.json");
  if (!existsSync(appStatePath)) {
    console.error(`Target app-state not found: ${appStatePath}`);
    console.error("Launch Partner once so the Host creates it, then re-run.");
    process.exit(1);
  }

  const appState = JSON.parse(readFileSync(appStatePath, "utf8"));
  appState.sessions ??= {};
  appState.projects ??= [];

  let added = 0;
  let enriched = 0;
  let skippedExisting = 0;
  let cappedTotal = 0;

  for (const root of roots) {
    const legacyPath = legacyFileFor(root);
    const legacy = JSON.parse(readFileSync(legacyPath, "utf8"));
    const projectId = projectIdFromRoot(root);

    let sessions = collectLegacySessions(legacy, projectId);
    const capped = Number.isFinite(options.maxPerProject)
      ? sessions.slice(options.maxPerProject)
      : [];
    sessions = Number.isFinite(options.maxPerProject)
      ? sessions.slice(0, options.maxPerProject)
      : sessions;
    cappedTotal += capped.length;

    const hasProject = appState.projects.some(
      (project) => normalizePath(project.rootPath ?? "") === normalizePath(root),
    );
    if (!hasProject && sessions.length > 0) {
      appState.projects.push({
        id: projectId,
        rootPath: normalizePath(root),
        name: projectNameFromRoot(root),
        expanded: false,
        preview: { version: 1, activeTabId: null, tabs: [] },
        updatedAt: Date.now(),
      });
    }

    let rootAdded = 0;
    let rootEnriched = 0;
    let rootSkipped = 0;
    for (const session of sessions) {
      const existing = appState.sessions[session.id];
      if (!existing) {
        appState.sessions[session.id] = session;
        rootAdded += 1;
      } else if (messageCount(session) > messageCount(existing)) {
        // Same policy as persist.rs merge_sessions_preferring_richer.
        appState.sessions[session.id] = { ...existing, ...session };
        rootEnriched += 1;
      } else {
        rootSkipped += 1;
      }
    }

    added += rootAdded;
    enriched += rootEnriched;
    skippedExisting += rootSkipped;

    console.log(
      `${basename(root)}  (${projectId})  +${rootAdded} new  ~${rootEnriched} enriched  =${rootSkipped} already current` +
        (capped.length > 0 ? `  [capped: ${capped.length} older sessions NOT migrated]` : ""),
    );
    for (const session of capped) {
      console.log(`    skipped by cap: ${session.title} (${messageCount(session)} msgs)`);
    }
  }

  console.log(
    `\nTotal: +${added} new, ~${enriched} enriched, =${skippedExisting} already current, ${cappedTotal} capped`,
  );

  if (options.dryRun) {
    console.log("--dry-run: nothing written.");
    return;
  }
  if (added === 0 && enriched === 0) {
    console.log("Nothing to write.");
    return;
  }

  const backupPath = `${appStatePath}.bak-${Date.now()}`;
  copyFileSync(appStatePath, backupPath);
  appState.updatedAt = Date.now();
  writeFileSync(appStatePath, `${JSON.stringify(appState, null, 2)}\n`);

  const sizeMb = (readFileSync(appStatePath).length / 1024 / 1024).toFixed(1);
  console.log(`Backup: ${backupPath}`);
  console.log(`Wrote:  ${appStatePath} (${sizeMb} MB, ${Object.keys(appState.sessions).length} sessions)`);
  console.log("Close Partner before running this, then relaunch to see the history.");
}

main();
