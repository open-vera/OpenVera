import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const variant = process.argv[2];
if (variant !== "bundled" && variant !== "system") {
  throw new Error("usage: node scripts/post-build-release.mjs <bundled|system>");
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const targetDir = process.env.CARGO_TARGET_DIR ?? join(root, "src-tauri/target");
const platform = process.platform;

function newestMatching(dir, test) {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((path) => test(path));
  if (!files.length) return null;
  return files
    .map((path) => ({ path, mtime: statSync(path).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0].path;
}

if (platform === "darwin") {
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
} else if (platform === "win32") {
  const nsisDir = join(targetDir, "release/bundle/nsis");
  const sourceExe = newestMatching(nsisDir, (path) => path.toLowerCase().endsWith(".exe"));
  if (!sourceExe) {
    throw new Error(`missing Windows NSIS installer under ${nsisDir}`);
  }

  const releaseDir = join(root, "release/windows");
  const destName =
    variant === "bundled"
      ? "Partner-windows-bundled-setup.exe"
      : "Partner-windows-system-node-setup.exe";
  const destExe = join(releaseDir, destName);

  mkdirSync(releaseDir, { recursive: true });
  rmSync(destExe, { force: true });
  copyFileSync(sourceExe, destExe);
  console.log(`[post-build-release] copied ${sourceExe} -> ${destExe}`);
} else {
  throw new Error(
    `[post-build-release] unsupported platform ${platform}; expected darwin or win32`,
  );
}
