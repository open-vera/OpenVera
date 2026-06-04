import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe("CLI Flags", () => {
  const cliPath = "src/cli/index.ts";
  const pkgPath = "../package.json";
  
  it("should show version with -v", () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, pkgPath), "utf-8"));
    const output = execSync(`npx tsx ${cliPath} -v`, { 
      cwd: join(__dirname, ".."),
      env: { ...process.env, NODE_OPTIONS: "--no-warnings" }
    }).toString().trim();
    expect(output).toBe(pkg.version);
  });

  it("should show version with --version", () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, pkgPath), "utf-8"));
    const output = execSync(`npx tsx ${cliPath} --version`, { 
      cwd: join(__dirname, ".."),
      env: { ...process.env, NODE_OPTIONS: "--no-warnings" }
    }).toString().trim();
    expect(output).toBe(pkg.version);
  });

  it("should show help with -h", () => {
    const output = execSync(`npx tsx ${cliPath} -h`, { 
      cwd: join(__dirname, ".."),
      env: { ...process.env, NODE_OPTIONS: "--no-warnings" }
    }).toString();
    expect(output).toContain("Usage: openvera|vera|ai");
    expect(output).toContain("init");
    expect(output).toContain("sync");
    expect(output).toContain("run <flow>");
    expect(output).toContain(".vera/flows");
    expect(output).not.toContain("flow run");
    expect(output).not.toContain("--flow");
    expect(output).toContain("--force");
    expect(output).toContain("-v, --version");
  });

  it("should register openvera, vera, and ai as equivalent bin commands", () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, pkgPath), "utf-8"));
    expect(pkg.bin).toEqual({
      openvera: "./dist/cli/index.js",
      vera: "./dist/cli/index.js",
      ai: "./dist/cli/index.js",
    });
  });
});
