<script lang="ts">
  import type { AnnotationResult, LabelResultData } from "../../api";
  import { FileAudio, Check } from "lucide-svelte";

  interface Props {
    allFiles: string[];
    results: AnnotationResult[];
    selectedIdx: number;
    completedFiles: Set<string>;
    aiLabels: Record<string, LabelResultData[]>;
    labelingFile: string | null;
    isAnnotating: boolean;
    processingIdx: number;
    onFileSelect: (idx: number) => void;
  }
  let {
    allFiles,
    results,
    selectedIdx,
    completedFiles,
    aiLabels,
    labelingFile,
    isAnnotating,
    processingIdx,
    onFileSelect,
  }: Props = $props();

  let searchQuery = $state("");
  type FilterMode = "all" | "done" | "pending" | "low-conf" | "labeled";
  let filterMode = $state<FilterMode>("all");

  let filteredFiles = $derived(() => {
    const q = searchQuery.trim().toLowerCase();
    return allFiles.filter((filePath) => {
      const r = results.find(r => r.file === filePath);
      const isDone = completedFiles.has(filePath);
      if (q) {
        const nameMatch = filePath.toLowerCase().includes(q);
        const textMatch = r?.text?.toLowerCase().includes(q) ?? false;
        if (!nameMatch && !textMatch) return false;
      }
      switch (filterMode) {
        case "done":    return isDone;
        case "pending": return !isDone;
        case "labeled": return !!(aiLabels[filePath]?.length);
        case "low-conf": {
          const labels = aiLabels[filePath];
          if (!labels?.length) return false;
          const overalls = labels.map(l => l.label_confidence?.overall).filter(v => v != null) as number[];
          return overalls.some(v => v < 0.7);
        }
        default: return true;
      }
    });
  });

  function fileName(p: string): string { return p.split("/").pop() || p; }
  function fmtTime(sec: number): string {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  }
  function fmtRate(r: number | null): string { return r ? `${(r / 1000).toFixed(1)}kHz` : ""; }
</script>

<div class="file-panel">
  <div class="panel-label">文件列表</div>
  <div class="file-search-bar">
    <input
      class="file-search-input"
      type="search"
      placeholder="搜索文件名或转写内容…"
      bind:value={searchQuery}
    />
    <select class="filter-select" bind:value={filterMode}>
      <option value="all">全部</option>
      <option value="done">已完成</option>
      <option value="pending">待转写</option>
      <option value="labeled">已 AI 标注</option>
      <option value="low-conf">低置信度</option>
    </select>
  </div>
  <div class="file-list">
    {#if filteredFiles().length === 0}
      <div class="file-empty">无匹配文件</div>
    {:else}
      {#each filteredFiles() as filePath (filePath)}
        {@const idx = allFiles.indexOf(filePath)}
        {@const isDone = completedFiles.has(filePath)}
        {@const isProcessing = isAnnotating && idx === processingIdx}
        {@const r = results.find(r => r.file === filePath)}
        {@const labels = aiLabels[filePath]}
        {@const lowConf = labels?.some(l => (l.label_confidence?.overall ?? 1) < 0.7)}
        <button
          class="file-item"
          class:active={idx === selectedIdx}
          class:done={isDone}
          class:processing={isProcessing}
          class:low-conf={lowConf}
          onclick={() => onFileSelect(idx)}
        >
          <FileAudio size={14} />
          <div class="file-info">
            <span class="fname">{fileName(filePath)}</span>
            <small class="file-meta">
              {#if r}
                {r.duration_sec ? fmtTime(r.duration_sec) : "--:--"}
                {#if r.sample_rate} · {fmtRate(r.sample_rate)}{/if}
                {#if r.language} · {r.language}{/if}
                {#if labelingFile === filePath}
                  · <span class="ai-status labeling">AI↻</span>
                {:else if aiLabels[filePath]?.length}
                  · <span class="ai-status labeled" class:low={lowConf}>AI{lowConf ? "⚠" : "✓"}</span>
                {/if}
              {:else}
                等待中
              {/if}
            </small>
          </div>
          {#if isDone}
            <Check size={14} class="chk" />
          {:else if isProcessing}
            <span class="spinner-sm"></span>
          {:else}
            <span class="status-dot"></span>
          {/if}
        </button>
      {/each}
    {/if}
  </div>
  {#if searchQuery || filterMode !== "all"}
    <div class="filter-summary">{filteredFiles().length} / {allFiles.length} 个文件</div>
  {/if}
</div>

<style>
  .file-panel { width: 280px; flex-shrink: 0; border-right: 1px solid var(--pico-muted-border-color); display: flex; flex-direction: column; background: var(--pico-card-background-color); }
  .panel-label { padding: 10px 14px 6px; font-size: 11px; font-weight: 700; opacity: 0.4; text-transform: uppercase; letter-spacing: 0.5px; }
  .file-search-bar { display: flex; gap: 4px; padding: 4px 6px; }
  .file-search-input { flex: 1; min-width: 0; font-size: 12px; padding: 4px 8px; margin: 0; border: 1px solid var(--pico-muted-border-color); border-radius: 6px; background: var(--pico-background-color); }
  .filter-select { font-size: 11px; padding: 4px 4px; margin: 0; border-radius: 6px; width: auto; }
  .file-empty { padding: 20px; text-align: center; font-size: 12px; opacity: 0.4; }
  .filter-summary { padding: 4px 10px 6px; font-size: 11px; opacity: 0.45; text-align: right; }
  .file-list { flex: 1; overflow-y: auto; padding: 0 6px 6px; }
  .file-item { all: unset; display: flex; align-items: center; gap: 8px; padding: 7px 10px; border-radius: 6px; cursor: pointer; width: 100%; box-sizing: border-box; }
  .file-item:hover { background: var(--pico-card-sectioning-background-color); }
  .file-item.active { background: rgba(74,158,255,0.08); border-left: 3px solid var(--pico-primary); }
  .file-item.processing { opacity: 0.7; }
  .file-item.low-conf { border-left: 3px solid var(--pico-del-color, #f87171); }
  .spinner-sm { display: inline-block; width: 12px; height: 12px; border: 2px solid var(--pico-muted-border-color); border-top-color: var(--pico-primary); border-radius: 50%; animation: spin 0.8s linear infinite; flex-shrink: 0; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .status-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--pico-muted-border-color); flex-shrink: 0; }
  .file-info { flex: 1; min-width: 0; }
  .fname { display: block; font-size: 12px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .file-info small { opacity: 0.5; font-size: 10px; }
  .file-meta { display: block; }
  .ai-status { font-weight: 600; }
  .ai-status.labeled { color: var(--pico-ins-color, #4ade80); }
  .ai-status.labeled.low { color: var(--pico-del-color, #f87171); }
  .ai-status.labeling { color: var(--pico-primary); }
  :global(.chk) { color: var(--pico-ins-color, #4ade80); }
</style>
