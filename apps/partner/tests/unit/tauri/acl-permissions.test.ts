import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Tauri v2 rejects any `invoke()` whose command is not allowed by a capability
 * ("<cmd> not allowed. Command not found"). The Workbench Host refactor renamed
 * every IPC entry point, so these three files must stay in lockstep:
 *   lib.rs invoke_handler  ->  permissions/partner-commands.toml  ->  capabilities
 */
function readSrcTauri(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../src-tauri/${relativePath}`, import.meta.url)),
    "utf8",
  );
}

function registeredCommands(): string[] {
  const libRs = readSrcTauri("src/lib.rs");
  const block = /generate_handler!\[([\s\S]*?)\]/.exec(libRs);
  expect(block, "generate_handler! block not found in lib.rs").toBeTruthy();
  return (block![1].match(/([A-Za-z0-9_]+)\s*,/g) ?? [])
    .map((entry) => entry.replace(/[\s,]/g, "").split("::").pop() as string)
    .filter(Boolean);
}

function allowedCommands(): string[] {
  const toml = readSrcTauri("permissions/partner-commands.toml");
  return [...toml.matchAll(/commands\.allow\s*=\s*\[([^\]]*)\]/g)]
    .flatMap((match) => [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]))
    .sort();
}

function permissionIdentifiers(): string[] {
  const toml = readSrcTauri("permissions/partner-commands.toml");
  return [...toml.matchAll(/^identifier\s*=\s*"([^"]+)"/gm)].map((m) => m[1]);
}

function permissionSetMembers(): string[] {
  const toml = readSrcTauri("permissions/partner-commands.toml");
  const set = /\[\[set\]\][\s\S]*?permissions\s*=\s*\[([\s\S]*?)\]/.exec(toml);
  expect(set, "[[set]] block not found in partner-commands.toml").toBeTruthy();
  return [...set![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

describe("tauri ACL stays in sync with registered commands", () => {
  it("registers the Workbench Host entry points", () => {
    expect(registeredCommands().sort()).toEqual(["host_boot", "host_dispatch"]);
  });

  it("allows exactly the registered commands — no stale, no missing", () => {
    expect(allowedCommands()).toEqual(registeredCommands().sort());
  });

  it("includes every declared permission in the partner-commands set", () => {
    const declared = permissionIdentifiers().filter((id) => id.startsWith("allow-"));
    expect(permissionSetMembers().sort()).toEqual(declared.sort());
  });

  it("wires the partner-commands set into the main window capability", () => {
    const capability = JSON.parse(readSrcTauri("capabilities/partner-core.json"));
    expect(capability.permissions).toContain("partner-commands");
  });
});
