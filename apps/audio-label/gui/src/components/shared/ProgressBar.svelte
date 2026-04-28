<script lang="ts">
  interface Props {
    current: number;
    total: number;
    file: string;
    status: string;
  }
  let { current, total, file, status }: Props = $props();

  let pct = $derived(total > 0 ? (current / total) * 100 : 0);
</script>

<div class="progress-section">
  <progress value={current} max={total}></progress>
  <div class="info">
    <small><strong>{current}/{total}</strong></small>
    <small class="file">{file}</small>
    <small>{status}</small>
  </div>
</div>

<style>
  .progress-section {
    padding: 4px 0;
  }
  progress {
    margin-bottom: 4px;
  }
  .info {
    display: flex;
    gap: 12px;
    color: var(--fg-dim);
  }
  .file {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
