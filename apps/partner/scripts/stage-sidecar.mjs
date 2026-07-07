import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = join(root, "sidecar/dist/partner-sidecar.mjs");
const destDir = join(root, "src-tauri/resources/sidecar");
const destFile = join(destDir, "partner-sidecar.mjs");
const icon = join(root, "src-tauri/icons/icon.icns");
const iconDest = join(root, "src-tauri/resources/icon.icns");

mkdirSync(destDir, { recursive: true });
cpSync(bundle, destFile);
console.log(`[stage-sidecar] copied ${bundle} -> ${destFile}`);
cpSync(icon, iconDest);
console.log(`[stage-sidecar] copied ${icon} -> ${iconDest}`);
