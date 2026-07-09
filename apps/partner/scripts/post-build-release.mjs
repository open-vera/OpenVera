import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const variant = process.argv[2];
if (variant !== "bundled" && variant !== "system") {
  throw new Error("usage: node scripts/post-build-release.mjs <bundled|system>");
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const targetDir = process.env.CARGO_TARGET_DIR ?? join(root, "src-tauri/target");
const sourceApp = join(targetDir, "release/bundle/macos/Partner.app");
const releaseDir = join(root, "release/macos");
const appName = variant === "bundled" ? "Partner.app" : "Partner-SystemNode.app";
const destApp = join(releaseDir, appName);

if (!existsSync(sourceApp)) {
  throw new Error(`missing build output: ${sourceApp}`);
}

mkdirSync(releaseDir, { recursive: true });
rmSync(destApp, { recursive: true, force: true });
cpSync(sourceApp, destApp, { recursive: true });
console.log(`[post-build-release] copied ${sourceApp} -> ${destApp}`);
