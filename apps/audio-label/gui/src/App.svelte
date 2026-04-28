<script lang="ts">
  import FileList from "./components/file-list/FileList.svelte";
  import ConfigBar from "./components/shared/ConfigBar.svelte";
  import SetupWizard from "./views/SetupWizard.svelte";
  import Settings from "./views/Settings.svelte";
  import ResultsView from "./views/ResultsView.svelte";
  import {
    scan,
    startAnnotate,
    pauseAnnotate,
    resumeAnnotate,
    stopAnnotate,
    subscribeProgress,
    health,
    initPort,
    getState,
    saveState,
    listOllamaModels,
    type AudioFileInfo,
    type ProgressEvent,
    type AnnotationResult,
    type OllamaModelsResult,
  } from "./api";

  // App phases
  type Phase = "connecting" | "setup" | "main" | "settings" | "results";

  // 检查是否是独立设置窗口
  const isSettingsWindow = new URLSearchParams(window.location.search).get("page") === "settings";
  let phase = $state<Phase>(isSettingsWindow ? "settings" : "connecting");

  // State
  let dirPath = $state("");
  let files = $state<AudioFileInfo[]>([]);
  let selected = $state(new Set<string>());
  let asrModel = $state("qwen3:0.6B");
  let format = $state("jsonl");
  let llmModel = $state("");
  let selectedSteps = $state<string[]>(["correction", "tagging"]);
  let asrPromptName = $state("");
  let asrPromptContent = $state("");
  let denoise = $state(false);
  let diarize = $state(false);
  let ollamaModels = $state<OllamaModelsResult | null>(null);

  let running = $state(false);
  let isPaused = $state(false);
  let _progressCleanup: (() => void) | null = null;
  let progressCurrent = $state(0);
  let progressTotal = $state(0);
  let statusMessage = $state("");  // 实时状态消息
  let llmWorkers = $state(0);      // 当前 LLM 并发数（load_adjust 事件更新）
  let resultMessage = $state("");
  let annotationResults = $state<AnnotationResult[]>([]);
  let resultOutputPath = $state("");
  let resultOutputDir = $state("");
  let resultTotalFiles = $state(0);
  let resultSuccessCount = $state(0);


  let serverError = $state("");

  // 启动时连接 Python API 服务
  async function connectServer() {
    try {
      const p = await initPort();

      // 等待 Python 服务就绪（最多 15 秒）
      for (let i = 0; i < 30; i++) {
        try {
          const res = await health();
          // 并行获取 Ollama 模型列表
          listOllamaModels().then(r => ollamaModels = r).catch(() => {});
          phase = "setup";
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      serverError = `Python API 服务启动超时 (端口 ${p})`;
    } catch (e) {
      serverError = `无法连接到 Python API 服务：${e}`;
    }
  }

  // mount
  $effect(() => {
    if (isSettingsWindow) {
      // 设置窗口：只需连接 API
      initPort().then(() => { /* Settings 组件自己会调 API */ });
    } else {
      connectServer();
    }
  });

  async function onSetupReady() {
    phase = "main";
    // 恢复上次选择的目录
    try {
      const state = await getState();
      if (state.lastDir) {
        dirPath = state.lastDir;
        files = await scan([dirPath]);
        selected = new Set(files.map((f) => f.path));
      }
    } catch { /* ignore */ }
  }

  async function openSettings() {
    if (window.__TAURI_INTERNALS__) {
      const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      const w = new WebviewWindow("settings", {
        url: window.location.origin + "/?page=settings",
        title: "设置 - VeraLabel",
        width: 780,
        height: 680,
        minWidth: 680,
        minHeight: 560,
        center: true,
        resizable: true,
      });
      await w.once("tauri://error", (e) => console.error(e));
    } else {
      window.open("/?page=settings", "_blank", "width=780,height=680");
    }
  }

  async function handleSelectDir() {
    // 使用 Tauri 原生文件夹选择对话框
    try {
      if (window.__TAURI_INTERNALS__) {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const selected_path = await open({
          directory: true,
          multiple: false,
          title: "选择音频文件目录",
        });
        if (!selected_path) return;
        dirPath = selected_path as string;
      } else {
        const path = prompt("输入音频文件目录路径：", dirPath || ".");
        if (!path) return;
        dirPath = path;
      }
    } catch {
      // fallback to prompt
      const path = prompt("输入音频文件目录路径：", dirPath || ".");
      if (!path) return;
      dirPath = path;
    }

    try {
      files = await scan([dirPath]);
      selected = new Set(files.map((f) => f.path));
      resultMessage = "";
      saveState("lastDir", dirPath);
    } catch (e) {
      resultMessage = `扫描失败：${e}`;
    }
  }

  function toggleFile(path: string) {
    const next = new Set(selected);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    selected = next;
  }

  function toggleAll() {
    if (selected.size === files.length) {
      selected = new Set();
    } else {
      selected = new Set(files.map((f) => f.path));
    }
  }

  async function handleStart() {
    if (selected.size === 0) return;
    running = true;
    progressCurrent = 0;
    progressTotal = selected.size;
    annotationResults = [];
    resultOutputDir = "";
    resultTotalFiles = selected.size;
    resultSuccessCount = 0;
    resultMessage = "";
    llmWorkers = 0;

    // 立即进入结果页，边标注边看
    phase = "results";

    try {
      // 解析 asrModel 为 backend + model_size
      let backendStr: string;
      let modelSize: string;
      if (asrModel.startsWith("ollama:")) {
        backendStr = asrModel; // 整个字符串作为 backend
        modelSize = "";
      } else {
        const parts = asrModel.split(":");
        backendStr = parts[0];
        modelSize = parts[1] || "0.6B";
      }

      await startAnnotate({
        files: Array.from(selected),
        backend: backendStr,
        model_size: modelSize,
        format,
        prompt: asrPromptContent || undefined,
        denoise: denoise || undefined,
        diarize: diarize || undefined,
      });

      _progressCleanup = subscribeProgress((ev: ProgressEvent) => {
        // 捕获日志消息作为状态
        if (ev.event === "log") {
          statusMessage = (ev as any).message ?? "";
        } else if (ev.event === "loading_model") {
          statusMessage = "正在加载模型…";
        } else if (ev.event === "model_ready") {
          statusMessage = "模型就绪，开始转写";
        } else if (ev.event === "progress") {
          progressCurrent = ev.current ?? 0;
          statusMessage = `转写中：${ev.file ?? ""}`;
        } else if (ev.event === "file_done") {
          progressCurrent = ev.current ?? 0;
          statusMessage = `已完成：${ev.file ?? ""}`;
          const result = (ev as any).result;
          if (result) {
            annotationResults = [...annotationResults, result];
            resultSuccessCount = annotationResults.length;
          }
        } else if (ev.event === "file_error") {
          progressCurrent = ev.current ?? 0;
          statusMessage = `失败：${ev.file ?? ""}`;
        } else if (ev.event === "asr_start") {
          statusMessage = `正在转写 ${ev.file ?? ""}`;
        } else if (ev.event === "asr_done") {
          statusMessage = `ASR 完成 ${ev.file ?? ""} (${ev.elapsed ?? 0}s)`;
        } else if (ev.event === "llm_start") {
          statusMessage = `LLM 处理 ${ev.file ?? ""} · ${ev.step ?? ""}`;
        } else if (ev.event === "llm_done") {
          statusMessage = `LLM 完成 ${ev.file ?? ""}`;
        } else if (ev.event === "load_adjust") {
          llmWorkers = ev.llm_workers ?? llmWorkers;
          statusMessage = `并发调整 → LLM ×${ev.llm_workers} (${ev.reason ?? ""})`;
        } else if (ev.event === "pipeline_start") {
          llmWorkers = ev.llm_workers ?? 0;
          statusMessage = `流水线启动：ASR ×1, LLM ×${ev.llm_workers}`;
        } else if (ev.event === "paused") {
          isPaused = true;
          statusMessage = "已暂停";
        } else if (ev.event === "resumed") {
          isPaused = false;
          statusMessage = "继续转写…";
        } else if (ev.event === "stopped") {
          running = false;
          isPaused = false;
          llmWorkers = 0;
          statusMessage = "已停止";
          _progressCleanup?.(); _progressCleanup = null;
        } else if (ev.event === "done") {
          running = false;
          isPaused = false;
          llmWorkers = 0;
          statusMessage = "标注完成";
          resultOutputDir = ev.output_dir ?? "";
          resultTotalFiles = ev.total_files ?? 0;
          resultSuccessCount = ev.success ?? 0;
          _progressCleanup?.(); _progressCleanup = null;
        } else if (ev.event === "error") {
          running = false;
          llmWorkers = 0;
          resultMessage = `错误：${ev.message}`;
          _progressCleanup?.(); _progressCleanup = null;
          if (annotationResults.length === 0) phase = "main";
        }
      });
    } catch (e) {
      running = false;
      resultMessage = `启动失败：${e}`;
      phase = "main";
    }
  }
</script>

<main class="container-fluid">
  {#if phase === "connecting"}
    <div class="center-msg">
      {#if serverError}
        <p class="error">{serverError}</p>
      {:else}
        <p aria-busy="true">正在连接 Python API 服务…</p>
      {/if}
    </div>

  {:else if phase === "setup"}
    <SetupWizard onReady={onSetupReady} />

  {:else if phase === "settings"}
    <Settings onBack={async () => {
      if (isSettingsWindow && window.__TAURI_INTERNALS__) {
        const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
        getCurrentWebviewWindow().close();
      } else {
        phase = "main";
      }
    }} />

  {:else if phase === "results"}
    <ResultsView
      allFiles={Array.from(selected)}
      results={annotationResults}
      outputDir={resultOutputDir}
      totalFiles={resultTotalFiles}
      successCount={resultSuccessCount}
      isAnnotating={running}
      {isPaused}
      progress={progressCurrent}
      {statusMessage}
      {llmModel}
      {selectedSteps}
      {llmWorkers}
      onPause={pauseAnnotate}
      onResume={resumeAnnotate}
      onStop={stopAnnotate}
      onBack={() => { phase = "main"; running = false; isPaused = false; _progressCleanup?.(); _progressCleanup = null; }}
    />

  {:else}
    <!-- 顶部工具栏 -->
    <div class="toolbar">
      <button class="outline" onclick={handleSelectDir} disabled={running}>选择目录</button>
      <small class="dir-path">{dirPath || "未选择目录"}</small>
      <div class="spacer"></div>
      <button class="outline secondary settings-btn" onclick={openSettings} disabled={running} title="设置">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
        </svg>
      </button>
    </div>

    {#if !running}
      <!-- 文件列表 -->
      <FileList {files} {selected} onToggle={toggleFile} onToggleAll={toggleAll} />

      <!-- 配置栏 -->
      <ConfigBar
        {asrModel}
        {format}
        {llmModel}
        {selectedSteps}
        {asrPromptName}
        disabled={running}
        {ollamaModels}
        onAsrModelChange={(v) => (asrModel = v)}
        onFormatChange={(v) => (format = v)}
        onLlmModelChange={(v) => (llmModel = v)}
        onSelectedStepsChange={(v) => (selectedSteps = v)}
        onAsrPromptChange={(name, content) => { asrPromptName = name; asrPromptContent = content; }}
      />
    {/if}

    <!-- 底部操作栏 -->
    <div class="actions">
      {#if resultMessage}
        <small class="result" class:error={resultMessage.startsWith("错误")}>{resultMessage}</small>
      {/if}
      <button
        onclick={handleStart}
        disabled={running || selected.size === 0}
        aria-busy={running}
      >
        {running ? "标注中…" : `开始标注 (${selected.size})`}
      </button>
    </div>
  {/if}
</main>

<style>
  main {
    display: flex;
    flex-direction: column;
    height: 100vh;
    padding: 12px 20px;
    gap: 8px;
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .toolbar button {
    width: auto;
    margin: 0;
    padding: 8px 18px;
  }
  .settings-btn {
    padding: 7px 10px !important;
    display: flex;
    align-items: center;
  }
  .spacer { flex: 1; }
  .dir-path {
    opacity: 0.6;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 12px;
    padding: 4px 0;
  }
  .actions button {
    width: auto;
    margin: 0;
    padding: 10px 24px;
  }
  .result {
    flex: 1;
    color: var(--pico-primary);
  }
  .result.error {
    color: var(--pico-del-color);
  }
  .center-msg {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100vh;
  }
  .center-msg .error {
    color: var(--pico-del-color);
    max-width: 500px;
    text-align: center;
  }
  .running-panel {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 20px;
    background: var(--pico-card-background-color);
    border: 1px solid var(--pico-muted-border-color);
    border-radius: var(--pico-border-radius);
    overflow: hidden;
  }

  /* Step indicator */
  .steps {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0;
    padding: 8px 0;
  }
  .step {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    opacity: 0.4;
    transition: opacity 0.3s;
  }
  .step.active { opacity: 1; font-weight: 600; }
  .step.done { opacity: 0.7; }
  .step-dot {
    width: 24px;
    height: 24px;
    line-height: 24px;
    text-align: center;
    border-radius: 50%;
    font-size: 12px;
    background: var(--pico-muted-border-color);
    color: var(--pico-muted-color);
  }
  .step.active .step-dot {
    background: var(--pico-primary-background);
    color: white;
  }
  .step.done .step-dot {
    background: var(--pico-ins-color, #4ade80);
    color: white;
  }
  .step-line {
    width: 40px;
    height: 2px;
    background: var(--pico-muted-border-color);
    margin: 0 8px;
  }

  /* Progress */
  .prog-section { padding: 0 4px; }
  .prog-bar-track {
    height: 8px;
    background: var(--pico-muted-border-color);
    border-radius: 4px;
    overflow: hidden;
  }
  .prog-bar-fill {
    height: 100%;
    background: var(--pico-primary-background);
    border-radius: 4px;
    transition: width 0.4s ease;
  }
  .prog-info {
    display: flex;
    justify-content: space-between;
    font-size: 13px;
    margin-top: 6px;
  }
  .prog-file {
    opacity: 0.6;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Log area */
  .log-area {
    flex: 1;
    min-height: 120px;
    overflow-y: auto;
    background: #1e1e2e;
    color: #cdd6f4;
    border-radius: 6px;
    padding: 10px 14px;
    font-family: "SF Mono", "Fira Code", "Consolas", monospace;
    font-size: 12px;
    line-height: 1.6;
  }
  .log-line {
    white-space: pre-wrap;
    word-break: break-all;
  }
</style>
