<script lang="ts">
  import type { LabelResultData } from "../../api";

  interface VerifRecord {
    status: "confirmed" | "corrected";
    humanResult: string;
  }

  interface Props {
    label: LabelResultData;
    labelKey: string;
    verif: VerifRecord | undefined;
    onVerify: (labelKey: string, status: "confirmed" | "corrected", aiResult: string, humanResult: string, promptName: string, model: string) => void;
  }
  let { label, labelKey, verif, onVerify }: Props = $props();

  let editingKey = $state<string | null>(null);
  let editingText = $state("");

  function startEdit() {
    editingKey = labelKey;
    editingText = verif?.humanResult ?? label.result;
  }

  function cancelEdit() {
    editingKey = null;
    editingText = "";
  }

  function commitEdit() {
    const humanResult = editingText.trim();
    onVerify(labelKey, "corrected", label.result, humanResult, label.prompt_name, label.model);
    editingKey = null;
    editingText = "";
  }
</script>

{#if editingKey === labelKey}
  <div class="verif-edit">
    <textarea
      class="verif-textarea"
      rows="4"
      bind:value={editingText}
      placeholder="输入正确答案…"
    ></textarea>
    <div class="verif-edit-actions">
      <button class="btn-verif btn-cancel" onclick={cancelEdit}>取消</button>
      <button class="btn-verif btn-save" onclick={commitEdit}>保存纠错</button>
    </div>
  </div>
{:else}
  <div class="verif-bar">
    {#if verif}
      <span class="verif-status" class:confirmed={verif.status === "confirmed"} class:corrected={verif.status === "corrected"}>
        {verif.status === "confirmed" ? "✓ 已确认" : "✎ 已纠错"}
      </span>
    {/if}
    <div class="verif-actions">
      <button
        class="btn-verif btn-confirm"
        class:active={verif?.status === "confirmed"}
        title="确认 AI 标注正确"
        onclick={() => onVerify(labelKey, "confirmed", label.result, label.result, label.prompt_name, label.model)}
      >✓ 确认</button>
      <button
        class="btn-verif btn-correct"
        class:active={verif?.status === "corrected"}
        title="纠正 AI 标注错误"
        onclick={startEdit}
      >✎ 纠错</button>
    </div>
  </div>
{/if}

<style>
  .verif-bar { display: flex; align-items: center; gap: 6px; margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--pico-muted-border-color); }
  .verif-status { font-size: 11px; font-weight: 600; flex: 1; }
  .verif-status.confirmed { color: #16a34a; }
  .verif-status.corrected { color: #b45309; }
  .verif-actions { display: flex; gap: 4px; margin-left: auto; }
  .btn-verif { all: unset; cursor: pointer; font-size: 11px; padding: 3px 8px; border-radius: 4px; border: 1px solid var(--pico-muted-border-color); color: var(--pico-muted-color); transition: all 0.15s; white-space: nowrap; }
  .btn-verif:hover { border-color: var(--pico-primary); color: var(--pico-primary); }
  .btn-confirm.active { background: rgba(74,222,128,0.15); border-color: #16a34a; color: #16a34a; }
  .btn-correct.active { background: rgba(251,191,36,0.15); border-color: #b45309; color: #b45309; }
  .verif-edit { margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--pico-muted-border-color); display: flex; flex-direction: column; gap: 6px; }
  .verif-textarea { font-size: 12px; font-family: inherit; resize: vertical; border: 1px solid var(--pico-primary-border); border-radius: 4px; padding: 6px 8px; background: var(--pico-background-color); width: 100%; box-sizing: border-box; }
  .verif-edit-actions { display: flex; gap: 6px; justify-content: flex-end; }
  .btn-cancel { color: var(--pico-muted-color); }
  .btn-save { background: var(--pico-primary); color: white; border-color: var(--pico-primary); }
</style>
