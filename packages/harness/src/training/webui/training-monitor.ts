/**
 * TrainingMonitor — Lightweight HTTP server for real-time training monitoring.
 *
 * Provides:
 * - SSE endpoint for live epoch updates
 * - REST API for current state and full history
 * - Static HTML dashboard with Chart.js loss/accuracy curves
 *
 * Uses only Node built-in `http` — zero new dependencies.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { TrainingProgress } from "../trainer.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface MonitorConfig {
  /** HTTP port (default: 7394) */
  port?: number;
  /** Host to bind (default: "0.0.0.0" for remote access) */
  host?: string;
  /** Training run name displayed in dashboard */
  runName?: string;
}

export interface MonitorState {
  runName: string;
  status: "idle" | "running" | "completed" | "failed";
  currentEpoch: number;
  totalEpochs: number;
  latestLoss: number;
  latestAccuracy: number;
  bestSkillUpdated: boolean;
  elapsedMs: number;
  startedAt: string | null;
  history: TrainingProgress[];
}

// ── Training Monitor ─────────────────────────────────────────────────────────

export class TrainingMonitor {
  private server: Server | null = null;
  private config: Required<MonitorConfig>;
  private state: MonitorState;
  private sseClients: Set<ServerResponse> = new Set();

  constructor(config?: MonitorConfig) {
    this.config = {
      port: config?.port ?? 7394,
      host: config?.host ?? "0.0.0.0",
      runName: config?.runName ?? "training-run",
    };

    this.state = {
      runName: this.config.runName,
      status: "idle",
      currentEpoch: 0,
      totalEpochs: 0,
      latestLoss: 0,
      latestAccuracy: 0,
      bestSkillUpdated: false,
      elapsedMs: 0,
      startedAt: null,
      history: [],
    };
  }

  /**
   * Start the HTTP server. Returns the bound port.
   */
  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => this.handleRequest(req, res));

      this.server.on("error", (err) => reject(err));

      this.server.listen(this.config.port, this.config.host, () => {
        const addr = this.server?.address();
        if (typeof addr === "object" && addr !== null) {
          this.config.port = addr.port;
        }
        resolve(this.config.port);
      });
    });
  }

  /**
   * Stop the HTTP server and disconnect all SSE clients.
   */
  async stop(): Promise<void> {
    for (const client of this.sseClients) {
      client.end();
    }
    this.sseClients.clear();

    return new Promise((resolve, reject) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close((err) => {
        this.server = null;
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Returns a callback suitable for TrainerConfig.onProgress.
   */
  createProgressCallback(): (update: TrainingProgress) => void {
    return (update: TrainingProgress) => this.onProgress(update);
  }

  /**
   * Notify the monitor that training started.
   */
  notifyStart(totalEpochs: number, runName?: string): void {
    this.state.status = "running";
    this.state.totalEpochs = totalEpochs;
    this.state.startedAt = new Date().toISOString();
    if (runName) this.state.runName = runName;
    this.broadcastSSE({ type: "start", data: this.getPublicState() });
  }

  /**
   * Notify the monitor that training completed.
   */
  notifyComplete(): void {
    this.state.status = "completed";
    this.broadcastSSE({ type: "complete", data: this.getPublicState() });
  }

  /**
   * Notify the monitor that training failed.
   */
  notifyFailed(error: string): void {
    this.state.status = "failed";
    this.broadcastSSE({ type: "failed", data: { ...this.getPublicState(), error } });
  }

  /**
   * Get current monitor state (read-only copy).
   */
  getState(): MonitorState {
    return { ...this.state, history: [...this.state.history] };
  }

  /**
   * Get the bound port (useful when port=0 for auto-assign).
   */
  getPort(): number {
    if (!this.server) return 0;
    const addr = this.server.address();
    if (typeof addr === "object" && addr !== null) return addr.port;
    return this.config.port;
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private onProgress(update: TrainingProgress): void {
    this.state.currentEpoch = update.epoch;
    this.state.totalEpochs = update.totalEpochs;
    this.state.latestLoss = update.loss;
    this.state.latestAccuracy = update.accuracy;
    this.state.bestSkillUpdated = update.bestSkillUpdated;
    this.state.elapsedMs = update.elapsedMs;
    if (update.runName) this.state.runName = update.runName;
    this.state.history.push(update);

    this.broadcastSSE({ type: "progress", data: update });
  }

  private getPublicState(): Omit<MonitorState, "history"> & { historyLength: number } {
    return {
      runName: this.state.runName,
      status: this.state.status,
      currentEpoch: this.state.currentEpoch,
      totalEpochs: this.state.totalEpochs,
      latestLoss: this.state.latestLoss,
      latestAccuracy: this.state.latestAccuracy,
      bestSkillUpdated: this.state.bestSkillUpdated,
      elapsedMs: this.state.elapsedMs,
      startedAt: this.state.startedAt,
      historyLength: this.state.history.length,
    };
  }

  private broadcastSSE(event: { type: string; data: unknown }): void {
    const payload = `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
    for (const client of this.sseClients) {
      try {
        client.write(payload);
      } catch {
        this.sseClients.delete(client);
      }
    }
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", `http://localhost:${this.config.port}`);
    const path = url.pathname;

    // CORS headers for all responses
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    switch (path) {
      case "/":
        this.serveDashboard(res);
        break;
      case "/api/state":
        this.serveState(res);
        break;
      case "/api/history":
        this.serveHistory(res);
        break;
      case "/api/events":
        this.handleSSE(req, res);
        break;
      default:
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
    }
  }

  private serveState(res: ServerResponse): void {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(this.getPublicState()));
  }

  private serveHistory(res: ServerResponse): void {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(this.state.history));
  }

  private handleSSE(_req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    // Send current state as initial event
    res.write(`event: init\ndata: ${JSON.stringify(this.getPublicState())}\n\n`);

    this.sseClients.add(res);

    _req.on("close", () => {
      this.sseClients.delete(res);
    });
  }

  private serveDashboard(res: ServerResponse): void {
    const html = buildDashboardHtml(this.config.runName);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  }
}

// ── Dashboard HTML ───────────────────────────────────────────────────────────

function buildDashboardHtml(runName: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SkillOpt Training Monitor — ${escapeHtml(runName)}</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #e2e8f0; padding: 24px; }
    h1 { font-size: 1.5rem; margin-bottom: 8px; color: #38bdf8; }
    .subtitle { color: #94a3b8; margin-bottom: 24px; font-size: 0.875rem; }
    .status-bar { display: flex; gap: 24px; flex-wrap: wrap; margin-bottom: 24px; }
    .stat { background: #1e293b; border-radius: 8px; padding: 16px 20px; min-width: 140px; }
    .stat-label { font-size: 0.75rem; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.05em; }
    .stat-value { font-size: 1.75rem; font-weight: 700; margin-top: 4px; }
    .stat-value.loss { color: #f472b6; }
    .stat-value.accuracy { color: #34d399; }
    .stat-value.epoch { color: #fbbf24; }
    .stat-value.time { color: #a78bfa; }
    .stat-value.status { font-size: 1rem; }
    .stat-value.status.running { color: #38bdf8; }
    .stat-value.status.completed { color: #34d399; }
    .stat-value.status.failed { color: #f87171; }
    .stat-value.status.idle { color: #94a3b8; }
    .charts { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-bottom: 24px; }
    .chart-box { background: #1e293b; border-radius: 8px; padding: 16px; }
    .chart-box h2 { font-size: 1rem; margin-bottom: 12px; color: #cbd5e1; }
    .chart-container { position: relative; height: 300px; }
    .best-skill { background: #1e293b; border-radius: 8px; padding: 16px; }
    .best-skill h2 { font-size: 1rem; margin-bottom: 8px; color: #cbd5e1; }
    .best-skill .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; font-weight: 600; }
    .best-skill .badge.updated { background: #34d399; color: #064e3b; }
    .best-skill .badge.pending { background: #475569; color: #94a3b8; }
    @media (max-width: 768px) { .charts { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <h1>SkillOpt Training Monitor</h1>
  <p class="subtitle">Run: <strong>${escapeHtml(runName)}</strong> &mdash; <span id="conn-status">Connecting...</span></p>

  <div class="status-bar">
    <div class="stat"><div class="stat-label">Status</div><div class="stat-value status idle" id="val-status">idle</div></div>
    <div class="stat"><div class="stat-label">Epoch</div><div class="stat-value epoch" id="val-epoch">0 / 0</div></div>
    <div class="stat"><div class="stat-label">Loss</div><div class="stat-value loss" id="val-loss">—</div></div>
    <div class="stat"><div class="stat-label">Accuracy</div><div class="stat-value accuracy" id="val-accuracy">—</div></div>
    <div class="stat"><div class="stat-label">Elapsed</div><div class="stat-value time" id="val-time">—</div></div>
    <div class="stat"><div class="stat-label">Best Skill</div><div id="val-best-skill"><span class="badge pending">pending</span></div></div>
  </div>

  <div class="charts">
    <div class="chart-box">
      <h2>Loss Curve</h2>
      <div class="chart-container"><canvas id="loss-chart"></canvas></div>
    </div>
    <div class="chart-box">
      <h2>Accuracy Curve</h2>
      <div class="chart-container"><canvas id="accuracy-chart"></canvas></div>
    </div>
  </div>

  <script>
    const epochs = [], losses = [], accuracies = [];

    const lossChart = new Chart(document.getElementById('loss-chart'), {
      type: 'line',
      data: { labels: epochs, datasets: [{ label: 'Loss', data: losses, borderColor: '#f472b6', backgroundColor: 'rgba(244,114,182,0.1)', fill: true, tension: 0.3, pointRadius: 4 }] },
      options: { responsive: true, maintainAspectRatio: false, scales: { x: { title: { display: true, text: 'Epoch', color: '#94a3b8' }, ticks: { color: '#94a3b8' }, grid: { color: '#334155' } }, y: { title: { display: true, text: 'Loss', color: '#94a3b8' }, ticks: { color: '#94a3b8' }, grid: { color: '#334155' } } }, plugins: { legend: { labels: { color: '#e2e8f0' } } } }
    });

    const accChart = new Chart(document.getElementById('accuracy-chart'), {
      type: 'line',
      data: { labels: epochs, datasets: [{ label: 'Accuracy', data: accuracies, borderColor: '#34d399', backgroundColor: 'rgba(52,211,153,0.1)', fill: true, tension: 0.3, pointRadius: 4 }] },
      options: { responsive: true, maintainAspectRatio: false, scales: { x: { title: { display: true, text: 'Epoch', color: '#94a3b8' }, ticks: { color: '#94a3b8' }, grid: { color: '#334155' } }, y: { title: { display: true, text: 'Accuracy', color: '#94a3b8' }, ticks: { color: '#94a3b8' }, grid: { color: '#334155' }, min: 0, max: 1 } }, plugins: { legend: { labels: { color: '#e2e8f0' } } } }
    });

    function updateCharts() {
      lossChart.update();
      accChart.update();
    }

    function formatTime(ms) {
      const s = Math.floor(ms / 1000);
      const m = Math.floor(s / 60);
      const h = Math.floor(m / 60);
      if (h > 0) return h + 'h ' + (m % 60) + 'm';
      if (m > 0) return m + 'm ' + (s % 60) + 's';
      return s + 's';
    }

    function setStatus(status) {
      const el = document.getElementById('val-status');
      el.textContent = status;
      el.className = 'stat-value status ' + status;
    }

    function onProgress(d) {
      epochs.push(d.epoch);
      losses.push(d.loss);
      accuracies.push(d.accuracy);
      document.getElementById('val-epoch').textContent = d.epoch + ' / ' + d.totalEpochs;
      document.getElementById('val-loss').textContent = d.loss.toFixed(4);
      document.getElementById('val-accuracy').textContent = (d.accuracy * 100).toFixed(1) + '%';
      document.getElementById('val-time').textContent = formatTime(d.elapsedMs);
      if (d.bestSkillUpdated) {
        document.getElementById('val-best-skill').innerHTML = '<span class="badge updated">updated!</span>';
      }
      updateCharts();
    }

    function initState(s) {
      setStatus(s.status);
      document.getElementById('val-epoch').textContent = s.currentEpoch + ' / ' + s.totalEpochs;
      if (s.latestLoss) document.getElementById('val-loss').textContent = s.latestLoss.toFixed(4);
      if (s.latestAccuracy) document.getElementById('val-accuracy').textContent = (s.latestAccuracy * 100).toFixed(1) + '%';
      if (s.elapsedMs) document.getElementById('val-time').textContent = formatTime(s.elapsedMs);
    }

    // SSE connection with auto-reconnect
    function connect() {
      const es = new EventSource('/api/events');
      document.getElementById('conn-status').textContent = 'Connected';
      es.addEventListener('init', (e) => { initState(JSON.parse(e.data)); });
      es.addEventListener('start', (e) => { const d = JSON.parse(e.data); setStatus('running'); initState(d); });
      es.addEventListener('progress', (e) => { onProgress(JSON.parse(e.data)); });
      es.addEventListener('complete', (e) => { setStatus('completed'); });
      es.addEventListener('failed', (e) => { setStatus('failed'); });
      es.onerror = () => {
        document.getElementById('conn-status').textContent = 'Reconnecting...';
        es.close();
        setTimeout(connect, 2000);
      };
    }
    connect();
  </script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
