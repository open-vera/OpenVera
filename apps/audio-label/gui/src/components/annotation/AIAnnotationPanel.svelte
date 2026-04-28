<script lang="ts">
  import type { LabelResultData } from "../../api";
  import SectionRenderer from "./SectionRenderer.svelte";
  import VerificationBar from "./VerificationBar.svelte";

  interface VerifRecord {
    status: "confirmed" | "corrected";
    humanResult: string;
  }

  interface Props {
    llmModel: string;
    selectedSteps: string[];
    labels: LabelResultData[];
    isLabeling: boolean;
    isAsrRunning: boolean;
    /** 当前文件的原始 ASR 文本，用于纠错 diff */
    originalText: string;
    /** 当前文件的已有确认/纠错记录，key = prompt_name+model */
    verifications: Record<string, VerifRecord>;
    onRunLabel: () => void;
    onVerify: (labelKey: string, status: "confirmed" | "corrected", aiResult: string, humanResult: string, promptName: string, model: string) => void;
  }
  let { llmModel, selectedSteps, labels, isLabeling, isAsrRunning, originalText, verifications, onRunLabel, onVerify }: Props = $props();

  function labelKey(label: LabelResultData): string {
    return `${label.prompt_name}::${label.model}`;
  }

  function confidenceColor(score: number): string {
    if (score >= 0.7) return "conf-high";
    if (score >= 0.4) return "conf-mid";
    return "conf-low";
  }
</script>

<div class="ai-panel">
  <div class="panel-label">AI 标注</div>
  <div class="ai-content">
    {#if !llmModel}
      <div class="ai-placeholder">
        <span class="hint">请在配置中选择 LLM 模型</span>
      </div>
    {:else if isLabeling}
      <div class="ai-placeholder">
        <span class="spinner"></span>
        <span>标注中...</span>
      </div>
    {:else if labels.length > 0}
      {#each labels as label}
        <div class="label-card">
          <div class="label-meta">
            <small class="label-model">{label.model}</small>
            <small class="label-prompt">{label.prompt_name || "自定义"}</small>
            {#if label.label_confidence?.overall != null}
              {@const score = label.label_confidence.overall}
              <span class="conf-badge {confidenceColor(score)}" title="综合置信度">{Math.round(score * 100)}%</span>
            {/if}
          </div>
          {#if label.label_confidence?.overall != null && label.label_confidence.overall < 0.7}
            <div class="conf-warning">⚠ 置信度较低，建议人工复核</div>
          {/if}
          {#if label.label_confidence?.labels && Object.keys(label.label_confidence.labels).length > 0}
            <div class="conf-labels">
              {#each Object.entries(label.label_confidence.labels) as [key, score]}
                <span class="conf-tag {confidenceColor(score)}" title="{key}: {Math.round(score * 100)}%">{key} {Math.round(score * 100)}%</span>
              {/each}
            </div>
          {/if}

          <!-- 章节富视图 -->
          {#if label.sections && Object.keys(label.sections).length > 0}
            {#each Object.entries(label.sections) as [secName, secContent]}
              <SectionRenderer {secName} {secContent} {originalText} />
            {/each}
          {:else}
            <!-- 无结构化 section，显示原始文本 -->
            <div class="label-result">{label.result}</div>
          {/if}

          <!-- 人工确认/纠错区 -->
          <VerificationBar
            {label}
            labelKey={labelKey(label)}
            verif={verifications[labelKey(label)]}
            {onVerify}
          />
        </div>
      {/each}
      <button class="outline rerun-btn" onclick={onRunLabel} disabled={isAsrRunning}>重新标注</button>
    {:else}
      <div class="ai-ready">
        <small class="model-info">模型：{llmModel}</small>
        {#if selectedSteps.length > 0}
          <small class="prompt-info">已选步骤：{selectedSteps.length} 项</small>
        {:else}
          <small class="prompt-info hint-warn">请选择至少一个处理步骤</small>
        {/if}
        <button class="run-btn" onclick={onRunLabel} disabled={selectedSteps.length === 0 || isAsrRunning}>
          {isAsrRunning ? "等待 ASR 完成…" : "运行标注"}
        </button>
      </div>
    {/if}
  </div>
</div>

<style>
  .ai-panel {
    width: 300px;
    flex-shrink: 0;
    border-right: 1px solid var(--pico-muted-border-color);
    display: flex;
    flex-direction: column;
    background: var(--pico-card-background-color);
  }
  .panel-label {
    padding: 10px 14px 6px;
    font-size: 11px;
    font-weight: 700;
    opacity: 0.4;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .ai-content {
    flex: 1;
    overflow-y: auto;
    padding: 6px 12px 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .ai-placeholder {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    height: 100%;
    opacity: 0.5;
    font-size: 13px;
  }
  .hint { text-align: center; line-height: 1.6; }
  .spinner {
    display: inline-block;
    width: 22px;
    height: 22px;
    border: 2px solid var(--pico-muted-border-color);
    border-top-color: var(--pico-primary);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .ai-ready {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding-top: 20px;
  }
  .model-info, .prompt-info {
    opacity: 0.5;
    font-size: 12px;
  }
  .hint-warn { color: #b45309; opacity: 1; }
  .run-btn {
    margin-top: 8px;
    padding: 8px 20px;
    font-size: 13px;
    width: auto;
  }
  .rerun-btn {
    padding: 6px 14px;
    font-size: 12px;
    width: auto;
    align-self: center;
    margin: 0;
  }
  .label-card {
    background: var(--pico-card-sectioning-background-color);
    border-radius: 6px;
    padding: 10px 12px;
  }
  .label-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
    margin-bottom: 6px;
  }
  .label-model {
    font-size: 11px;
    opacity: 0.5;
    font-family: monospace;
  }
  .label-prompt {
    font-size: 11px;
    opacity: 0.4;
  }
  .label-result {
    font-size: 13px;
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.6;
  }

  /* 置信度 */
  .conf-badge {
    font-size: 10px;
    font-weight: 600;
    padding: 1px 6px;
    border-radius: 10px;
    margin-left: auto;
  }
  .conf-high { background: rgba(74, 222, 128, 0.15); color: #16a34a; }
  .conf-mid  { background: rgba(251, 191, 36, 0.15); color: #b45309; }
  .conf-low  { background: rgba(239, 68, 68, 0.15);  color: #dc2626; }
  .conf-warning {
    font-size: 11px;
    color: #b45309;
    background: rgba(251, 191, 36, 0.1);
    border: 1px solid rgba(251, 191, 36, 0.3);
    border-radius: 4px;
    padding: 4px 8px;
    margin-bottom: 6px;
  }
  .conf-labels {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-bottom: 8px;
  }
  .conf-tag {
    font-size: 10px;
    padding: 1px 5px;
    border-radius: 4px;
    cursor: default;
  }

  /* 人工确认/纠错 — styles now live in VerificationBar.svelte */
</style>
