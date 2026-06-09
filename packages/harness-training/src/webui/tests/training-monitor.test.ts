/**
 * Tests for TrainingMonitor (SP6 WebUI integration).
 * Covers: server lifecycle, REST API, SSE events, progress callback, dashboard HTML.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { TrainingMonitor } from "../training-monitor.js";
import type { TrainingProgress } from "../../trainer.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function httpGet(url: string): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => (body += chunk.toString()));
      res.on("end", () => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (typeof v === "string") headers[k] = v;
          else if (Array.isArray(v)) headers[k] = v.join(", ");
        }
        resolve({ status: res.statusCode ?? 0, body, headers });
      });
      res.on("error", reject);
    }).on("error", reject);
  });
}

function httpGetSSE(url: string, timeoutMs = 500): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = "";
      const timeout = setTimeout(() => {
        res.destroy();
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (typeof v === "string") headers[k] = v;
          else if (Array.isArray(v)) headers[k] = v.join(", ");
        }
        resolve({ status: res.statusCode ?? 0, headers, body });
      }, timeoutMs);
      res.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      res.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
    req.on("error", reject);
  });
}

function makeProgress(epoch: number, totalEpochs = 5): TrainingProgress {
  return {
    runName: "test-run",
    epoch,
    totalEpochs,
    loss: 1.0 - epoch * 0.15,
    accuracy: 0.3 + epoch * 0.12,
    bestSkillUpdated: epoch === 3,
    elapsedMs: epoch * 2000,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("TrainingMonitor", () => {
  let monitor: TrainingMonitor;
  let port: number;

  beforeEach(async () => {
    monitor = new TrainingMonitor({ port: 0, host: "127.0.0.1", runName: "test-run" });
    port = await monitor.start();
  });

  afterEach(async () => {
    await monitor.stop();
  });

  // ── Server Lifecycle ────────────────────────────────────────────────────

  it("should start and return a valid port", () => {
    expect(port).toBeGreaterThan(0);
  });

  it("should stop cleanly", async () => {
    const m = new TrainingMonitor({ port: 0, host: "127.0.0.1" });
    const p = await m.start();
    expect(p).toBeGreaterThan(0);
    await m.stop();
  });

  it("should stop gracefully when not started", async () => {
    const m = new TrainingMonitor({ port: 0 });
    await m.stop(); // should not throw
  });

  it("should return port 0 when not started", () => {
    const m = new TrainingMonitor({ port: 0 });
    expect(m.getPort()).toBe(0);
  });

  // ── REST API ────────────────────────────────────────────────────────────

  it("should serve dashboard at /", async () => {
    const res = await httpGet(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("SkillOpt Training Monitor");
    expect(res.body).toContain("test-run");
  });

  it("should serve state at /api/state", async () => {
    const res = await httpGet(`http://127.0.0.1:${port}/api/state`);
    expect(res.status).toBe(200);
    const state = JSON.parse(res.body);
    expect(state.status).toBe("idle");
    expect(state.runName).toBe("test-run");
    expect(state.currentEpoch).toBe(0);
    expect(state.historyLength).toBe(0);
  });

  it("should serve empty history at /api/history", async () => {
    const res = await httpGet(`http://127.0.0.1:${port}/api/history`);
    expect(res.status).toBe(200);
    const history = JSON.parse(res.body);
    expect(Array.isArray(history)).toBe(true);
    expect(history).toHaveLength(0);
  });

  it("should return 404 for unknown paths", async () => {
    const res = await httpGet(`http://127.0.0.1:${port}/unknown`);
    expect(res.status).toBe(404);
  });

  // ── State Management ────────────────────────────────────────────────────

  it("should start in idle state", () => {
    const state = monitor.getState();
    expect(state.status).toBe("idle");
    expect(state.currentEpoch).toBe(0);
    expect(state.history).toHaveLength(0);
  });

  it("should update state on notifyStart", () => {
    monitor.notifyStart(10, "my-run");
    const state = monitor.getState();
    expect(state.status).toBe("running");
    expect(state.totalEpochs).toBe(10);
    expect(state.runName).toBe("my-run");
    expect(state.startedAt).toBeTruthy();
  });

  it("should update state on notifyComplete", () => {
    monitor.notifyComplete();
    expect(monitor.getState().status).toBe("completed");
  });

  it("should update state on notifyFailed", () => {
    monitor.notifyFailed("OOM error");
    expect(monitor.getState().status).toBe("failed");
  });

  // ── Progress Callback ───────────────────────────────────────────────────

  it("should create a working progress callback", () => {
    const cb = monitor.createProgressCallback();
    expect(typeof cb).toBe("function");

    cb(makeProgress(1));
    const state = monitor.getState();
    expect(state.currentEpoch).toBe(1);
    expect(state.latestLoss).toBeCloseTo(0.85);
    expect(state.latestAccuracy).toBeCloseTo(0.42);
    expect(state.history).toHaveLength(1);
  });

  it("should accumulate history from multiple progress updates", () => {
    const cb = monitor.createProgressCallback();
    for (let i = 1; i <= 5; i++) {
      cb(makeProgress(i));
    }
    const state = monitor.getState();
    expect(state.history).toHaveLength(5);
    expect(state.currentEpoch).toBe(5);
    expect(state.latestLoss).toBeCloseTo(0.25);
  });

  it("should track bestSkillUpdated flag", () => {
    const cb = monitor.createProgressCallback();
    cb(makeProgress(1));
    expect(monitor.getState().bestSkillUpdated).toBe(false);
    cb(makeProgress(3));
    expect(monitor.getState().bestSkillUpdated).toBe(true);
    cb(makeProgress(4));
    expect(monitor.getState().bestSkillUpdated).toBe(false);
  });

  it("should update totalEpochs from progress", () => {
    const cb = monitor.createProgressCallback();
    cb(makeProgress(1, 20));
    expect(monitor.getState().totalEpochs).toBe(20);
  });

  // ── REST API reflects state changes ────────────────────────────────────

  it("should reflect state changes in /api/state", async () => {
    monitor.notifyStart(5, "run-abc");
    const cb = monitor.createProgressCallback();
    cb(makeProgress(1));
    cb(makeProgress(2));

    const res = await httpGet(`http://127.0.0.1:${port}/api/state`);
    const state = JSON.parse(res.body);
    expect(state.status).toBe("running");
    expect(state.currentEpoch).toBe(2);
    expect(state.historyLength).toBe(2);
  });

  it("should reflect history in /api/history", async () => {
    const cb = monitor.createProgressCallback();
    cb(makeProgress(1));
    cb(makeProgress(2));
    cb(makeProgress(3));

    const res = await httpGet(`http://127.0.0.1:${port}/api/history`);
    const history = JSON.parse(res.body);
    expect(history).toHaveLength(3);
    expect(history[0].epoch).toBe(1);
    expect(history[2].epoch).toBe(3);
  });

  // ── Dashboard HTML ──────────────────────────────────────────────────────

  it("should include Chart.js in dashboard", async () => {
    const res = await httpGet(`http://127.0.0.1:${port}/`);
    expect(res.body).toContain("chart.js");
    expect(res.body).toContain("loss-chart");
    expect(res.body).toContain("accuracy-chart");
  });

  it("should include SSE connection code in dashboard", async () => {
    const res = await httpGet(`http://127.0.0.1:${port}/`);
    expect(res.body).toContain("/api/events");
    expect(res.body).toContain("EventSource");
  });

  it("should escape HTML in run name", async () => {
    const m = new TrainingMonitor({ port: 0, host: "127.0.0.1", runName: '<script>alert("xss")</script>' });
    const p = await m.start();
    try {
      const res = await httpGet(`http://127.0.0.1:${p}/`);
      expect(res.body).not.toContain('<script>alert("xss")</script>');
      expect(res.body).toContain("&lt;script&gt;");
    } finally {
      await m.stop();
    }
  });

  // ── SSE ─────────────────────────────────────────────────────────────────

  it("should serve SSE at /api/events", async () => {
    const res = await httpGetSSE(`http://127.0.0.1:${port}/api/events`, 300);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.body).toContain("event: init");
  });

  it("should broadcast progress events to SSE clients", async () => {
    // Connect SSE client with longer timeout to receive progress event
    const ssePromise = httpGetSSE(`http://127.0.0.1:${port}/api/events`, 600);

    // Wait for SSE connection to establish, then push progress
    await new Promise((r) => setTimeout(r, 100));
    const cb = monitor.createProgressCallback();
    cb(makeProgress(1));

    const res = await ssePromise;
    expect(res.body).toContain("event: progress");
    expect(res.body).toContain('"epoch":1');
  });

  // ── Default config ──────────────────────────────────────────────────────

  it("should use default config when not specified", () => {
    const m = new TrainingMonitor();
    expect(m.getState().runName).toBe("training-run");
    expect(m.getState().status).toBe("idle");
  });

  // ── Full lifecycle ──────────────────────────────────────────────────────

  it("should support full training lifecycle", async () => {
    monitor.notifyStart(3, "full-run");
    const cb = monitor.createProgressCallback();

    cb(makeProgress(1, 3));
    cb(makeProgress(2, 3));
    cb(makeProgress(3, 3));
    monitor.notifyComplete();

    const state = monitor.getState();
    expect(state.status).toBe("completed");
    expect(state.history).toHaveLength(3);
    expect(state.currentEpoch).toBe(3);

    const res = await httpGet(`http://127.0.0.1:${port}/api/state`);
    const apiState = JSON.parse(res.body);
    expect(apiState.status).toBe("completed");
    expect(apiState.historyLength).toBe(3);
  });
});
