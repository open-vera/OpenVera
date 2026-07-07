import { chmodSync, copyFileSync, cpSync, mkdirSync, rmSync, statSync } from "node:fs";
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
const wsDir = dirname(sidecarRequire.resolve("ws/package.json"));
const wsDest = join(destDir, "node_modules", "ws");
rmSync(wsDest, { recursive: true, force: true });
mkdirSync(dirname(wsDest), { recursive: true });
cpSync(wsDir, wsDest, { recursive: true });
console.log(`[stage-sidecar] copied ${wsDir} -> ${wsDest}`);

const nodeSource = process.env.PARTNER_NODE_SOURCE ?? process.execPath;
const nodeDest = join(destDir, "node");
copyFileSync(nodeSource, nodeDest);
chmodSync(nodeDest, 0o755);
const nodeSizeMb = (statSync(nodeDest).size / (1024 * 1024)).toFixed(1);
console.log(`[stage-sidecar] copied node ${nodeSource} -> ${nodeDest} (${nodeSizeMb} MB)`);

cpSync(icon, iconDest);
console.log(`[stage-sidecar] copied ${icon} -> ${iconDest}`);
