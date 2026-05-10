/**
 * A4: Memory Store 持久化验证
 *
 * 验证 Episodic/Semantic JSONL 文件读写在并发场景下的安全性：
 * - 并发写入不丢失数据
 * - 损坏的 JSONL 行被优雅跳过
 * - 空文件/缺失文件被正确处理
 * - 原子写入保护崩溃场景
 */

import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../src/memory/store.js";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `memory-persist-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("A4: Memory Store 持久化验证", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // ─── 并发写入安全性 ────────────────────────────────────────────────────

  describe("并发写入安全性", () => {
    it("多个顺序 addEpisodic 调用不丢失数据", () => {
      const store = new MemoryStore({ storeDir: dir });
      const count = 50;

      for (let i = 0; i < count; i++) {
        store.addEpisodic(`Task ${i}`, `Outcome ${i}`, [`Lesson ${i}`], [`tag-${i}`]);
      }

      // 重新加载验证
      const store2 = new MemoryStore({ storeDir: dir });
      const entries = store2.getEpisodic();
      expect(entries).toHaveLength(count);

      // 验证每条数据都完整
      for (let i = 0; i < count; i++) {
        const found = entries.find((e) => e.taskSummary === `Task ${i}`);
        expect(found).toBeDefined();
        expect(found!.outcome).toBe(`Outcome ${i}`);
      }
    });

    it("多个顺序 addSemantic 调用不丢失数据", () => {
      const store = new MemoryStore({ storeDir: dir });
      const count = 50;

      for (let i = 0; i < count; i++) {
        store.addSemantic(`key-${i}`, `value-${i}`, [`tag-${i}`]);
      }

      // 重新加载验证
      const store2 = new MemoryStore({ storeDir: dir });
      const entries = store2.getSemantic();
      expect(entries).toHaveLength(count);

      for (let i = 0; i < count; i++) {
        const found = entries.find((e) => e.key === `key-${i}`);
        expect(found).toBeDefined();
        expect(found!.value).toBe(`value-${i}`);
      }
    });

    it("交替写入 episodic 和 semantic 不互相干扰", () => {
      const store = new MemoryStore({ storeDir: dir });
      const count = 30;

      for (let i = 0; i < count; i++) {
        store.addEpisodic(`Epi-${i}`, `Done ${i}`, [`Lesson ${i}`]);
        store.addSemantic(`Sem-${i}`, `Fact ${i}`, [`tag-${i}`]);
      }

      const store2 = new MemoryStore({ storeDir: dir });
      expect(store2.getEpisodic()).toHaveLength(count);
      expect(store2.getSemantic()).toHaveLength(count);
    });

    it("async 并发写入不丢失数据", async () => {
      const store = new MemoryStore({ storeDir: dir });
      const count = 20;

      // 模拟 async 并发场景：快速顺序调用
      const promises: Promise<void>[] = [];
      for (let i = 0; i < count; i++) {
        promises.push(
          new Promise<void>((resolve) => {
            // 使用 setTimeout 交错写入
            setTimeout(() => {
              store.addEpisodic(`Async-${i}`, `Outcome-${i}`, [`Lesson-${i}`]);
              resolve();
            }, Math.random() * 10);
          })
        );
      }

      await Promise.all(promises);

      // 验证所有数据都保存了
      const store2 = new MemoryStore({ storeDir: dir });
      const entries = store2.getEpisodic();
      expect(entries).toHaveLength(count);
    });

    it("并发 addSemantic 去重 key 在 reload 后仍然正确", () => {
      const store = new MemoryStore({ storeDir: dir });

      // 多次更新同一个 key
      for (let i = 0; i < 20; i++) {
        store.addSemantic("counter", `version-${i}`, ["updated"]);
      }

      // 重新加载 — 应该只有最后一条 persistAll 的结果
      const store2 = new MemoryStore({ storeDir: dir });
      const entries = store2.getSemantic();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.value).toBe("version-19");
    });
  });

  // ─── 损坏数据处理 ──────────────────────────────────────────────────────

  describe("损坏 JSONL 处理", () => {
    it("跳过损坏的 JSONL 行（无效 JSON）", () => {
      const validEntry = JSON.stringify({
        id: "mem-valid-1",
        tier: "episodic",
        content: "Valid entry",
        tags: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        importance: 0.5,
        taskSummary: "Valid task",
        outcome: "Success",
        lessons: [],
      });

      // 写入包含损坏行的文件
      const corruptedContent = [validEntry, "{invalid json!!!", validEntry].join("\n") + "\n";
      writeFileSync(join(dir, "episodic.jsonl"), corruptedContent);

      const store = new MemoryStore({ storeDir: dir });
      const entries = store.getEpisodic();

      // 应该跳过损坏行，加载 2 条有效记录
      expect(entries).toHaveLength(2);
    });

    it("跳过缺失必要字段的 JSONL 行", () => {
      const validEntry = JSON.stringify({
        id: "mem-valid-2",
        tier: "episodic",
        content: "Valid entry",
        tags: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        importance: 0.5,
        taskSummary: "Valid task",
        outcome: "Success",
        lessons: [],
      });

      const incompleteEntry = JSON.stringify({
        id: "mem-incomplete",
        // Missing tier, content, tags, etc.
        createdAt: new Date().toISOString(),
      });

      const content = [validEntry, incompleteEntry, validEntry].join("\n") + "\n";
      writeFileSync(join(dir, "episodic.jsonl"), content);

      const store = new MemoryStore({ storeDir: dir });
      expect(store.getEpisodic()).toHaveLength(2);
    });

    it("跳过 tier 不合法的 JSONL 行", () => {
      const validEntry = JSON.stringify({
        id: "mem-valid-3",
        tier: "episodic",
        content: "Valid",
        tags: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        importance: 0.5,
        taskSummary: "Task",
        outcome: "Done",
        lessons: [],
      });

      const badTierEntry = JSON.stringify({
        id: "mem-bad-tier",
        tier: "invalid-tier",
        content: "Bad tier",
        tags: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        importance: 0.5,
      });

      const content = [validEntry, badTierEntry].join("\n") + "\n";
      writeFileSync(join(dir, "episodic.jsonl"), content);

      const store = new MemoryStore({ storeDir: dir });
      expect(store.getEpisodic()).toHaveLength(1);
    });

    it("处理完全损坏的文件（非 JSON 内容）", () => {
      writeFileSync(join(dir, "episodic.jsonl"), "this is not json at all\nneither is this\n");

      const store = new MemoryStore({ storeDir: dir });
      expect(store.getEpisodic()).toHaveLength(0);
    });

    it("处理包含二进制数据的损坏文件", () => {
      writeFileSync(join(dir, "semantic.jsonl"), Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]));

      const store = new MemoryStore({ storeDir: dir });
      expect(store.getSemantic()).toHaveLength(0);
    });
  });

  // ─── 边界情况 ─────────────────────────────────────────────────────────

  describe("边界情况", () => {
    it("空 JSONL 文件被正确处理", () => {
      writeFileSync(join(dir, "episodic.jsonl"), "");
      writeFileSync(join(dir, "semantic.jsonl"), "");

      const store = new MemoryStore({ storeDir: dir });
      expect(store.getEpisodic()).toHaveLength(0);
      expect(store.getSemantic()).toHaveLength(0);
    });

    it("只有空白字符的 JSONL 文件被正确处理", () => {
      writeFileSync(join(dir, "episodic.jsonl"), "   \n  \n\t\n  ");

      const store = new MemoryStore({ storeDir: dir });
      expect(store.getEpisodic()).toHaveLength(0);
    });

    it("JSONL 文件不存在时返回空数组", () => {
      // 不创建任何文件
      const store = new MemoryStore({ storeDir: dir });
      expect(store.getEpisodic()).toHaveLength(0);
      expect(store.getSemantic()).toHaveLength(0);
    });

    it("storeDir 不存在时自动创建", () => {
      const nestedDir = join(dir, "nested", "deep", "path");
      const store = new MemoryStore({ storeDir: nestedDir });
      store.addEpisodic("Test", "Done", []);

      expect(existsSync(join(nestedDir, "episodic.jsonl"))).toBe(true);
    });

    it("写入后再追加，新旧数据都在", () => {
      const store1 = new MemoryStore({ storeDir: dir });
      store1.addEpisodic("First task", "Done", ["Lesson 1"]);

      // 创建新 store 实例 — 它会 append 到已有文件
      const store2 = new MemoryStore({ storeDir: dir });
      store2.addEpisodic("Second task", "Done", ["Lesson 2"]);

      // 第三个实例验证完整数据
      const store3 = new MemoryStore({ storeDir: dir });
      const entries = store3.getEpisodic();
      expect(entries).toHaveLength(2);
    });

    it("addSemantic update 通过 persistAll 保持一致性", () => {
      const store1 = new MemoryStore({ storeDir: dir });
      store1.addSemantic("config", "v1", ["meta"]);
      store1.addSemantic("other", "fact", ["meta"]);

      const store2 = new MemoryStore({ storeDir: dir });
      // 这会触发 persistAll（去重更新）
      store2.addSemantic("config", "v2", ["meta", "updated"]);

      // 验证文件状态一致
      const store3 = new MemoryStore({ storeDir: dir });
      const entries = store3.getSemantic();
      expect(entries).toHaveLength(2);
      const configEntry = entries.find((e) => e.key === "config");
      expect(configEntry!.value).toBe("v2");
    });

    it("removeSemantic 后 persistAll 保持一致", () => {
      const store1 = new MemoryStore({ storeDir: dir });
      store1.addSemantic("keep", "yes", []);
      store1.addSemantic("remove", "no", []);

      const store2 = new MemoryStore({ storeDir: dir });
      store2.removeSemantic("remove");

      const store3 = new MemoryStore({ storeDir: dir });
      expect(store3.getSemantic()).toHaveLength(1);
      expect(store3.getSemantic()[0]!.key).toBe("keep");
    });

    it("无 storeDir 时 persistEntry 不写入任何文件", () => {
      const store = new MemoryStore(); // No storeDir
      store.addEpisodic("No persist", "Test", []);
      store.addSemantic("no-persist", "test", []);

      // 文件不应该存在（在默认目录）
      // 这只是验证不会抛错
      expect(store.getEpisodic()).toHaveLength(1);
      expect(store.getSemantic()).toHaveLength(1);
    });
  });

  // ─── 原子写入（crash safety）─────────────────────────────────────────

  describe("原子写入 crash safety", () => {
    it("persistAll 使用 atomic write（先写 tmp 再 rename）", () => {
      const store = new MemoryStore({ storeDir: dir });
      store.addEpisodic("Atomic test", "Success", []);

      // 验证没有残留 .tmp 文件
      const episodicPath = join(dir, "episodic.jsonl");
      const tmpPath = episodicPath + ".tmp";
      expect(existsSync(episodicPath)).toBe(true);
      expect(existsSync(tmpPath)).toBe(false);
    });

    it("遗留 .tmp 文件被 loadFromDisk 清理", () => {
      // 模拟崩溃：写入主文件和残留的 .tmp
      const entry = JSON.stringify({
        id: "mem-survived",
        tier: "episodic",
        content: "Survived crash",
        tags: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        importance: 0.5,
        taskSummary: "Crash task",
        outcome: "Recovered",
        lessons: [],
      });

      writeFileSync(join(dir, "episodic.jsonl"), entry + "\n");
      writeFileSync(join(dir, "episodic.jsonl.tmp"), "partial data from crash\n");

      const store = new MemoryStore({ storeDir: dir });
      const entries = store.getEpisodic();

      // 主文件数据完好
      expect(entries).toHaveLength(1);
      expect(entries[0]!.taskSummary).toBe("Crash task");

      // .tmp 文件应该被清理
      expect(existsSync(join(dir, "episodic.jsonl.tmp"))).toBe(false);
    });

    it("大量数据写入后 reload 数据完整性", () => {
      const store = new MemoryStore({ storeDir: dir });
      const count = 100;

      for (let i = 0; i < count; i++) {
        store.addEpisodic(
          `Task ${i}`,
          `Outcome ${i}`.repeat(10), // 较长内容
          Array.from({ length: 5 }, (_, j) => `Lesson ${i}-${j}`),
          Array.from({ length: 3 }, (_, j) => `tag-${i}-${j}`)
        );
      }

      // Reload
      const store2 = new MemoryStore({ storeDir: dir });
      const entries = store2.getEpisodic();
      expect(entries).toHaveLength(count);

      // 随机抽样验证完整性
      for (const idx of [0, 25, 50, 75, 99]) {
        const found = entries.find((e) => e.taskSummary === `Task ${idx}`);
        expect(found).toBeDefined();
        expect(found!.outcome).toBe(`Outcome ${idx}`.repeat(10));
        expect(found!.lessons).toHaveLength(5);
        expect(found!.tags).toHaveLength(3);
      }
    });
  });
});
