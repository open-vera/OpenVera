<script lang="ts">
  import type { AnnotationResult, ManualAnnotation, LabelResultData } from "../api";
  import { audioUrl, saveAnnotations, labelFile, calculateCer, saveCorrections, saveLabelCorrection, BUILT_IN_STEPS } from "../api";
  import WaveSurfer from "wavesurfer.js";
  import SpectrogramPlugin from "wavesurfer.js/dist/plugins/spectrogram.js";
  import RegionsPlugin from "wavesurfer.js/dist/plugins/regions.js";
  import AIAnnotationPanel from "../components/annotation/AIAnnotationPanel.svelte";
  import StatusBar from "../components/shared/StatusBar.svelte";
  import FileListPanel from "../components/file-list/FileListPanel.svelte";
  import { Play, Pause, SkipBack, SkipForward, Volume2, Check, ArrowLeft, ZoomIn, ZoomOut, Maximize2, PenTool } from "lucide-svelte";

  interface Props {
    allFiles: string[];
    results: AnnotationResult[];
    outputDir: string;
    totalFiles: number;
    successCount: number;
    isAnnotating: boolean;
    isPaused: boolean;
    progress: number;
    statusMessage: string;
    llmModel: string;
    selectedSteps: string[];
    llmWorkers?: number;
    onPause: () => void;
    onResume: () => void;
    onStop: () => void;
    onBack: () => void;
  }
  let { allFiles, results, outputDir, totalFiles, successCount, isAnnotating, isPaused, progress, statusMessage, llmModel, selectedSteps, llmWorkers = 0, onPause, onResume, onStop, onBack }: Props = $props();

  let selectedIdx = $state(0);
  let isPlaying = $state(false);
  let currentTime = $state(0);
  let duration = $state(0);
  let playbackRate = $state(1.0);
  let volume = $state(0.8);
  let wsReady = $state(false);
  let zoomLevel = $state(0);
  let drawMode = $state(false);
  let dragSelectionCleanup: (() => void) | null = null;

  // 手动标注
  let manualAnnotations = $state<Record<string, ManualAnnotation[]>>({});
  let editingAnnIdx = $state(-1);

  // 转写纠错 & CER
  // editingSegIdx: 当前正在编辑的 segment 索引（-1 表示无）
  // segCorrections: file → {segIdx → {corrected, cer}}
  let editingSegIdx = $state(-1);
  let segCorrections = $state<Record<string, Record<number, { corrected: string; cer: number | null }>>>({});

  let waveRef: HTMLDivElement;
  let spectroRef: HTMLDivElement;
  let ws: WaveSurfer | null = null;
  let regions: any = null;
  let _spectro: any = null;         // 保存 spectro 引用以便销毁
  let _wheelAbort: AbortController | null = null;  // wheel 监听去重

  let current = $derived(results.find(r => r.file === allFiles[selectedIdx]) || null);
  let currentFile = $derived(current?.file ?? allFiles[selectedIdx] ?? "");
  let currentAnns = $derived(currentFile ? (manualAnnotations[currentFile] || []) : []);
  let hasAnyAnns = $derived(Object.values(manualAnnotations).some(a => a.length > 0));

  // 每个文件的完成状态
  let completedFiles = $derived(new Set(results.map(r => r.file)));
  // 当前正在处理的文件索引（进度数）
  let processingIdx = $derived(progress);
  // 当前选中的文件是否正在转写中（或排队等待中）
  let isSelectedPending = $derived(!current && isAnnotating);

  // AI 标注状态
  let aiLabels = $state<Record<string, LabelResultData[]>>({});
  let labelingFile = $state<string | null>(null);
  let currentAiLabels = $derived(currentFile ? (aiLabels[currentFile] || []) : []);
  let isCurrentLabeling = $derived(labelingFile === currentFile);

  // AI 标签人工确认/纠错状态  key: filePath → Record<labelKey, VerifRecord>
  interface VerifRecord { status: "confirmed" | "corrected"; humanResult: string; }
  let verifications = $state<Record<string, Record<string, VerifRecord>>>({});
  let currentVerifications = $derived(currentFile ? (verifications[currentFile] || {}) : {});

  async function handleVerify(
    labelKey: string,
    status: "confirmed" | "corrected",
    aiResult: string,
    humanResult: string,
    promptName: string,
    model: string,
  ) {
    if (!currentFile || !outputDir) return;
    // 更新本地状态
    verifications = {
      ...verifications,
      [currentFile]: { ...(verifications[currentFile] || {}), [labelKey]: { status, humanResult } },
    };
    // 持久化到后端
    saveLabelCorrection({
      output_dir: outputDir,
      file: currentFile,
      prompt_name: promptName,
      model,
      ai_result: aiResult,
      human_result: humanResult,
      status,
    }).catch(e => console.error("saveLabelCorrection failed:", e));
  }

  // 批量 AI 标注状态
  let batchLabelProgress = $state(0);
  let batchLabelTotal = $state(0);
  let isBatchLabeling = $derived(batchLabelTotal > 0 && batchLabelProgress < batchLabelTotal);
  let batchLabelCancelled = $state(false);

  // ── 文件列表搜索 & 筛选 — state owned by FileListPanel ──
  // ASR 完成后自动触发 LLM 批量标注
  let _asrWasRunning = $state(false);
  $effect(() => {
    if (isAnnotating) {
      _asrWasRunning = true;
    } else if (_asrWasRunning && results.length > 0 && llmModel && selectedSteps.length > 0) {
      _asrWasRunning = false;
      runBatchLabel();
    } else if (!isAnnotating) {
      _asrWasRunning = false;
    }
  });

  async function labelOne(file: string): Promise<void> {
    const r = results.find(r => r.file === file);
    if (!r || !llmModel || selectedSteps.length === 0) return;
    labelingFile = file;
    try {
      const mergedContent = selectedSteps
        .map(id => BUILT_IN_STEPS.find(s => s.id === id)?.prompt ?? "")
        .filter(Boolean)
        .join("\n\n");
      const promptNames = selectedSteps.join("+");
      const res = await labelFile({
        file: r.file,
        text: r.text,
        segments: r.segments,
        prompt_name: promptNames,
        prompt_content: mergedContent,
        model: llmModel,
      });
      if (res.ok && res.label) {
        aiLabels = { ...aiLabels, [r.file]: [res.label] };
      }
    } catch (e) {
      console.error("AI label failed:", e);
    } finally {
      labelingFile = null;
    }
  }

  async function runBatchLabel() {
    if (!llmModel || selectedSteps.length === 0 || isBatchLabeling) return;
    const toLabel = results.map(r => r.file);
    batchLabelTotal = toLabel.length;
    batchLabelProgress = 0;
    batchLabelCancelled = false;
    for (const file of toLabel) {
      if (batchLabelCancelled) break;
      await labelOne(file);
      batchLabelProgress += 1;
    }
    batchLabelTotal = 0;
    batchLabelProgress = 0;
    batchLabelCancelled = false;
  }

  async function runLabel() {
    if (!current) return;
    await labelOne(current.file);
  }

  function fileName(p: string): string { return p.split("/").pop() || p; }
  function fmtTime(sec: number): string {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  }
  function fmtRate(r: number | null): string { return r ? `${(r/1000).toFixed(1)}kHz` : ""; }
  function fmtCh(c: number | null): string { return c === 1 ? "单声道" : c === 2 ? "立体声" : c ? `${c}ch` : ""; }

  function activeSegIdx(): number {
    if (!current || !isPlaying) return -1;
    for (let i = current.segments.length - 1; i >= 0; i--) {
      if (currentTime >= current.segments[i].start) return i;
    }
    return -1;
  }

  function initWaveSurfer() {
    if (ws) ws.destroy();
    if (_spectro) { try { (_spectro as any).destroy?.(); } catch (_) {} _spectro = null; }
    regions = RegionsPlugin.create();
    _spectro = SpectrogramPlugin.create({ labels: false, height: 64, splitChannels: false });

    ws = WaveSurfer.create({
      container: waveRef,
      waveColor: "rgba(74,158,255,0.35)",
      progressColor: "rgba(74,158,255,0.85)",
      cursorColor: "#2563eb",
      cursorWidth: 2,
      height: 100,
      barWidth: 2, barGap: 1, barRadius: 2,
      normalize: true,
      minPxPerSec: 1,
      autoScroll: true,
      autoCenter: true,
      plugins: [regions, _spectro],
    });

    // SpectrogramPlugin.onInit() always appends inside wavesurfer's wrapper,
    // ignoring the container option. Move it to the dedicated spectroRef container.
    if ((_spectro as any).wrapper && spectroRef) {
      spectroRef.appendChild((_spectro as any).wrapper);
    }

    ws.on("ready", () => { duration = ws!.getDuration(); wsReady = true; renderRegions(); });
    ws.on("timeupdate", (t: number) => { currentTime = t; scrollToActive(); });
    ws.on("play", () => { isPlaying = true; });
    ws.on("pause", () => { isPlaying = false; });
    ws.on("finish", () => { isPlaying = false; });

    regions.on("region-created", onRegionCreated);

    // 鼠标滚轮缩放（使用 AbortController 保证只注册一次，可随时移除）
    _wheelAbort?.abort();
    _wheelAbort = new AbortController();
    waveRef.addEventListener("wheel", (e: WheelEvent) => {
      e.preventDefault();
      zoomBy(e.deltaY > 0 ? -10 : 10);
    }, { passive: false, signal: _wheelAbort.signal });
  }

  function renderRegions() {
    if (!regions) return;
    const wasDrawMode = drawMode;
    drawMode = false; // 暂停，避免程序添加的 region 触发标注

    regions.clearRegions();
    // ASR segments
    if (current?.segments.length && duration > 0) {
      const colors = ["rgba(74,190,130,0.1)","rgba(74,158,255,0.1)","rgba(255,170,74,0.1)","rgba(180,130,255,0.1)"];
      current.segments.forEach((seg, i) => {
        regions.addRegion({ start: seg.start, end: seg.end, color: colors[i % colors.length], drag: false, resize: false });
      });
    }
    // 手动标注区域
    currentAnns.forEach((ann) => {
      regions.addRegion({ start: ann.start, end: ann.end, color: "rgba(255,100,100,0.2)", drag: true, resize: true });
    });

    drawMode = wasDrawMode;
  }

  function onRegionCreated(region: any) {
    if (!drawMode) return;

    // current 依赖 results，文件可能还没出结果 → 用 allFiles 兜底
    const file = current?.file ?? allFiles[selectedIdx];
    if (!file) return;

    const ann: ManualAnnotation = { start: +region.start.toFixed(2), end: +region.end.toFixed(2), value: "" };
    const arr = [...(manualAnnotations[file] || []), ann];
    manualAnnotations = { ...manualAnnotations, [file]: arr };
    editingAnnIdx = arr.length - 1;
    persistAnnotations(file);
  }

  function toggleDrawMode() {
    drawMode = !drawMode;
    if (!regions) return;

    if (drawMode) {
      const ret = regions.enableDragSelection({ color: "rgba(255,100,100,0.25)" });
      dragSelectionCleanup = typeof ret === "function" ? ret : null;
    } else {
      if (dragSelectionCleanup && typeof dragSelectionCleanup === "function") {
        dragSelectionCleanup();
      }
      dragSelectionCleanup = null;
      if (ws) {
        const oldRegions = regions;
        regions = RegionsPlugin.create();
        ws.registerPlugin(regions);
        oldRegions.destroy();
        renderRegions();
        regions.on("region-created", onRegionCreated);
      }
    }
  }

  function loadFile(idx: number) {
    const filePath = allFiles[idx];
    if (!filePath) return;

    drawMode = false;
    dragSelectionCleanup = null;
    selectedIdx = idx;
    wsReady = false; currentTime = 0; duration = 0; isPlaying = false; editingAnnIdx = -1;
    initWaveSurfer();
    ws!.load(audioUrl(filePath));
    ws!.setVolume(volume);
    ws!.setPlaybackRate(playbackRate);
    ws!.once("ready", () => { ws!.play(); });
  }

  $effect(() => {
    // 组件挂载后立即加载第一个音频，不等待 ASR 结果
    if (waveRef && allFiles.length > 0 && !ws) {
      selectedIdx = 0;
      initWaveSurfer();
      ws!.load(audioUrl(allFiles[0]));
      ws!.setVolume(volume);
      ws!.once("ready", () => { ws!.play(); });
    }
    // 返回 cleanup：组件卸载时销毁 WaveSurfer、SpectrogramPlugin、wheel 监听
    return () => {
      _wheelAbort?.abort(); _wheelAbort = null;
      if (_spectro) { try { (_spectro as any).destroy?.(); } catch (_) {} _spectro = null; }
      if (ws) { ws.destroy(); ws = null; }
    };
  });

  function togglePlay() { ws?.playPause(); }
  function skip(sec: number) { if (ws) ws.setTime(Math.max(0, Math.min(currentTime + sec, duration))); }
  function seekTo(e: MouseEvent) { if (!ws || !duration) return; const pct = (e.clientX - (e.currentTarget as HTMLElement).getBoundingClientRect().left) / (e.currentTarget as HTMLElement).clientWidth; ws.setTime(pct * duration); }
  function setSpeed(r: number) { playbackRate = r; ws?.setPlaybackRate(r); }
  function setVol(v: number) { volume = v; ws?.setVolume(v); }
  function zoomBy(d: number) { zoomLevel = Math.max(0, zoomLevel + d); ws?.zoom(zoomLevel); }
  function jumpToSeg(i: number) { if (!ws || !current) return; ws.setTime(current.segments[i]?.start ?? 0); if (!isPlaying) ws.play(); }
  function scrollToActive() { const i = activeSegIdx(); if (i >= 0) document.getElementById(`seg-${i}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }

  function wordsInRange(start: number, end: number) {
    if (!current?.words) return [];
    return current.words.filter(w => w.start >= start - 0.01 && w.end <= end + 0.01);
  }

  /** 将 segment 的分词文本与 words 时间对齐，返回词级别的高亮数据 */
  function segTokens(seg: { start: number; end: number; text: string }) {
    const words = wordsInRange(seg.start, seg.end);
    if (words.length) {
      // 有逐字数据，直接使用 word 级时间戳
      return words;
    }
    // 没有逐字数据，按空格拆分，均匀分配时间
    const tokens = seg.text.split(/\s+/).filter(Boolean);
    const dur = seg.end - seg.start;
    return tokens.map((t, i) => ({
      text: t,
      start: seg.start + (dur / tokens.length) * i,
      end: seg.start + (dur / tokens.length) * (i + 1),
    }));
  }

  function updateAnnValue(idx: number, value: string) {
    if (!current) return;
    if (!manualAnnotations[current.file]) return;
    manualAnnotations[current.file][idx].value = value;
    persistAnnotations(current.file);
  }

  function removeAnn(idx: number) {
    if (!current) return;
    if (!manualAnnotations[current.file]) return;
    manualAnnotations[current.file].splice(idx, 1);
    editingAnnIdx = -1;
    persistAnnotations(current.file);
    renderRegions();
  }

  async function persistAnnotations(file: string) {
    await saveAnnotations(outputDir, file, manualAnnotations[file] || []);
  }

  // ── 转写纠错 & CER ───────────────────────────────────

  function startSegEdit(idx: number) {
    editingSegIdx = idx;
  }

  function cancelSegEdit() {
    editingSegIdx = -1;
  }

  async function commitSegEdit(segIdx: number, original: string, corrected: string) {
    editingSegIdx = -1;
    if (!current || corrected === original) return;
    let cer: number | null = null;
    try {
      const res = await calculateCer(original, corrected);
      cer = res.cer;
    } catch (_) { /* CER API 失败不影响保存 */ }

    const file = current.file;
    segCorrections = {
      ...segCorrections,
      [file]: { ...(segCorrections[file] || {}), [segIdx]: { corrected, cer } },
    };

    // 异步保存修正记录到 corrections.jsonl
    const seg = current.segments[segIdx];
    saveCorrections(outputDir, file, [{
      seg_start: seg.start,
      seg_end: seg.end,
      original,
      corrected,
    }]).catch(() => {});
  }
</script>

<div class="view">
  <!-- 顶栏 -->
  <div class="top-bar">
    <button class="outline secondary btn-sm" onclick={onBack}><ArrowLeft size={14} /> 返回</button>
    <strong>标注结果</strong>
    {#if isAnnotating}
      {#if isPaused}
        <button class="btn-sm btn-ctrl btn-resume" onclick={onResume}>▶ 继续</button>
      {:else}
        <button class="btn-sm btn-ctrl btn-pause" onclick={onPause}>⏸ 暂停</button>
      {/if}
      <button class="btn-sm btn-ctrl btn-stop" onclick={onStop}>⏹ 结束</button>
    {/if}
    <div class="top-spacer"></div>
    {#if isAnnotating && statusMessage}
      <small class="top-status-msg" title={statusMessage}>{statusMessage}</small>
    {/if}
    <StatusBar visible={isAnnotating} {statusMessage} {llmWorkers} />
    <div class="top-progress">
      {#if isAnnotating}
        <div class="mini-bar"><div class="mini-fill" style="width:{totalFiles > 0 ? (progress / totalFiles) * 100 : 0}%"></div></div>
      {/if}
      <small>{successCount}/{totalFiles} 完成{#if isAnnotating} <span class="spinner"></span>{/if}</small>
    </div>
  </div>

  <!-- 上部：文件列表 + 转写 + 手动标注 -->
  <div class="content-row">
    <FileListPanel
      {allFiles}
      {results}
      {selectedIdx}
      {completedFiles}
      {aiLabels}
      {labelingFile}
      {isAnnotating}
      {processingIdx}
      onFileSelect={loadFile}
    />

    <div class="transcript-panel">
      <div class="panel-label">转写内容</div>
      <div class="transcript-list">
        {#if current?.segments.length}
          {#each current.segments as seg, i}
            {@const tokens = segTokens(seg)}
            {@const correction = segCorrections[currentFile]?.[i]}
            <div id="seg-{i}" class="seg-card" class:active={isPlaying && i === activeSegIdx()}>
              <small class="seg-ts">{fmtTime(seg.start)}</small>
              {#if editingSegIdx === i}
                <textarea
                  class="seg-edit"
                  rows="2"
                  value={correction?.corrected ?? seg.text}
                  onkeydown={(e) => { if (e.key === "Escape") cancelSegEdit(); }}
                  onblur={(e) => commitSegEdit(i, seg.text, (e.target as HTMLTextAreaElement).value.trim())}
                ></textarea>
              {:else}
                <span class="seg-body" tabindex="0" onclick={() => jumpToSeg(i)} onkeydown={() => {}}>
                  {#if correction}
                    <span class="seg-corrected">{correction.corrected}</span>
                    {#if correction.cer != null}
                      <span class="cer-badge" class:cer-good={correction.cer < 0.1} class:cer-mid={correction.cer >= 0.1 && correction.cer < 0.3} class:cer-bad={correction.cer >= 0.3} title="字错误率 CER">CER {Math.round(correction.cer * 100)}%</span>
                    {/if}
                  {:else}
                    {#each tokens as tk, ti}
                      {#if ti > 0}{" "}{/if}<span class="word" class:wa={isPlaying && currentTime >= tk.start && currentTime < tk.end}>{tk.text}</span>
                    {/each}
                  {/if}
                </span>
                <button class="seg-edit-btn" title="纠错" onclick={(e) => { e.stopPropagation(); startSegEdit(i); }}>✏</button>
              {/if}
            </div>
          {/each}
        {:else if current}
          <div class="seg-card full"><span>{current.text}</span></div>
        {:else if isSelectedPending}
          <div class="transcript-loading">
            <span class="spinner"></span>
            <span>正在转写中，请稍候...</span>
          </div>
        {/if}
      </div>
    </div>

    <AIAnnotationPanel
      {llmModel}
      {selectedSteps}
      labels={currentAiLabels}
      isLabeling={isCurrentLabeling}
      isAsrRunning={isAnnotating}
      originalText={current?.text ?? ""}
      verifications={currentVerifications}
      onRunLabel={runLabel}
      onVerify={handleVerify}
    />

    {#if hasAnyAnns}
      <div class="ann-panel">
        <div class="panel-label">手动标注</div>
        <div class="ann-list">
          {#each currentAnns as ann, i}
            <div class="ann-card">
              <small class="ann-time">{fmtTime(ann.start)} - {fmtTime(ann.end)}</small>
              <textarea
                class="ann-input"
                rows="2"
                placeholder="输入标注内容…"
                value={ann.value}
                onfocus={() => editingAnnIdx = i}
                oninput={(e) => updateAnnValue(i, (e.target as HTMLTextAreaElement).value)}
              ></textarea>
              <button class="ann-del" onclick={() => removeAnn(i)}>删除</button>
            </div>
          {/each}
          {#if currentAnns.length === 0}
            <p class="ann-empty">当前文件无手动标注</p>
          {/if}
        </div>
      </div>
    {/if}
  </div>

  <!-- 波形 + 频谱 -->
  <div class="wave-section">
    <div class="zoom-bar">
      <button class="zb" class:active={drawMode} onclick={toggleDrawMode} title="画框标注"><PenTool size={14} /></button>
      <div class="zb-sep"></div>
      <button class="zb" onclick={() => zoomBy(20)} title="放大"><ZoomIn size={14} /></button>
      <button class="zb" onclick={() => zoomBy(-20)} title="缩小"><ZoomOut size={14} /></button>
      <button class="zb" onclick={() => { zoomLevel = 0; ws?.zoom(0); }} title="适应宽度"><Maximize2 size={14} /></button>
    </div>
    <div class="wave-wrap" bind:this={waveRef}></div>
    <div class="spectro-wrap" bind:this={spectroRef}></div>
    {#if !wsReady}<div class="wave-overlay" aria-busy="true">加载波形…</div>{/if}
  </div>

  <!-- 播放器 -->
  <div class="player">
    <button class="ctrl" onclick={() => skip(-10)}><SkipBack size={16} /></button>
    <button class="ctrl play-btn" onclick={togglePlay}>{#if isPlaying}<Pause size={18} />{:else}<Play size={18} />{/if}</button>
    <button class="ctrl" onclick={() => skip(10)}><SkipForward size={16} /></button>
    <select class="speed" value={playbackRate} onchange={(e) => setSpeed(parseFloat((e.target as HTMLSelectElement).value))}>
      <option value="0.5">0.5x</option><option value="0.75">0.75x</option><option value="1">1x</option>
      <option value="1.25">1.25x</option><option value="1.5">1.5x</option><option value="2">2x</option>
    </select>
    <span class="ts">{fmtTime(currentTime)}</span>
    <div class="seek" role="slider" tabindex="0" onclick={seekTo} onkeydown={() => {}}>
      <div class="seek-fill" style="width:{duration > 0 ? (currentTime / duration) * 100 : 0}%"></div>
    </div>
    <span class="ts">{fmtTime(duration)}</span>
    <Volume2 size={15} />
    <input type="range" class="vol" min="0" max="1" step="0.05" value={volume} oninput={(e) => setVol(parseFloat((e.target as HTMLInputElement).value))} />
  </div>
</div>

<style>
  .view { display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
  .top-bar { display: flex; align-items: center; gap: 8px; padding: 7px 14px; border-bottom: 1px solid var(--pico-muted-border-color); background: var(--pico-card-background-color); flex-shrink: 0; }
  .btn-sm { width: auto; margin: 0; padding: 5px 12px; font-size: 13px; display: flex; align-items: center; gap: 4px; }
  .btn-ctrl { border: 1px solid var(--pico-muted-border-color); border-radius: 6px; cursor: pointer; background: var(--pico-card-background-color); color: var(--pico-contrast); }
  .btn-pause:hover { border-color: var(--pico-primary); color: var(--pico-primary); }
  .btn-resume { border-color: var(--pico-ins-color, #4ade80); color: var(--pico-ins-color, #16a34a); }
  .btn-resume:hover { background: rgba(74,222,128,0.08); }
  .btn-stop:hover { border-color: var(--pico-del-color); color: var(--pico-del-color); }
  .btn-batch-label { margin: 0; }
  .top-spacer { flex: 1; }
  .top-status-msg { font-size: 11px; opacity: 0.5; max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: "SF Mono", "Fira Code", monospace; }
  .top-progress { display: flex; align-items: center; gap: 8px; }
  .top-progress small { opacity: 0.6; font-size: 12px; display: flex; align-items: center; gap: 4px; white-space: nowrap; }
  .mini-bar { width: 60px; height: 3px; background: var(--pico-muted-border-color); border-radius: 2px; overflow: hidden; }
  .mini-fill { height: 100%; background: var(--pico-primary-background); border-radius: 2px; transition: width 0.3s; }
  .spinner { display: inline-block; width: 12px; height: 12px; border: 2px solid var(--pico-muted-border-color); border-top-color: var(--pico-primary); border-radius: 50%; animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  .content-row { display: flex; flex: 1; min-height: 0; overflow: hidden; }

  /* 文件列表 styles now live in FileListPanel.svelte */
  .panel-label { padding: 9px 12px 5px; font-size: 11px; font-weight: 700; opacity: 0.4; text-transform: uppercase; letter-spacing: 0.5px; flex-shrink: 0; }

  /* 转写 */
  .transcript-panel { flex: 1; display: flex; flex-direction: column; min-width: 0; background: var(--pico-card-background-color); border-right: 1px solid var(--pico-muted-border-color); }
  .transcript-list { flex: 1; overflow-y: auto; padding: 6px 10px 12px; display: flex; flex-direction: column; gap: 4px; }
  .seg-card { display: flex; align-items: baseline; gap: 10px; padding: 7px 10px; border: 1px solid var(--pico-muted-border-color); border-radius: 8px; font-size: 13.5px; line-height: 1.65; transition: background 0.12s, border-color 0.12s; overflow-wrap: break-word; word-break: break-word; position: relative; background: var(--pico-card-background-color); }
  .seg-card:hover { background: var(--pico-card-sectioning-background-color); }
  .seg-card:hover .seg-edit-btn { opacity: 0.5; }
  .seg-card.active { border-color: var(--pico-primary); background: rgba(74,158,255,0.04); }
  .seg-card.full { cursor: default; display: block; white-space: pre-wrap; }
  .transcript-loading { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; height: 100%; opacity: 0.5; font-size: 13px; }
  .transcript-loading .spinner { width: 22px; height: 22px; }
  .seg-ts { font-size: 10.5px; opacity: 0.35; font-family: monospace; white-space: nowrap; flex-shrink: 0; }
  .seg-card.active .seg-ts { color: var(--pico-primary); opacity: 0.8; }
  .seg-body { flex: 1; overflow-wrap: break-word; word-break: break-word; cursor: pointer; font-size: inherit; line-height: inherit; }
  .word { border-radius: 2px; transition: background 0.1s, color 0.1s; }
  .wa { background: rgba(74,158,255,0.18); color: var(--pico-primary); font-weight: 600; border-radius: 3px; padding: 0 1px; }

  /* 纠错编辑 */
  .seg-edit-btn { all: unset; cursor: pointer; font-size: 11px; opacity: 0; transition: opacity 0.15s; flex-shrink: 0; }
  .seg-edit-btn:hover { opacity: 1 !important; }
  .seg-edit { flex: 1; font-size: 13px; font-family: inherit; padding: 4px 6px; border: 1px solid var(--pico-primary); border-radius: 4px; resize: vertical; background: var(--pico-card-background-color); line-height: 1.5; min-height: 48px; }
  .seg-corrected { color: var(--pico-primary); }
  .cer-badge { font-size: 10px; font-weight: 600; padding: 1px 5px; border-radius: 4px; flex-shrink: 0; }
  .cer-good { background: rgba(74, 222, 128, 0.15); color: #16a34a; }
  .cer-mid  { background: rgba(251, 191, 36, 0.15); color: #b45309; }
  .cer-bad  { background: rgba(239, 68, 68, 0.15);  color: #dc2626; }

  /* 手动标注 */
  .ann-panel { width: 260px; flex-shrink: 0; display: flex; flex-direction: column; background: var(--pico-card-background-color); }
  .ann-list { flex: 1; overflow-y: auto; padding: 4px 10px 10px; display: flex; flex-direction: column; gap: 6px; }
  .ann-card { padding: 8px 10px; border: 1px solid rgba(255,100,100,0.3); border-radius: 6px; background: rgba(255,100,100,0.03); }
  .ann-time { display: block; font-size: 10px; opacity: 0.5; font-family: monospace; margin-bottom: 4px; }
  .ann-input { width: 100%; font-size: 12px; padding: 4px 6px; border: 1px solid var(--pico-muted-border-color); border-radius: 4px; resize: vertical; margin-bottom: 4px; font-family: inherit; }
  .ann-del { all: unset; font-size: 11px; color: var(--pico-del-color); cursor: pointer; opacity: 0.6; }
  .ann-del:hover { opacity: 1; }
  .ann-empty { font-size: 12px; opacity: 0.4; text-align: center; padding: 20px 0; }

  /* 波形 */
  .wave-section { position: relative; flex-shrink: 0; border-top: 1px solid var(--pico-muted-border-color); border-bottom: 1px solid var(--pico-muted-border-color); }
  .wave-wrap { height: 100px; overflow-x: auto; }
  .spectro-wrap { height: 64px; overflow-x: auto; }
  .zoom-bar { position: absolute; top: 6px; right: 8px; z-index: 10; display: flex; gap: 2px; background: rgba(255,255,255,0.9); border-radius: 6px; padding: 2px; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
  .zb { all: unset; cursor: pointer; width: 26px; height: 26px; display: flex; align-items: center; justify-content: center; border-radius: 4px; opacity: 0.5; transition: all 0.15s; }
  .zb:hover { opacity: 1; background: var(--pico-muted-border-color); }
  .zb.active { opacity: 1; background: rgba(255,100,100,0.15); color: var(--pico-del-color); }
  .zb-sep { width: 1px; background: var(--pico-muted-border-color); margin: 4px 2px; }
  .wave-overlay { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: var(--pico-card-background-color); opacity: 0.85; font-size: 13px; }

  /* 播放器 */
  .player { display: flex; align-items: center; gap: 8px; padding: 8px 14px; flex-shrink: 0; background: var(--pico-card-background-color); }
  .ctrl { all: unset; cursor: pointer; width: 30px; height: 30px; display: flex; align-items: center; justify-content: center; border-radius: 50%; }
  .ctrl:hover { background: var(--pico-card-sectioning-background-color); }
  .play-btn { width: 36px; height: 36px; background: var(--pico-primary-background); color: white; }
  .play-btn:hover { opacity: 0.9; background: var(--pico-primary-background) !important; }
  .speed { padding: 2px 4px; font-size: 11px; border: 1px solid var(--pico-muted-border-color); border-radius: 4px; background: transparent; margin: 0; width: auto; }
  .ts { font-size: 11px; opacity: 0.45; font-family: monospace; min-width: 32px; }
  .seek { flex: 1; height: 5px; background: var(--pico-muted-border-color); border-radius: 3px; cursor: pointer; overflow: hidden; }
  .seek-fill { height: 100%; background: var(--pico-primary-background); border-radius: 3px; transition: width 0.1s linear; }
  .vol { width: 60px; margin: 0; }
</style>
