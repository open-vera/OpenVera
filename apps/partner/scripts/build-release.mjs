import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const variant = process.argv[2];
if (variant !== "bundled" && variant !== "system") {
  console.error("usage: node scripts/build-release.mjs <bundled|system>");
  process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const isWin = process.platform === "win32";
const isMac = process.platform === "darwin";
const bundleNode = variant === "bundled" ? "1" : "0";

const env = {
  ...process.env,
  PARTNER_BUNDLE_NODE: bundleNode,
};

function run(command, args, options = {}) {
  console.log(`[build-release] ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    stdio: "inherit",
    shell: isWin,
    ...options,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const pnpm = isWin ? "pnpm.cmd" : "pnpm";

run(pnpm, ["run", "build:sidecar"]);

// Platform-native installers. macOS `.app`; Windows NSIS setup exe.
const bundles = isMac ? ["app"] : isWin ? ["nsis"] : ["deb"];
run(pnpm, ["exec", "tauri", "build", "--bundles", bundles.join(",")]);

if (isMac) {
  run(process.execPath, ["scripts/fix-macos-icon.mjs"]);
}

run(process.execPath, ["scripts/post-build-release.mjs", variant]);
console.log(`[build-release] ${variant} build complete`);
