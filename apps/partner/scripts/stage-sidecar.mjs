import {
  chmodSync,
  copyFileSync,
  cpSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sidecarRoot = join(root, "sidecar");
const bundle = join(sidecarRoot, "dist/partner-sidecar.mjs");
const destDir = join(root, "src-tauri/resources/sidecar");
const destFile = join(destDir, "partner-sidecar.mjs");
const icon = join(root, "src-tauri/icons/icon.icns");
const iconDest = join(root, "src-tauri/resources/icon.icns");

mkdirSync(destDir, { recursive: true });
cpSync(bundle, destFile);
console.log(`[stage-sidecar] copied ${bundle} -> ${destFile}`);

const sidecarRequire = createRequire(join(sidecarRoot, "package.json"));

function stageNpmPackage(name) {
  const sourceDir = dirname(sidecarRequire.resolve(`${name}/package.json`));
  const dest = join(destDir, "node_modules", name);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(sourceDir, dest, { recursive: true });
  console.log(`[stage-sidecar] copied ${sourceDir} -> ${dest}`);
}

stageNpmPackage("ws");
// Bundled TS/JS language server so Partner does not require a global install.
stageNpmPackage("typescript-language-server");

const bundleNode = process.env.PARTNER_BUNDLE_NODE !== "0";
const nodeBinaryName = process.platform === "win32" ? "node.exe" : "node";
const nodeDest = join(destDir, nodeBinaryName);
// Clear both names so switching variants never leaves a stale binary behind.
rmSync(join(destDir, "node"), { force: true });
rmSync(join(destDir, "node.exe"), { force: true });

if (bundleNode) {
  const nodeSource = process.env.PARTNER_NODE_SOURCE ?? process.execPath;
  copyFileSync(nodeSource, nodeDest);
  if (process.platform !== "win32") {
    chmodSync(nodeDest, 0o755);
  }
  const nodeSizeMb = (statSync(nodeDest).size / (1024 * 1024)).toFixed(1);
  console.log(`[stage-sidecar] copied node ${nodeSource} -> ${nodeDest} (${nodeSizeMb} MB)`);
} else {
  console.log("[stage-sidecar] skipped bundled node (system-node variant)");
}

writeFileSync(
  join(destDir, "runtime.json"),
  `${JSON.stringify({ nodeMode: bundleNode ? "bundled" : "system" }, null, 2)}\n`,
);
console.log(`[stage-sidecar] wrote runtime.json (nodeMode=${bundleNode ? "bundled" : "system"})`);

cpSync(icon, iconDest);
console.log(`[stage-sidecar] copied ${icon} -> ${iconDest}`);
