#!/usr/bin/env node
// 分析 usage_details CSV，按模型汇总 token 和费用

const fs = require("fs");

const csvPath = process.argv[2] || "/Users/yang.zhou/Desktop/usage_details (1).csv";
const csv = fs.readFileSync(csvPath, "utf-8");

const lines = csv.trim().split("\n");
const rows = [];

for (let i = 1; i < lines.length; i++) {
  const cols = lines[i].split(",");
  if (cols.length < 19) continue;
  rows.push({
    time: cols[0],
    model: cols[2],
    latencyMs: parseInt(cols[3]) || 0,
    inputTokens: parseInt(cols[4]) || 0,
    outputTokens: parseInt(cols[5]) || 0,
    cacheReadTokens: parseInt(cols[6]) || 0,
    cacheCreateTokens: parseInt(cols[7]) || 0,
    totalTokens: parseInt(cols[10]) || 0,
    webSearchCount: parseInt(cols[11]) || 0,
    inputCost: parseFloat(cols[12]) || 0,
    outputCost: parseFloat(cols[13]) || 0,
    cacheCost: parseFloat(cols[14]) || 0,
    otherCost: parseFloat(cols[15]) || 0,
    deductionCost: parseFloat(cols[16]) || 0,
    totalCost: parseFloat(cols[17]) || 0,
    status: cols[18],
  });
}

// ---- 按模型汇总 ----
const byModel = {};
for (const r of rows) {
  if (!byModel[r.model]) {
    byModel[r.model] = {
      count: 0, success: 0, cancel: 0,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0,
      totalTokens: 0, webSearch: 0,
      inputCost: 0, outputCost: 0, cacheCost: 0, otherCost: 0, deductionCost: 0,
      totalCost: 0, latencyMs: 0,
      hitRates: [], // per-call cache hit rate
    };
  }
  const m = byModel[r.model];
  m.count++;
  if (r.status === "成功") m.success++; else if (r.status === "client_cancel") m.cancel++;
  m.inputTokens += r.inputTokens;
  m.outputTokens += r.outputTokens;
  m.cacheReadTokens += r.cacheReadTokens;
  m.cacheCreateTokens += r.cacheCreateTokens;
  m.totalTokens += r.totalTokens;
  m.webSearch += r.webSearchCount;
  m.inputCost += r.inputCost;
  m.outputCost += r.outputCost;
  m.cacheCost += r.cacheCost;
  m.otherCost += r.otherCost;
  m.deductionCost += r.deductionCost;
  m.totalCost += r.totalCost;
  m.latencyMs += r.latencyMs;
  const eff = r.inputTokens + r.cacheReadTokens;
  m.hitRates.push(eff > 0 ? r.cacheReadTokens / eff : 0);
}

function fmt(n) { return n.toLocaleString("en-US"); }
function $(n) { return n.toFixed(4); }
function avg(a, b) { return b > 0 ? Math.round(a / b) : 0; }

const pad = 28, numPad = 14;

function row(label, value) {
  console.log("   " + label.padEnd(pad) + String(value).padStart(numPad));
}

console.log("╔══════════════════════════════════════════════════════════╗");
console.log("║              使用明细汇总分析                            ║");
console.log("╠══════════════════════════════════════════════════════════╣");
console.log(`║  数据范围: ${rows[rows.length - 1]?.time} ~ ${rows[0]?.time}  ║`);
console.log(`║  总记录数: ${rows.length}                                          ║`);
console.log("╚══════════════════════════════════════════════════════════╝");

for (const [model, m] of Object.entries(byModel)) {
  console.log("\n" + "▔".repeat(60));
  console.log("  \x1b[1m" + model + "\x1b[0m  —  " + m.count + " 次调用  (成功 " + m.success + " / 取消 " + m.cancel + ")  |  平均延迟 " + avg(m.latencyMs, m.count) + " ms");

  console.log("\n  ┌ Token 明细" + "".padEnd(44) + "┐");
  row("输入 Tokens",         fmt(m.inputTokens));
  row("输出 Tokens",         fmt(m.outputTokens));
  row("缓存读取 Tokens",      fmt(m.cacheReadTokens));
  row("缓存创建 Tokens",      fmt(m.cacheCreateTokens));
  row("━━━━━━━━━━━━━━━━━━",  "━━━━━━━━━━━━━━");
  row("总 Tokens",           fmt(m.totalTokens));
  row("Web Search 次数",     fmt(m.webSearch));
  const effectiveInput = m.inputTokens + m.cacheReadTokens;
  const hitRate = effectiveInput > 0 ? ((m.cacheReadTokens / effectiveInput) * 100).toFixed(1) : "0.0";
  row("缓存命中率",           hitRate + "%");
  const rates = m.hitRates;
  rates.sort((a,b) => a-b);
  const p50 = rates[Math.floor(rates.length * 0.5)];
  const p90 = rates[Math.floor(rates.length * 0.9)];
  const p99 = rates[Math.floor(rates.length * 0.99)];
  const zeroCount = rates.filter(r => r === 0).length;
  const fullCount = rates.filter(r => r > 0.99).length;
  row("  ─ 命中率分布",        "");
  row("  中位数 (P50)",         (p50 * 100).toFixed(1) + "%");
  row("  P90",                  (p90 * 100).toFixed(1) + "%");
  row("  P99",                  (p99 * 100).toFixed(1) + "%");
  row("  零命中调用数",         zeroCount + " / " + m.count);
  row("  满命中(>99%)调用数",   fullCount + " / " + m.count);
  console.log("  └" + "".padEnd(55) + "┘");

  console.log("\n  ┌ 费用明细" + "".padEnd(44) + "┐");
  row("输入费用",             "$" + $(m.inputCost));
  row("输出费用",             "$" + $(m.outputCost));
  row("缓存费用",             "$" + $(m.cacheCost));
  row("其他费用",             "$" + $(m.otherCost));
  row("补扣金额",             "$" + $(m.deductionCost));
  console.log("  │" + "".padEnd(55) + "│");
  row("总费用",               "$" + $(m.totalCost));
  console.log("  └" + "".padEnd(55) + "┘");
}

// ---- 总计 ----
const grand = { count: 0, success: 0, cancel: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, totalTokens: 0, webSearch: 0, inputCost: 0, outputCost: 0, cacheCost: 0, otherCost: 0, deductionCost: 0, totalCost: 0, latencyMs: 0 };
for (const m of Object.values(byModel)) {
  for (const k of Object.keys(grand)) grand[k] += m[k];
}

console.log("\n" + "▀".repeat(60));
console.log("  \x1b[1m全部模型合计\x1b[0m  —  " + grand.count + " 次调用  (成功 " + grand.success + " / 取消 " + grand.cancel + ")");

console.log("\n  ┌ Token 明细" + "".padEnd(44) + "┐");
row("输入 Tokens",         fmt(grand.inputTokens));
row("输出 Tokens",         fmt(grand.outputTokens));
row("缓存读取 Tokens",      fmt(grand.cacheReadTokens));
row("缓存创建 Tokens",      fmt(grand.cacheCreateTokens));
row("━━━━━━━━━━━━━━━━━━",  "━━━━━━━━━━━━━━");
row("总 Tokens",           fmt(grand.totalTokens));
row("Web Search 次数",     fmt(grand.webSearch));
const gEffectiveInput = grand.inputTokens + grand.cacheReadTokens;
const gHitRate = gEffectiveInput > 0 ? ((grand.cacheReadTokens / gEffectiveInput) * 100).toFixed(1) : "0.0";
row("缓存命中率",           gHitRate + "%");
console.log("  └" + "".padEnd(55) + "┘");

console.log("\n  ┌ 费用明细" + "".padEnd(44) + "┐");
row("输入费用",             "$" + $(grand.inputCost));
row("输出费用",             "$" + $(grand.outputCost));
row("缓存费用",             "$" + $(grand.cacheCost));
row("其他费用",             "$" + $(grand.otherCost));
row("补扣金额",             "$" + $(grand.deductionCost));
console.log("  │" + "".padEnd(55) + "│");
row("总费用",               "$" + $(grand.totalCost));
console.log("  └" + "".padEnd(55) + "┘");

// 占比
console.log("\n" + "═".repeat(60));
console.log("\n  费用占比");
for (const [model, m] of Object.entries(byModel)) {
  const pct = grand.totalCost > 0 ? ((m.totalCost / grand.totalCost) * 100).toFixed(1) : "0.0";
  const bar = "█".repeat(Math.max(1, Math.round((m.totalCost / (grand.totalCost || 1)) * 30)));
  console.log("  " + model.padEnd(32) + " $" + $(m.totalCost).padStart(8) + "  " + pct.padStart(5) + "%  " + bar);
}

console.log("\n  Token 占比");
for (const [model, m] of Object.entries(byModel)) {
  const pct = grand.totalTokens > 0 ? ((m.totalTokens / grand.totalTokens) * 100).toFixed(1) : "0.0";
  const bar = "█".repeat(Math.max(1, Math.round((m.totalTokens / (grand.totalTokens || 1)) * 30)));
  console.log("  " + model.padEnd(32) + " " + fmt(m.totalTokens).padStart(10) + "  " + pct.padStart(5) + "%  " + bar);
}

console.log();
