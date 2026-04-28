<script lang="ts">
  interface Props {
    /** 章节名称，用于判断渲染类型 */
    secName: string;
    /** 章节内容文本 */
    secContent: string;
    /** 纠错类型需要的原始 ASR 文本 */
    originalText?: string;
  }
  let { secName, secContent, originalText = "" }: Props = $props();

  function sectionType(name: string): "correction" | "diarization" | "tagging" | "translation" | "quality" | "checklist" | "qc-verdict" | "qc-check" | "text" {
    const n = name.toLowerCase();
    if (n.includes("纠错") || n.includes("correction")) return "correction";
    if (n.includes("说话人") || n.includes("diarization") || n.includes("speaker")) return "diarization";
    if (n.includes("标签") || n.includes("tag")) return "tagging";
    if (n.includes("翻译") || n.includes("translat")) return "translation";
    if (n.includes("质量") || n.includes("quality")) return "quality";
    if (n.includes("自查") || n.includes("checklist")) return "checklist";
    // QC 专用类型
    if (n.includes("质检结论")) return "qc-verdict";
    if (n.includes("广告") || n.includes("乱码") || n.includes("重复内容") ||
        n.includes("夹杂") || n.includes("连贯") || n.includes("小语种") || n.includes("存疑")) return "qc-check";
    return "text";
  }

  // ── QC 解析 ──────────────────────────────────────────────────
  interface QcVerdict { pass: boolean | null; reason: string; }
  function parseQcVerdict(content: string): QcVerdict {
    const conclusionM = content.match(/结论[：:]\s*(.+)/);
    const conclusion = conclusionM ? conclusionM[1].trim() : "";
    const pass = conclusion === "合格" ? true : conclusion.includes("不合格") ? false : null;
    const reasonM = content.match(/原因[：:]\s*([\s\S]+)/);
    const reason = reasonM ? reasonM[1].trim() : "";
    return { pass, reason };
  }

  interface QcCheck { value: string; isOk: boolean | null; detail: string; }
  function parseQcCheck(content: string): QcCheck {
    const conclusionM = content.match(/结论[：:]\s*(.+)/);
    const conclusion = conclusionM ? conclusionM[1].trim() : content.trim().split("\n")[0];
    // 否/通顺 = ok；是开头/不通顺 = 有问题
    const isOk = conclusion === "否" || conclusion === "通顺" ? true
               : conclusion.startsWith("是") || conclusion === "不通顺" ? false : null;
    const detailM = content.match(/(?:广告内容|说明)[：:]\s*([\s\S]+)/);
    const detail = detailM ? detailM[1].trim() : "";
    return { value: conclusion, isOk, detail };
  }

  interface SpeakerLine { speaker: string; text: string; }
  function parseSpeakerLines(content: string): SpeakerLine[] {
    const lines = content.split("\n").map(l => l.trim()).filter(Boolean);
    const result: SpeakerLine[] = [];
    const re = /^(Speaker\s*[A-Z]|说话人\s*\w+|[A-Z])\s*[:：]\s*(.+)$/i;
    for (const line of lines) {
      const m = line.match(re);
      if (m) result.push({ speaker: m[1].trim(), text: m[2].trim() });
      else if (result.length > 0) result[result.length - 1].text += " " + line;
    }
    return result;
  }

  const SPEAKER_COLORS = ["#4f8ef7", "#e07b39", "#43a870", "#a855f7", "#e4435a"];
  const SPEAKER_BG_COLORS = [
    "rgba(79,142,247,0.1)", "rgba(224,123,57,0.1)", "rgba(67,168,112,0.1)",
    "rgba(168,85,247,0.1)", "rgba(228,67,90,0.1)",
  ];
  function speakerColor(speaker: string, allSpeakers: string[]): string {
    return SPEAKER_COLORS[allSpeakers.indexOf(speaker) % SPEAKER_COLORS.length];
  }
  function speakerColorBg(speaker: string, allSpeakers: string[]): string {
    return SPEAKER_BG_COLORS[allSpeakers.indexOf(speaker) % SPEAKER_BG_COLORS.length];
  }

  interface TagEntry { key: string; value: string; }
  function parseTagLines(content: string): TagEntry[] {
    const lines = content.split("\n").map(l => l.replace(/^[-*]\s*/, "").trim()).filter(Boolean);
    return lines.map(line => {
      const m = line.match(/^([^：:]+)[：:]\s*(.+)$/);
      return m ? { key: m[1].trim(), value: m[2].trim() } : { key: "", value: line };
    }).filter(e => e.value);
  }

  interface QualityResult { score: number | null; reason: string; }
  function parseQuality(content: string): QualityResult {
    const scoreM = content.match(/评分\s*[：:]\s*(\d+)\s*\/\s*5/);
    const reasonM = content.match(/理由\s*[：:]\s*(.+)/s);
    return { score: scoreM ? parseInt(scoreM[1]) : null, reason: reasonM ? reasonM[1].trim() : content.trim() };
  }
  function qualityColor(score: number): string {
    if (score >= 4) return "#16a34a";
    if (score >= 3) return "#b45309";
    return "#dc2626";
  }
  function qualityBg(score: number): string {
    if (score >= 4) return "rgba(74,222,128,0.12)";
    if (score >= 3) return "rgba(251,191,36,0.12)";
    return "rgba(239,68,68,0.12)";
  }

  interface CheckItem { done: boolean; text: string; }
  function parseChecklist(content: string): CheckItem[] {
    return content.split("\n").filter(l => l.trim()).map(line => {
      const m = line.match(/^\[([x ])\]\s*(.+)$/i);
      return m ? { done: m[1].toLowerCase() === "x", text: m[2].trim() } : null;
    }).filter(Boolean) as CheckItem[];
  }

  let type = $derived(sectionType(secName));
</script>

<div class="section-block">
  <div class="section-title">{secName}</div>

  {#if type === "correction"}
    <div class="correction-block">
      <div class="corr-orig">
        <span class="corr-label">原文</span>
        <span class="corr-text orig-text">{originalText}</span>
      </div>
      <div class="corr-arrow">→</div>
      <div class="corr-new">
        <span class="corr-label">纠错</span>
        <span class="corr-text new-text">{secContent}</span>
      </div>
    </div>

  {:else if type === "diarization"}
    {@const lines = parseSpeakerLines(secContent)}
    {@const speakers = [...new Set(lines.map(l => l.speaker))]}
    <div class="diarization-block">
      {#each lines as line}
        {@const isRight = speakers.indexOf(line.speaker) % 2 === 1}
        <div class="bubble-row" class:right={isRight}>
          <div
            class="bubble"
            style="background: {speakerColorBg(line.speaker, speakers)}; border-color: {speakerColor(line.speaker, speakers)};"
          >
            <span class="bubble-speaker" style="color: {speakerColor(line.speaker, speakers)};">{line.speaker}</span>
            <span class="bubble-text">{line.text}</span>
          </div>
        </div>
      {/each}
      {#if lines.length === 0}
        <div class="section-text">{secContent}</div>
      {/if}
    </div>

  {:else if type === "tagging"}
    {@const tags = parseTagLines(secContent)}
    <div class="tag-block">
      {#each tags as tag}
        <div class="tag-row">
          {#if tag.key}<span class="tag-key">{tag.key}</span>{/if}
          <span class="tag-value">{tag.value}</span>
        </div>
      {/each}
      {#if tags.length === 0}<div class="section-text">{secContent}</div>{/if}
    </div>

  {:else if type === "translation"}
    <div class="translation-block">{secContent}</div>

  {:else if type === "quality"}
    {@const q = parseQuality(secContent)}
    <div class="quality-block" style={q.score != null ? `background: ${qualityBg(q.score)}; border-color: ${qualityColor(q.score)};` : ""}>
      {#if q.score != null}
        <span class="quality-score" style="color: {qualityColor(q.score)};">{q.score}/5</span>
      {/if}
      <span class="quality-reason">{q.reason}</span>
    </div>

  {:else if type === "checklist"}
    {@const items = parseChecklist(secContent)}
    <div class="checklist-block">
      {#each items as item}
        <div class="check-item" class:done={item.done}>
          <span class="check-icon">{item.done ? "✓" : "○"}</span>
          <span>{item.text}</span>
        </div>
      {/each}
      {#if items.length === 0}<div class="section-text">{secContent}</div>{/if}
    </div>

  {:else if type === "qc-verdict"}
    {@const v = parseQcVerdict(secContent)}
    <div class="qc-verdict-block" class:pass={v.pass === true} class:fail={v.pass === false}>
      <span class="qc-badge">
        {v.pass === true ? "✓ 合格" : v.pass === false ? "✗ 不合格" : secContent.trim()}
      </span>
      {#if v.reason}
        <div class="qc-reason">{v.reason}</div>
      {/if}
    </div>

  {:else if type === "qc-check"}
    {@const c = parseQcCheck(secContent)}
    <div class="qc-check-block" class:check-ok={c.isOk === true} class:check-bad={c.isOk === false}>
      <span class="qc-check-badge" class:ok={c.isOk === true} class:bad={c.isOk === false}>
        {c.value || "—"}
      </span>
      {#if c.detail}
        <div class="qc-check-detail">{c.detail}</div>
      {/if}
    </div>

  {:else}
    <div class="section-text">{secContent}</div>
  {/if}
</div>

<style>
  .section-block { margin-top: 10px; border-top: 1px solid var(--pico-muted-border-color); padding-top: 8px; }
  .section-block:first-of-type { border-top: none; padding-top: 0; margin-top: 4px; }
  .section-title { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; opacity: 0.45; margin-bottom: 6px; }
  .section-text { font-size: 13px; white-space: pre-wrap; word-break: break-word; line-height: 1.6; }

  /* 纠错 */
  .correction-block { display: flex; flex-direction: column; gap: 6px; }
  .corr-orig, .corr-new { display: flex; flex-direction: column; gap: 2px; }
  .corr-label { font-size: 10px; font-weight: 600; opacity: 0.45; text-transform: uppercase; }
  .corr-text { font-size: 13px; line-height: 1.6; word-break: break-word; padding: 4px 6px; border-radius: 4px; }
  .orig-text { opacity: 0.5; background: rgba(0,0,0,0.04); text-decoration: line-through; text-decoration-color: rgba(0,0,0,0.2); }
  .new-text { background: rgba(74,222,128,0.1); border: 1px solid rgba(74,222,128,0.3); color: #15803d; }
  .corr-arrow { font-size: 16px; opacity: 0.3; text-align: center; line-height: 1; }

  /* 说话人 */
  .diarization-block { display: flex; flex-direction: column; gap: 6px; }
  .bubble-row { display: flex; justify-content: flex-start; }
  .bubble-row.right { justify-content: flex-end; }
  .bubble { max-width: 85%; padding: 6px 10px; border-radius: 10px; border: 1px solid; font-size: 12px; line-height: 1.5; }
  .bubble-speaker { font-size: 10px; font-weight: 700; display: block; margin-bottom: 2px; }
  .bubble-text { display: block; word-break: break-word; }

  /* 内容标签 */
  .tag-block { display: flex; flex-direction: column; gap: 4px; }
  .tag-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .tag-key { font-size: 11px; opacity: 0.5; min-width: 40px; }
  .tag-value { font-size: 12px; padding: 2px 8px; border-radius: 10px; background: var(--pico-primary); color: white; }

  /* 翻译 */
  .translation-block { font-size: 13px; line-height: 1.7; padding: 6px 8px; border-left: 3px solid var(--pico-primary); opacity: 0.8; word-break: break-word; }

  /* 质量评分 */
  .quality-block { display: flex; align-items: baseline; gap: 8px; padding: 6px 8px; border-radius: 6px; border: 1px solid transparent; }
  .quality-score { font-size: 20px; font-weight: 700; line-height: 1; flex-shrink: 0; }
  .quality-reason { font-size: 12px; line-height: 1.5; opacity: 0.7; }

  /* 自查清单 */
  .checklist-block { display: flex; flex-direction: column; gap: 4px; }
  .check-item { display: flex; gap: 6px; font-size: 12px; opacity: 0.6; align-items: flex-start; }
  .check-item.done { opacity: 1; }
  .check-icon { font-size: 11px; flex-shrink: 0; margin-top: 1px; }
  .check-item.done .check-icon { color: #16a34a; }

  /* QC 质检结论 */
  .qc-verdict-block {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 10px;
    border-radius: 6px;
    border: 1px solid transparent;
    background: rgba(0,0,0,0.04);
  }
  .qc-verdict-block.pass { background: rgba(74,222,128,0.12); border-color: rgba(74,222,128,0.4); }
  .qc-verdict-block.fail { background: rgba(239,68,68,0.10); border-color: rgba(239,68,68,0.35); }
  .qc-badge {
    font-size: 15px;
    font-weight: 700;
    letter-spacing: 0.5px;
  }
  .qc-verdict-block.pass .qc-badge { color: #15803d; }
  .qc-verdict-block.fail .qc-badge { color: #dc2626; }
  .qc-reason { font-size: 12px; line-height: 1.5; opacity: 0.75; }

  /* QC 各维度检查项 */
  .qc-check-block { display: flex; flex-direction: column; gap: 4px; }
  .qc-check-badge {
    display: inline-block;
    font-size: 11px;
    font-weight: 600;
    padding: 1px 8px;
    border-radius: 10px;
    background: var(--pico-muted-border-color);
    color: var(--pico-muted-color);
  }
  .qc-check-badge.ok { background: rgba(74,222,128,0.15); color: #15803d; }
  .qc-check-badge.bad { background: rgba(239,68,68,0.12); color: #dc2626; }
  .qc-check-detail { font-size: 12px; line-height: 1.5; opacity: 0.7; word-break: break-word; }
</style>
