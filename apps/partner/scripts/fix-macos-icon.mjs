import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  console.log(`[fix-macos-icon] skip on ${process.platform}`);
  process.exit(0);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const targetDir = process.env.CARGO_TARGET_DIR ?? join(root, "src-tauri/target");
const appResources = join(
  targetDir,
  "release/bundle/macos/Partner.app/Contents/Resources",
);
const sourceIcon = join(root, "src-tauri/icons/icon.icns");
const destIcon = join(appResources, "icon.icns");

if (!existsSync(sourceIcon)) {
  throw new Error(`missing source icon: ${sourceIcon}`);
}

if (!existsSync(appResources)) {
  throw new Error(`missing macOS app resources directory: ${appResources}`);
}

mkdirSync(appResources, { recursive: true });
copyFileSync(sourceIcon, destIcon);
console.log(`[fix-macos-icon] copied ${sourceIcon} -> ${destIcon}`);
