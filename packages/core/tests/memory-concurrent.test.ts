/**
 * D1: Memory Store 并发写入测试
 *
 * 验证多个 async 写入不丢失数据：
 * - 大量并发 async writer 交错写入 episodic/semantic
 * - microtask 级别的并发交错
 * - 同一 key 的 semantic 去重在并发场景下一致性
 * - 多实例写入同一目录（模拟进程重启场景）
 * - 写入和读取交错不导致数据丢失
 * - 高频 rapid-fire 写入的压力测试
 */

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../src/memory/store.js";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `memory-concurrent-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("D1: Memory Store 并发写入测试", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // ─── Microtask 级并发 ────────────────────────────────────────────────

  describe("Microtask 并发写入", () => {
    it("50 个 async task 交错写入 episodic 不丢失数据", async () => {
      const store = new MemoryStore({ storeDir: dir });
      const count = 50;

      // 使用 microtask (queueMicrotask / Promise.resolve) 实现交错
      const writers = Array.from({ length: count }, (_, i) =>
        new Promise<void>((resolve) => {
          // 每个 writer 通过 microtask 交错执行
          queueMicrotask(() => {
            store.addEpisodic(
              `Microtask-${i}`,
              `Result-${i}`,
              [`Lesson-${i}`],
              [`tag-${i}`],
              undefined,
              0.1 + (i / count) * 0.9
            );
            resolve();
          });
        })
      );

      await Promise.all(writers);

      // 验证所有数据都在内存中
      const entries = store.getEpisodic();
      expect(entries).toHaveLength(count);

      // 验证 reload 后数据完整
      const store2 = new MemoryStore({ storeDir: dir });
      const reloaded = store2.getEpisodic();
      expect(reloaded).toHaveLength(count);

      // 验证每条数据都可找到
      for (let i = 0; i < count; i++) {
        expect(reloaded.find((e) => e.taskSummary === `Microtask-${i}`)).toBeDefined();
      }
    });

    it("100 个 microtask 交错写入 semantic 不丢失数据", async () => {
      const store = new MemoryStore({ storeDir: dir });
      const count = 100;

      const writers = Array.from({ length: count }, (_, i) =>
        new Promise<void>((resolve) => {
          queueMicrotask(() => {
            store.addSemantic(`key-${i}`, `value-${i}`, [`tag-${i % 10}`]);
            resolve();
          });
        })
      );

      await Promise.all(writers);

      const entries = store.getSemantic();
      expect(entries).toHaveLength(count);

      // Reload 验证
      const store2 = new MemoryStore({ storeDir: dir });
      const reloaded = store2.getSemantic();
      expect(reloaded).toHaveLength(count);
    });
  });

  // ─── 交错写入模式 ──────────────────────────────────────────────────

  describe("交错写入模式", () => {
    it("episodic 和 semantic 交替 rapid-fire 写入", async () => {
      const store = new MemoryStore({ storeDir: dir });
      const iterations = 40;
      let epiCount = 0;
      let semCount = 0;

      // 交错：每个 async task 先写 episodic，再写 semantic
      const tasks = Array.from({ length: iterations }, (_, i) =>
        new Promise<void>((resolve) => {
          queueMicrotask(() => {
            store.addEpisodic(`Epi-${i}`, `Done-${i}`, []);
            epiCount++;
            // 在 microtask 中继续写 semantic
            queueMicrotask(() => {
              store.addSemantic(`sem-${i}`, `fact-${i}`, []);
              semCount++;
              resolve();
            });
          });
        })
      );

      await Promise.all(tasks);

      expect(epiCount).toBe(iterations);
      expect(semCount).toBe(iterations);

      // Reload 验证
      const store2 = new MemoryStore({ storeDir: dir });
      expect(store2.getEpisodic()).toHaveLength(iterations);
      expect(store2.getSemantic()).toHaveLength(iterations);
    });

    it("快速 semantic 更新 + 新 episodic 写入交错不互相干扰", async () => {
      const store = new MemoryStore({ storeDir: dir });

      // 先写入初始 semantic
      store.addSemantic("counter", "0", ["mutable"]);
      store.addSemantic("config", "default", ["system"]);

      // 交错：一组更新 semantic counter，另一组写新 episodic
      const tasks: Promise<void>[] = [];

      // 20 个 semantic 更新
      for (let i = 1; i <= 20; i++) {
        tasks.push(
          new Promise<void>((resolve) => {
            queueMicrotask(() => {
              store.addSemantic("counter", `${i}`, ["mutable"]);
              resolve();
            });
          })
        );
      }

      // 30 个新 episodic
      for (let i = 0; i < 30; i++) {
        tasks.push(
          new Promise<void>((resolve) => {
            queueMicrotask(() => {
              store.addEpisodic(`Concurrent-task-${i}`, `Done`, [`Lesson-${i}`]);
              resolve();
            });
          })
        );
      }

      await Promise.all(tasks);

      // semantic: counter (updated) + config (original) = 2 entries
      const semantic = store.getSemantic();
      expect(semantic).toHaveLength(2);
      const counter = semantic.find((e) => e.key === "counter");
      expect(counter).toBeDefined();
      // 最后一个更新的值应该是 20
      expect(counter!.value).toBe("20");

      // episodic: 30 entries
      expect(store.getEpisodic()).toHaveLength(30);

      // Reload 验证
      const store2 = new MemoryStore({ storeDir: dir });
      expect(store2.getSemantic()).toHaveLength(2);
      expect(store2.getEpisodic()).toHaveLength(30);
    });
  });

  // ─── 多实例并发（模拟进程重启）───────────────────────────────────

  describe("多实例写入同一目录", () => {
    it("两个 store 实例交替写入后 reload 数据完整", () => {
      const store1 = new MemoryStore({ storeDir: dir });
      const store2 = new MemoryStore({ storeDir: dir });

      // 交替写入 episodic
      for (let i = 0; i < 20; i++) {
        if (i % 2 === 0) {
          store1.addEpisodic(`S1-Task-${i}`, `S1-Done-${i}`, []);
        } else {
          store2.addEpisodic(`S2-Task-${i}`, `S2-Done-${i}`, []);
        }
      }

      // 创建第三个实例验证
      const store3 = new MemoryStore({ storeDir: dir });
      const entries = store3.getEpisodic();

      // 由于两个实例各自维护内存数组，各自 append 到文件
      // reload 时会读到所有 append 过的数据
      expect(entries.length).toBeGreaterThanOrEqual(20);

      // 验证所有数据都可找到
      for (let i = 0; i < 20; i++) {
        const prefix = i % 2 === 0 ? "S1" : "S2";
        expect(entries.find((e) => e.taskSummary === `${prefix}-Task-${i}`)).toBeDefined();
      }
    });

    it("先写后 reload 再追加，数据累计不丢失", () => {
      const count = 15;

      // 第一个 store 写入
      const store1 = new MemoryStore({ storeDir: dir });
      for (let i = 0; i < count; i++) {
        store1.addEpisodic(`Batch1-${i}`, `Done-${i}`, []);
      }

      // Reload 后追加
      const store2 = new MemoryStore({ storeDir: dir });
      for (let i = 0; i < count; i++) {
        store2.addEpisodic(`Batch2-${i}`, `Done-${i}`, []);
      }

      // 最终 reload
      const store3 = new MemoryStore({ storeDir: dir });
      const entries = store3.getEpisodic();
      expect(entries).toHaveLength(count * 2);

      // 验证两批数据都存在
      for (let i = 0; i < count; i++) {
        expect(entries.find((e) => e.taskSummary === `Batch1-${i}`)).toBeDefined();
        expect(entries.find((e) => e.taskSummary === `Batch2-${i}`)).toBeDefined();
      }
    });
  });

  // ─── 读写交错 ─────────────────────────────────────────────────────

  describe("读写交错", () => {
    it("写入过程中 search 不崩溃、不丢失已写入数据", () => {
      const store = new MemoryStore({ storeDir: dir });
      const results: number[] = [];

      // 写入初始数据
      for (let i = 0; i < 10; i++) {
        store.addEpisodic(`Search-task-${i}`, `Done ${i}`, [`lesson-${i}`], ["searchable"]);
      }

      // 交错写入和搜索
      for (let i = 10; i < 30; i++) {
        store.addEpisodic(`Search-task-${i}`, `Done ${i}`, [`lesson-${i}`], ["searchable"]);
        // 在每次写入后搜索
        const searchResults = store.search("Search-task searchable", { limit: 50 });
        results.push(searchResults.length);
      }

      // 搜索结果应随写入增加（非严格递增，但应该存在）
      const lastResult = results[results.length - 1]!;
      expect(lastResult).toBeGreaterThan(0);

      // 最终验证所有数据存在
      expect(store.getEpisodic()).toHaveLength(30);
    });

    it("写入过程中 stats 始终准确", () => {
      const store = new MemoryStore({ storeDir: dir });

      for (let i = 0; i < 25; i++) {
        store.addEpisodic(`Stats-epi-${i}`, `Done`, []);
        if (i % 3 === 0) {
          store.addSemantic(`stats-sem-${i}`, `Value`, []);
        }

        const s = store.stats();
        expect(s.episodic).toBe(i + 1);
        expect(s.semantic).toBe(Math.floor(i / 3) + 1);
        expect(s.total).toBe(s.episodic + s.semantic + s.working);
      }
    });
  });

  // ─── 高频压力测试 ─────────────────────────────────────────────────

  describe("高频压力测试", () => {
    it("200 个 rapid-fire 写入 + reload 数据完整", async () => {
      const store = new MemoryStore({ storeDir: dir });
      const count = 200;

      // 所有写入都在同一轮 microtask 中
      const writers = Array.from({ length: count }, (_, i) =>
        new Promise<void>((resolve) => {
          queueMicrotask(() => {
            if (i % 2 === 0) {
              store.addEpisodic(`Stress-epi-${i}`, `Outcome-${i}`, [], [], undefined, Math.random());
            } else {
              store.addSemantic(`stress-sem-${i}`, `Value-${i}`, []);
            }
            resolve();
          });
        })
      );

      await Promise.all(writers);

      const epiCount = Math.ceil(count / 2); // 0,2,4,...,198 = 100
      const semCount = Math.floor(count / 2); // 1,3,5,...,199 = 100

      expect(store.getEpisodic()).toHaveLength(epiCount);
      expect(store.getSemantic()).toHaveLength(semCount);

      // Reload 验证
      const store2 = new MemoryStore({ storeDir: dir });
      expect(store2.getEpisodic()).toHaveLength(epiCount);
      expect(store2.getSemantic()).toHaveLength(semCount);
    });

    it("500 个顺序写入 + reload + search 端到端", () => {
      const store = new MemoryStore({ storeDir: dir });
      const count = 500;

      for (let i = 0; i < count; i++) {
        const content = `bulk-item-${i} ${i % 10 === 0 ? "special" : "normal"}`;
        store.addEpisodic(`Bulk-${i}`, content, [`lesson-${i % 5}`], [`group-${i % 10}`], undefined, i / count);
      }

      expect(store.getEpisodic()).toHaveLength(count);

      // Reload
      const store2 = new MemoryStore({ storeDir: dir });
      expect(store2.getEpisodic()).toHaveLength(count);

      // Search 验证
      const specialResults = store2.search("special", { limit: 100 });
      expect(specialResults.length).toBeGreaterThan(0);
      // 每 10 个中有 1 个 "special"，所以应该有约 50 个
      expect(specialResults.length).toBeGreaterThanOrEqual(10);

      // 索引健康
      expect(store2.stats().total).toBe(count);
    });
  });
});
