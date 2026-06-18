/**
 * 按拓扑序构建所有 harness 插件包
 *
 * Phase 1: core 基础库
 * Phase 2: 无交叉依赖的叶子插件包
 * Phase 3: 有内部依赖的插件包 (benchmark->eval, proposal->dreaming, training->skill)
 * Phase 4: 核心 harness 包
 */
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const base = join(__dirname, "..", "packages");

const phases = [
  ["core"],
  [
    "harness-eval",
    "harness-skill",
    "harness-dreaming",
    "harness-swarm",
    "harness-strategy",
    "harness-tracking",
  ],
  ["harness-benchmark", "harness-proposal", "harness-training"],
  ["harness"],
];

let totalStart = Date.now();
for (const phase of phases) {
  const phaseStart = Date.now();
  console.log(`\n=== Phase: ${phase.join(", ")} ===`);
  for (const pkg of phase) {
    const pkgPath = join(base, pkg);
    const t0 = Date.now();
    try {
      execSync("npx tsc", { cwd: pkgPath, stdio: "pipe" });
      const ms = Date.now() - t0;
      console.log(`  [OK] ${pkg} (${ms}ms)`);
    } catch (err) {
      console.error(`  [FAIL] ${pkg}`);
      console.error(err.stdout?.toString() || err.stderr?.toString() || err.message);
      process.exit(1);
    }
  }
  const phaseMs = Date.now() - phaseStart;
  console.log(`  Phase done (${phaseMs}ms)`);
}

const totalMs = Date.now() - totalStart;
console.log(`\nAll packages built successfully (${totalMs}ms)`);
