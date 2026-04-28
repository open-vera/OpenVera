<script lang="ts">
  import { listModels, uninstallModel, installStream, preflight, listPrompts, savePrompt, deletePrompt, listOllamaModels, ollamaRm, type ModelInfo, type CheckItem, type PromptInfo } from "../api";

  interface Props {
    onBack: () => void;
  }
  let { onBack }: Props = $props();

  type Tab = "env" | "prompts" | "about";
  let activeTab = $state<Tab>("env");

  // ── 精选 LLM 模型注册表 ──────────────────────────────
  interface LlmEntry {
    id: string;           // ollama pull 使用的 id
    name: string;
    sizeLabel: string;    // "9.2B · 5.5GB"
    description: string;
    tasks: string[];
    speedScore: number;   // 1-10
    chineseStars: number; // 1-5
    recommended?: boolean;
  }

  const LLM_REGISTRY: LlmEntry[] = [
    {
      id: "qwen3.5:9b",
      name: "Qwen3.5:9B",
      sizeLabel: "9.2B · 5.5 GB",
      description: "综合能力最强的中文模型，适合纠错、摘要、分析等复杂任务",
      tasks: ["纠错", "说话人分离", "摘要", "翻译"],
      speedScore: 7,
      chineseStars: 5,
      recommended: true,
    },
    {
      id: "qwen3:8b",
      name: "Qwen3:8B",
      sizeLabel: "8B · 4.9 GB",
      description: "速度和质量均衡，适合日常批量标注",
      tasks: ["纠错", "翻译", "分句"],
      speedScore: 8,
      chineseStars: 5,
    },
    {
      id: "qwen3:4b",
      name: "Qwen3:4B",
      sizeLabel: "4B · 2.5 GB",
      description: "轻量快速，内存受限时的首选",
      tasks: ["纠错", "分句"],
      speedScore: 9,
      chineseStars: 4,
    },
    {
      id: "gemma3:4b",
      name: "Gemma3:4B",
      sizeLabel: "4B · 2.5 GB",
      description: "Google 轻量模型，内容标签和质量评分表现优秀",
      tasks: ["内容标签", "质量评分"],
      speedScore: 9,
      chineseStars: 3,
      recommended: true,
    },
    {
      id: "llama3.2:3b",
      name: "Llama3.2:3B",
      sizeLabel: "3B · 2.0 GB",
      description: "超轻量，适合 8GB 内存机器",
      tasks: ["纠错", "摘要"],
      speedScore: 10,
      chineseStars: 2,
    },
  ];

  // ── 环境管理：ASR 模型 ──
  let models = $state<ModelInfo[]>([]);
  let installedCount = $state(0);
  let checks = $state<CheckItem[]>([]);
  let loadingModels = $state(true);
  let loadingChecks = $state(true);
  let busy = $state<Record<string, boolean>>({});
  let logs = $state<Record<string, string[]>>({});
  let activeLog = $state("");

  // ── 环境管理：LLM 模型（Ollama）──
  let llmInstalledNames = $state<Set<string>>(new Set());
  let loadingLlm = $state(true);
  let llmBusy = $state<Record<string, boolean>>({});
  let llmLogs = $state<Record<string, string[]>>({});
  let activeLlmLog = $state("");

  async function refreshModels() {
    loadingModels = true;
    try {
      const res = await listModels();
      models = res.models;
      installedCount = res.installed_count;
    } catch (e) { console.error(e); }
    loadingModels = false;
  }

  async function refreshLlmModels() {
    loadingLlm = true;
    try {
      const res = await listOllamaModels();
      llmInstalledNames = new Set(res.llm_models.map(m => m.name));
    } catch { llmInstalledNames = new Set(); }
    loadingLlm = false;
  }

  function isLlmInstalled(entry: LlmEntry): boolean {
    // Ollama 名称可能带 :latest 后缀，做宽松匹配
    const base = entry.id.includes(":") ? entry.id : entry.id + ":latest";
    return llmInstalledNames.has(entry.id) || llmInstalledNames.has(base);
  }

  async function refreshChecks() {
    loadingChecks = true;
    try {
      const res = await preflight();
      checks = res.checks;
    } catch (e) { console.error(e); }
    loadingChecks = false;
  }

  $effect(() => { refreshModels(); refreshChecks(); refreshLlmModels(); });

  // ── 提示词管理 ──
  let prompts = $state<PromptInfo[]>([]);
  let editingPrompt = $state<{ name: string; content: string } | null>(null);
  let isNewPrompt = $state(false);

  async function refreshPrompts() {
    try {
      const res = await listPrompts();
      prompts = res.prompts;
    } catch (e) { console.error(e); }
  }

  $effect(() => { if (activeTab === "prompts") refreshPrompts(); });

  function startNewPrompt() {
    editingPrompt = { name: "", content: "" };
    isNewPrompt = true;
  }

  function startEditPrompt(p: PromptInfo) {
    editingPrompt = { name: p.name, content: p.content };
    isNewPrompt = false;
  }

  async function handleSavePrompt() {
    if (!editingPrompt || !editingPrompt.name.trim()) return;
    await savePrompt(editingPrompt.name.trim(), editingPrompt.content);
    editingPrompt = null;
    await refreshPrompts();
  }

  async function handleDeletePrompt(name: string) {
    if (!confirm(`确认删除提示词「${name}」？`)) return;
    await deletePrompt(name);
    await refreshPrompts();
  }

  // ── ASR 模型安装/卸载 ──
  function handleInstallModel(m: ModelInfo) {
    busy[m.id] = true;
    logs[m.id] = [`$ ${m.install_cmd}`];
    activeLog = m.id;
    installStream(m.install_cmd, (ev) => {
      if (ev.event === "log" && ev.line !== undefined) {
        logs[m.id] = [...(logs[m.id] || []), ev.line];
      } else if (ev.event === "done") {
        busy[m.id] = false;
        if (ev.ok) refreshModels();
      }
    });
  }

  async function handleUninstall(m: ModelInfo) {
    if (!confirm(`确认卸载 ${m.name}？`)) return;
    busy[m.id] = true;
    try {
      const res = await uninstallModel(m.id);
      if (!res.ok) alert(`卸载失败：${res.errors.join(", ")}`);
      await refreshModels();
    } catch (e) { alert(`卸载失败：${e}`); }
    busy[m.id] = false;
  }

  // ── LLM 模型安装/卸载 ──
  function handleInstallLlm(entry: LlmEntry) {
    const cmd = `ollama pull ${entry.id}`;
    llmBusy[entry.id] = true;
    llmLogs[entry.id] = [`$ ${cmd}`];
    activeLlmLog = entry.id;
    installStream(cmd, (ev) => {
      if (ev.event === "log" && ev.line !== undefined) {
        llmLogs[entry.id] = [...(llmLogs[entry.id] || []), ev.line];
      } else if (ev.event === "done") {
        llmBusy[entry.id] = false;
        if (ev.ok) refreshLlmModels();
      }
    });
  }

  async function handleUninstallLlm(entry: LlmEntry) {
    if (!confirm(`确认卸载 ${entry.name}？`)) return;
    llmBusy[entry.id] = true;
    try {
      const res = await ollamaRm(entry.id);
      if (!res.ok) alert(`卸载失败：${res.output || "未知错误"}`);
      await refreshLlmModels();
    } catch (e) { alert(`卸载失败：${e}`); }
    llmBusy[entry.id] = false;
  }

  // ── 辅助渲染函数 ──
  function speedBlocks(score: number): boolean[] {
    return Array.from({ length: 10 }, (_, i) => i < score);
  }

  // 任务标签的语义颜色
  const taskColors: Record<string, string> = {
    "纠错":      "task-error",
    "说话人分离": "task-diarize",
    "摘要":      "task-summary",
    "翻译":      "task-translate",
    "分句":      "task-split",
    "内容标签":  "task-tag",
    "质量评分":  "task-quality",
  };
  function taskClass(t: string): string {
    return taskColors[t] ?? "task-default";
  }
</script>

<div class="settings-layout">
  <!-- 左侧导航 -->
  <nav class="side-nav">
    <div class="nav-title">设置</div>
    <button class="nav-item" class:active={activeTab === "env"} onclick={() => activeTab = "env"}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
      环境管理
    </button>
    <button class="nav-item" class:active={activeTab === "prompts"} onclick={() => activeTab = "prompts"}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
      提示词
    </button>
    <button class="nav-item" class:active={activeTab === "about"} onclick={() => activeTab = "about"}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
      关于
    </button>
    <div class="nav-spacer"></div>
  </nav>

  <!-- 右侧内容区 -->
  <main class="content">
    {#if activeTab === "env"}
      <!-- 模型管理 -->
      <section>
        <h4>ASR 模型</h4>
        <p class="hint">管理语音识别模型，至少需要保留一个已安装的模型。</p>
        {#if loadingModels}
          <p aria-busy="true">加载中…</p>
        {:else}
          <div class="card-list">
            {#each models as m (m.id)}
              <div class="card-row">
                <div class="card-info">
                  <strong>{m.name}</strong>
                  <small>{m.size}</small>
                </div>
                {#if m.installed}
                  <span class="badge badge-ok">已安装</span>
                {:else}
                  <span class="badge">未安装</span>
                {/if}
                <div class="card-actions">
                  {#if busy[m.id]}
                    <button class="btn-sm outline" aria-busy="true" disabled>处理中</button>
                  {:else if m.installed}
                    <button class="btn-sm outline secondary" onclick={() => handleUninstall(m)} disabled={installedCount <= 1} title={installedCount <= 1 ? "至少保留一个" : ""}>卸载</button>
                  {:else}
                    <button class="btn-sm outline" onclick={() => handleInstallModel(m)}>安装</button>
                  {/if}
                </div>
              </div>
            {/each}
          </div>

          {#if activeLog && logs[activeLog]?.length}
            <details class="log-panel" open>
              <summary>{busy[activeLog] ? "安装中…" : "安装日志"}</summary>
              <pre class="log-output">{logs[activeLog].join("\n")}</pre>
            </details>
          {/if}
        {/if}
      </section>

      <!-- LLM 模型管理 -->
      <section>
        <h4>LLM 模型（Ollama）</h4>
        <p class="hint">管理本地大语言模型，用于转写后纠错、摘要等后处理任务。需先安装 <strong>Ollama</strong>。</p>
        {#if loadingLlm}
          <p aria-busy="true">加载中…</p>
        {:else}
          <div class="card-list">
            {#each LLM_REGISTRY as entry (entry.id)}
              {@const installed = isLlmInstalled(entry)}
              <div class="llm-card" class:llm-recommended={entry.recommended}>
                {#if entry.recommended}
                  <div class="llm-rec-badge">推荐</div>
                {/if}
                <!-- 头部：名称 + 大小 + 状态 + 按钮 -->
                <div class="llm-header">
                  <div class="llm-title">
                    <strong>{entry.name}</strong>
                    <span class="llm-size">{entry.sizeLabel}</span>
                  </div>
                  <div class="llm-actions">
                    {#if installed}
                      <span class="badge badge-ok">已安装</span>
                    {:else}
                      <span class="badge">未安装</span>
                    {/if}
                    {#if llmBusy[entry.id]}
                      <button class="btn-sm outline" aria-busy="true" disabled>处理中</button>
                    {:else if installed}
                      <button class="btn-sm outline secondary" onclick={() => handleUninstallLlm(entry)}>卸载</button>
                    {:else}
                      <button class="btn-sm outline" onclick={() => handleInstallLlm(entry)}>安装</button>
                    {/if}
                  </div>
                </div>
                <!-- 描述 -->
                <p class="llm-desc">{entry.description}</p>
                <!-- 任务标签 -->
                <div class="llm-tags">
                  {#each entry.tasks as t}
                    <span class="task-tag {taskClass(t)}">{t}</span>
                  {/each}
                </div>
                <!-- 速度 + 中文支持 -->
                <div class="llm-metrics">
                  <div class="metric-row">
                    <span class="metric-label">速度</span>
                    <div class="speed-bar">
                      {#each speedBlocks(entry.speedScore) as filled}
                        <div class="block" class:filled></div>
                      {/each}
                    </div>
                  </div>
                  <div class="metric-row">
                    <span class="metric-label">中文</span>
                    <div class="stars">
                      {#each Array(5) as _, i}
                        <span class:star-empty={i >= entry.chineseStars}>★</span>
                      {/each}
                    </div>
                  </div>
                </div>
              </div>
            {/each}
          </div>

          {#if activeLlmLog && llmLogs[activeLlmLog]?.length}
            <details class="log-panel" open style="margin-top: 8px;">
              <summary>{llmBusy[activeLlmLog] ? "安装中…" : "安装日志"}</summary>
              <pre class="log-output">{llmLogs[activeLlmLog].join("\n")}</pre>
            </details>
          {/if}
          <p class="hint" style="margin-top: 8px;">没有 Ollama？前往 <a href="https://ollama.com" target="_blank">ollama.com</a> 下载安装后重新检测。</p>
        {/if}
      </section>

      <!-- 依赖检查 -->
      <section>
        <h4>依赖状态</h4>
        {#if loadingChecks}
          <p aria-busy="true">检测中…</p>
        {:else}
          <div class="card-list">
            {#each checks as c (c.name)}
              <div class="card-row compact">
                <span class="dep-icon" class:ok={c.ok}>{c.ok ? "✓" : "✗"}</span>
                <div class="card-info">
                  <strong>{c.name}</strong>
                  <small>{c.detail.split("\n")[0]}</small>
                </div>
              </div>
            {/each}
          </div>
          <button class="btn-sm outline secondary" style="margin-top: 8px;" onclick={refreshChecks}>重新检测</button>
        {/if}
      </section>

    {:else if activeTab === "prompts"}
      <section>
        <div class="section-header">
          <h4>提示词模板</h4>
          <button class="btn-sm outline" onclick={startNewPrompt}>+ 新建</button>
        </div>
        <p class="hint">管理标注提示词模板（.md 格式），标注时可选择使用。</p>

        {#if editingPrompt}
          <div class="prompt-editor">
            <input
              type="text"
              placeholder="提示词名称"
              bind:value={editingPrompt.name}
              disabled={!isNewPrompt}
            />
            <textarea
              rows="8"
              placeholder="输入提示词内容（支持 Markdown）…"
              bind:value={editingPrompt.content}
            ></textarea>
            <div class="editor-actions">
              <button class="btn-sm outline secondary" onclick={() => editingPrompt = null}>取消</button>
              <button class="btn-sm" onclick={handleSavePrompt}>保存</button>
            </div>
          </div>
        {/if}

        <div class="card-list">
          {#each prompts as p (p.name)}
            <div class="card-row">
              <div class="card-info">
                <strong>{p.name}</strong>
                <small>{p.preview}</small>
              </div>
              <div class="card-actions">
                <button class="btn-sm outline" onclick={() => startEditPrompt(p)}>编辑</button>
                <button class="btn-sm outline secondary" onclick={() => handleDeletePrompt(p.name)}>删除</button>
              </div>
            </div>
          {/each}
          {#if prompts.length === 0}
            <p class="hint" style="text-align:center; padding:20px;">暂无提示词模板，点击「新建」创建</p>
          {/if}
        </div>
      </section>

    {:else if activeTab === "about"}
      <section class="about">
        <img class="about-logo" src="/src-tauri/icons/icon.png" alt="VeraLabel" />
        <h3>VeraLabel</h3>
        <p class="version">v0.1.0</p>
        <p>本地音频批量标注工具。扫描音频文件，使用 ASR 模型自动转写，导出标注结果。</p>
        <table class="about-table">
          <tbody>
            <tr><td>ASR 后端</td><td>Qwen3-ASR / Parakeet TDT / VibeVoice / Gemma 4</td></tr>
            <tr><td>推理框架</td><td>MLX (Apple Silicon) / Transformers</td></tr>
            <tr><td>输出格式</td><td>JSON / CSV</td></tr>
            <tr><td>技术栈</td><td>Tauri + Svelte + Python (FastAPI)</td></tr>
            <tr><td>开源协议</td><td>MIT</td></tr>
          </tbody>
        </table>
        <p class="about-links">
          <a href="https://huggingface.co/collections/Qwen/qwen3-asr" target="_blank">Qwen3-ASR</a>
          <a href="https://github.com/ml-explore/mlx" target="_blank">MLX</a>
        </p>
      </section>
    {/if}
  </main>
</div>

<style>
  .settings-layout {
    display: flex;
    height: 100vh;
    overflow: hidden;
  }

  /* 左侧导航 */
  .side-nav {
    width: 160px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    padding: 16px 8px;
    background: var(--pico-card-sectioning-background-color);
    border-right: 1px solid var(--pico-muted-border-color);
  }
  .nav-title {
    font-weight: 700;
    font-size: 15px;
    padding: 8px 12px 16px;
  }
  .nav-item {
    all: unset;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    font-size: 13px;
    border-radius: 6px;
    cursor: pointer;
    color: var(--pico-muted-color);
    transition: all 0.15s;
  }
  .nav-item:hover { background: var(--pico-muted-border-color); color: var(--pico-color); }
  .nav-item.active { background: var(--pico-primary-background); color: white; }
  .nav-spacer { flex: 1; }

  /* 右侧内容 */
  .content {
    flex: 1;
    overflow-y: auto;
    padding: 24px 28px;
  }
  section { margin-bottom: 28px; }
  section h4 { margin-bottom: 4px; }
  .section-header { display: flex; align-items: center; justify-content: space-between; }
  .section-header h4 { margin: 0; }
  .hint { font-size: 13px; opacity: 0.6; margin-bottom: 12px; }

  .prompt-editor {
    margin-bottom: 12px;
    padding: 14px;
    background: var(--pico-card-background-color);
    border: 1px solid var(--pico-primary-border);
    border-radius: 8px;
  }
  .prompt-editor input, .prompt-editor textarea {
    margin-bottom: 8px;
    font-size: 13px;
  }
  .prompt-editor textarea {
    font-family: "SF Mono", "Fira Code", monospace;
    font-size: 12px;
    resize: vertical;
  }
  .editor-actions { display: flex; gap: 6px; justify-content: flex-end; }

  /* 卡片列表 */
  .card-list { display: flex; flex-direction: column; gap: 4px; }
  .card-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 14px;
    background: var(--pico-card-background-color);
    border: 1px solid var(--pico-muted-border-color);
    border-radius: 8px;
  }
  .card-row.compact { padding: 8px 14px; }
  .card-info { flex: 1; display: flex; flex-direction: column; gap: 1px; }
  .card-info small { opacity: 0.55; }
  .card-actions { display: flex; gap: 6px; }

  .badge {
    font-size: 12px;
    padding: 2px 10px;
    border-radius: 12px;
    background: var(--pico-muted-border-color);
    white-space: nowrap;
  }
  .badge-ok { background: var(--pico-ins-color, #4ade80); color: white; }

  .dep-icon { font-size: 16px; width: 20px; text-align: center; }
  .dep-icon.ok { color: var(--pico-ins-color, #4ade80); }
  .dep-icon:not(.ok) { color: var(--pico-del-color, #f87171); }

  .btn-sm {
    padding: 5px 14px !important;
    font-size: 13px !important;
    margin: 0 !important;
    width: auto !important;
  }

  .log-panel {
    margin-top: 12px;
    border: 1px solid var(--pico-muted-border-color);
    border-radius: 8px;
  }
  .log-panel summary { padding: 8px 12px; font-size: 13px; cursor: pointer; }
  .log-output {
    max-height: 160px;
    overflow-y: auto;
    margin: 0;
    padding: 8px 12px;
    font-size: 11px;
    line-height: 1.5;
    border-top: 1px solid var(--pico-muted-border-color);
    white-space: pre-wrap;
    word-break: break-all;
    background: #1e1e2e;
    color: #cdd6f4;
    border-radius: 0 0 8px 8px;
  }

  /* LLM 模型卡片 */
  .llm-card {
    position: relative;
    padding: 14px 16px;
    background: var(--pico-card-background-color);
    border: 1px solid var(--pico-muted-border-color);
    border-radius: 10px;
    margin-bottom: 8px;
  }
  .llm-card.llm-recommended {
    border-color: var(--pico-primary-border, #6c8ef5);
  }
  .llm-rec-badge {
    position: absolute;
    top: -1px;
    right: 12px;
    font-size: 11px;
    font-weight: 600;
    padding: 2px 8px;
    background: var(--pico-primary-background);
    color: white;
    border-radius: 0 0 6px 6px;
  }
  .llm-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 6px;
  }
  .llm-title {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .llm-size {
    font-size: 12px;
    opacity: 0.55;
  }
  .llm-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .llm-desc {
    font-size: 12px;
    opacity: 0.7;
    margin: 0 0 8px;
    line-height: 1.5;
  }
  .llm-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-bottom: 10px;
  }
  .task-tag {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 10px;
    font-weight: 500;
  }
  .task-error    { background: #fde8e8; color: #c0392b; }
  .task-diarize  { background: #e8eafd; color: #3a4dc0; }
  .task-summary  { background: #e8f8e8; color: #27ae60; }
  .task-translate{ background: #fef3e2; color: #d68910; }
  .task-split    { background: #e8f5fd; color: #1a78c2; }
  .task-tag      { background: #f3e8fd; color: #7d3fc8; }
  .task-quality  { background: #fde8f5; color: #c0397d; }
  .task-default  { background: var(--pico-muted-border-color); color: var(--pico-muted-color); }

  /* 暗色模式下的任务标签 */
  @media (prefers-color-scheme: dark) {
    .task-error    { background: #4a1c1c; color: #f1948a; }
    .task-diarize  { background: #1c1e4a; color: #a9b7f0; }
    .task-summary  { background: #1c3a1c; color: #7dcea0; }
    .task-translate{ background: #4a3a1c; color: #f0c060; }
    .task-split    { background: #1c334a; color: #7bb8e8; }
    .task-tag      { background: #371c4a; color: #c490e8; }
    .task-quality  { background: #4a1c36; color: #f090c0; }
  }

  .llm-metrics {
    display: flex;
    gap: 20px;
  }
  .metric-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .metric-label {
    font-size: 11px;
    opacity: 0.5;
    width: 26px;
    flex-shrink: 0;
  }
  .speed-bar {
    display: flex;
    gap: 2px;
  }
  .speed-bar .block {
    width: 5px;
    height: 12px;
    border-radius: 2px;
    background: var(--pico-muted-border-color);
  }
  .speed-bar .block.filled {
    background: var(--pico-primary-background);
  }
  .stars {
    display: flex;
    gap: 1px;
    font-size: 13px;
    color: #f5a623;
  }
  .star-empty {
    opacity: 0.2;
  }

  /* 关于 */
  .about { text-align: center; padding-top: 32px; }
  .about-logo {
    width: 64px;
    height: 64px;
    border-radius: 14px;
    margin: 0 auto 12px;
    object-fit: cover;
  }
  .about h3 { margin-bottom: 0; }
  .version { opacity: 0.5; font-size: 13px; margin-bottom: 16px; }
  .about p { font-size: 14px; max-width: 380px; margin: 0 auto 16px; opacity: 0.75; line-height: 1.6; }
  .about-table {
    text-align: left;
    max-width: 380px;
    margin: 0 auto 16px;
    font-size: 13px;
  }
  .about-table td:first-child { opacity: 0.55; padding-right: 16px; white-space: nowrap; }
  .about-links { display: flex; gap: 16px; justify-content: center; }
  .about-links a { font-size: 13px; }
</style>
