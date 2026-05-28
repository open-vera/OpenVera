/**
 * OC9-OC12: MemoryUpdater, MergeStrategy, TopicOrganizer tests
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryUpdater } from "../memory-updater.js";
import { parseMergeResponse, runMergeStrategy } from "../merge-strategy.js";
import { TopicOrganizer } from "../topic-organizer.js";
import { MemoryStore } from "../store.js";
import type { Message } from "../../types/index.js";
import type { LLMAdapter } from "../../adapters/base.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeMessages(count: number): Message[] {
  const msgs: Message[] = [];
  for (let i = 0; i < count; i++) {
    msgs.push({ role: "user", content: `User message ${i}` });
    msgs.push({
      role: "assistant",
      content: `Assistant response ${i}`,
    });
  }
  return msgs;
}

function mockAdapter(response: string): LLMAdapter {
  return {
    complete: vi.fn().mockResolvedValue({
      message: { role: "assistant", content: response },
      stop_reason: "end_turn",
    }),
  } as unknown as LLMAdapter;
}

// ── OC9: MemoryUpdater ─────────────────────────────────────────────────────

describe("OC9: MemoryUpdater", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mem-updater-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should skip update when turn count < minTurns", async () => {
    const store = new MemoryStore({ storeDir: join(tmpDir, "mem") });
    const adapter = mockAdapter("{}");
    const updater = new MemoryUpdater({
      minTurns: 10,
      adapter,
      model: "test",
      store,
    });

    const messages = makeMessages(5); // 5 user turns
    const result = await updater.update(messages);

    expect(result.triggered).toBe(false);
    expect(result.created).toBe(0);
    expect(adapter.complete).not.toHaveBeenCalled();
  });

  it("should trigger update when turn count >= minTurns", async () => {
    const store = new MemoryStore({ storeDir: join(tmpDir, "mem") });
    const response = JSON.stringify({
      summary: "Test task",
      decisions: [
        {
          action: "create",
          key: "Important finding",
          value: "We discovered that X works better than Y",
          tags: ["discovery"],
          importance: 0.9,
        },
      ],
    });
    const adapter = mockAdapter(response);
    const updater = new MemoryUpdater({
      minTurns: 10,
      adapter,
      model: "test",
      store,
    });

    const messages = makeMessages(10); // 10 user turns = meets threshold
    const result = await updater.update(messages);

    expect(result.triggered).toBe(true);
    expect(result.created).toBe(1);
    expect(adapter.complete).toHaveBeenCalled();
    expect(store.getSemantic().length).toBeGreaterThanOrEqual(1);
  });

  it("should count only user messages as turns", () => {
    const store = new MemoryStore();
    const adapter = mockAdapter("{}");
    const updater = new MemoryUpdater({
      adapter,
      model: "test",
      store,
    });

    const messages: Message[] = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
      { role: "user", content: "How are you?" },
      { role: "assistant", content: "Fine" },
      { role: "user", content: "Good" },
    ];

    expect(updater.countTurns(messages)).toBe(3);
  });

  it("should call onUpdate callback after update", async () => {
    const store = new MemoryStore({ storeDir: join(tmpDir, "mem") });
    const onUpdate = vi.fn();
    const response = JSON.stringify({
      summary: "Test",
      decisions: [],
    });
    const adapter = mockAdapter(response);
    const updater = new MemoryUpdater({
      minTurns: 5,
      adapter,
      model: "test",
      store,
      onUpdate,
    });

    const messages = makeMessages(5);
    await updater.update(messages);

    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ triggered: true }),
    );
  });
});

// ── OC10: MergeStrategy ────────────────────────────────────────────────────

describe("OC10: MergeStrategy", () => {
  it("should parse valid JSON response", () => {
    const response = JSON.stringify({
      summary: "Discussed API design",
      decisions: [
        {
          action: "create",
          key: "REST vs GraphQL",
          value: "Team decided to use REST for internal APIs",
          tags: ["architecture", "decision"],
          importance: 0.9,
          reason: "Important architectural decision",
        },
      ],
    });

    const result = parseMergeResponse(response);

    expect(result.summary).toBe("Discussed API design");
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]!.action).toBe("create");
    expect(result.decisions[0]!.key).toBe("REST vs GraphQL");
    expect(result.decisions[0]!.importance).toBe(0.9);
  });

  it("should parse JSON wrapped in code block", () => {
    const response = '```json\n{"summary":"Test","decisions":[]}\n```';
    const result = parseMergeResponse(response);
    expect(result.summary).toBe("Test");
    expect(result.decisions).toHaveLength(0);
  });

  it("should handle invalid JSON gracefully", () => {
    const result = parseMergeResponse("This is not JSON at all");
    expect(result.decisions).toHaveLength(0);
  });

  it("should validate decision structure and skip invalid ones", () => {
    const response = JSON.stringify({
      decisions: [
        { action: "create", key: "Valid", value: "Content", importance: 0.5 },
        { action: "create" }, // missing key + value
        { action: "update", value: "New content" }, // missing existingKey
        { action: "invalid", key: "X", value: "Y" }, // bad action
        { action: "discard", existingKey: "old-key" }, // valid
      ],
    });

    const result = parseMergeResponse(response);
    expect(result.decisions).toHaveLength(2);
    expect(result.decisions[0]!.action).toBe("create");
    expect(result.decisions[1]!.action).toBe("discard");
  });

  it("should clamp importance to 0-1 range", () => {
    const response = JSON.stringify({
      decisions: [
        { action: "create", key: "A", value: "B", importance: 1.5 },
        { action: "create", key: "C", value: "D", importance: -0.5 },
      ],
    });

    const result = parseMergeResponse(response);
    expect(result.decisions[0]!.importance).toBe(1);
    expect(result.decisions[1]!.importance).toBe(0);
  });
});

// ── OC11: TopicOrganizer ───────────────────────────────────────────────────

describe("OC11: TopicOrganizer", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "topic-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should add entry to a topic file", () => {
    const organizer = new TopicOrganizer({
      baseDir: tmpDir,
      maxTokensPerFile: 1000,
    });

    const added = organizer.addEntry("api-design", {
      key: "REST endpoints",
      value: "Use /api/v1 prefix for all endpoints",
      addedAt: "2026-01-01T00:00:00Z",
      importance: 0.8,
    });

    expect(added).toBe(true);
    const topic = organizer.getTopic("api-design");
    expect(topic).not.toBeNull();
    expect(topic!.content).toContain("REST endpoints");
  });

  it("should list all topic files", () => {
    const organizer = new TopicOrganizer({ baseDir: tmpDir });

    organizer.addEntry("topic-a", {
      key: "A", value: "Content A", addedAt: "", importance: 0.5,
    });
    organizer.addEntry("topic-b", {
      key: "B", value: "Content B", addedAt: "", importance: 0.5,
    });

    const topics = organizer.listTopics();
    expect(topics).toHaveLength(2);
    expect(topics.map((t) => t.topic)).toContain("topic-a");
    expect(topics.map((t) => t.topic)).toContain("topic-b");
  });

  it("should evict low-importance entries when file exceeds token limit", () => {
    const organizer = new TopicOrganizer({
      baseDir: tmpDir,
      maxTokensPerFile: 50,
    });

    // Add entries with varying importance
    organizer.addEntry("test", {
      key: "Low",
      value: "low importance content",
      addedAt: "",
      importance: 0.2,
    });
    organizer.addEntry("test", {
      key: "Medium",
      value: "medium importance content",
      addedAt: "",
      importance: 0.5,
    });

    // Adding high-importance entry pushes total past 50-token limit
    const added = organizer.addEntry("test", {
      key: "High",
      value: "high importance content that is longer than the others to push over the limit",
      addedAt: "",
      importance: 0.9,
    });

    expect(added).toBe(true);
    const topic = organizer.getTopic("test");
    expect(topic).not.toBeNull();
    // Low importance entry should have been evicted
    expect(topic!.content).not.toContain("Low");
    expect(topic!.content).toContain("High");
  });

  it("should reject entry when topic is full and new entry is not important enough", () => {
    const organizer = new TopicOrganizer({
      baseDir: tmpDir,
      maxTokensPerFile: 30,
    });

    organizer.addEntry("test", {
      key: "Important",
      value: "x".repeat(100),
      addedAt: "",
      importance: 0.9,
    });

    const added = organizer.addEntry("test", {
      key: "Not important",
      value: "y".repeat(100),
      addedAt: "",
      importance: 0.1,
    });

    expect(added).toBe(false);
  });

  it("should search across topic files", () => {
    const organizer = new TopicOrganizer({ baseDir: tmpDir });

    organizer.addEntry("api", {
      key: "REST API",
      value: "Use REST for all endpoints",
      addedAt: "",
      importance: 0.8,
    });
    organizer.addEntry("database", {
      key: "PostgreSQL",
      value: "Use PostgreSQL for data storage",
      addedAt: "",
      importance: 0.7,
    });

    const results = organizer.search("REST API");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.topic).toBe("api");
  });

  it("should return stats about all topic files", () => {
    const organizer = new TopicOrganizer({ baseDir: tmpDir });

    organizer.addEntry("a", { key: "K1", value: "V1", addedAt: "", importance: 0.5 });
    organizer.addEntry("a", { key: "K2", value: "V2", addedAt: "", importance: 0.5 });
    organizer.addEntry("b", { key: "K3", value: "V3", addedAt: "", importance: 0.5 });

    const stats = organizer.stats();
    expect(stats.topics).toBe(2);
    expect(stats.totalEntries).toBe(3);
    expect(stats.totalTokens).toBeGreaterThan(0);
  });
});
