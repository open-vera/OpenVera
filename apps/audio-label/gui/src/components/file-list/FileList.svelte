<script lang="ts">
  import type { AudioFileInfo } from "../../api";
  import { audioUrl } from "../../api";

  interface Props {
    files: AudioFileInfo[];
    selected: Set<string>;
    onToggle: (path: string) => void;
    onToggleAll: () => void;
  }
  let { files, selected, onToggle, onToggleAll }: Props = $props();

  let playingPath = $state("");
  let audioEl: HTMLAudioElement | null = null;

  function fmt(sec: number | null): string {
    if (sec == null) return "-";
    if (sec < 60) return `${sec.toFixed(1)}s`;
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  function fmtRate(rate: number | null): string {
    if (rate == null) return "-";
    return `${(rate / 1000).toFixed(1)}k`;
  }

  function fmtSize(bytes: number | null): string {
    if (bytes == null) return "-";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function fmtChannels(ch: number | null): string {
    if (ch == null) return "-";
    if (ch === 1) return "单声道";
    if (ch === 2) return "立体声";
    return `${ch}ch`;
  }

  function togglePlay(file: AudioFileInfo) {
    if (playingPath === file.path) {
      audioEl?.pause();
      playingPath = "";
      return;
    }
    if (audioEl) audioEl.pause();
    audioEl = new Audio(audioUrl(file.path));
    audioEl.onended = () => { playingPath = ""; };
    audioEl.onerror = () => { playingPath = ""; };
    audioEl.play();
    playingPath = file.path;
  }

  let allSelected = $derived(files.length > 0 && files.every((f) => selected.has(f.path)));
</script>

<div class="file-list">
  {#if files.length === 0}
    <div class="empty">
      <p>选择目录后将显示音频文件列表</p>
    </div>
  {:else}
    <table>
      <thead>
        <tr>
          <th class="col-check">
            <input type="checkbox" checked={allSelected} onchange={onToggleAll} />
          </th>
          <th class="col-play"></th>
          <th class="col-name">文件名</th>
          <th class="col-dur">时长</th>
          <th class="col-rate">采样率</th>
          <th class="col-ch">声道</th>
          <th class="col-size">大小</th>
        </tr>
      </thead>
      <tbody>
        {#each files as file (file.path)}
          <tr class:checked={selected.has(file.path)}>
            <td class="col-check">
              <input
                type="checkbox"
                checked={selected.has(file.path)}
                onchange={() => onToggle(file.path)}
              />
            </td>
            <td class="col-play">
              <button
                class="play-btn"
                onclick={(e) => { e.stopPropagation(); togglePlay(file); }}
                title={playingPath === file.path ? "暂停" : "播放"}
              >
                {playingPath === file.path ? "⏸" : "▶"}
              </button>
            </td>
            <td class="col-name" onclick={() => onToggle(file.path)}>{file.name}</td>
            <td class="col-dur">{fmt(file.duration_sec)}</td>
            <td class="col-rate">{fmtRate(file.sample_rate)}</td>
            <td class="col-ch">{fmtChannels(file.channels)}</td>
            <td class="col-size">{fmtSize(file.size_bytes)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
    <div class="summary">
      <small>{selected.size}/{files.length} 个文件已选中</small>
    </div>
  {/if}
</div>

<style>
  .file-list {
    flex: 1;
    overflow-y: auto;
    border: 1px solid var(--pico-muted-border-color);
    border-radius: var(--pico-border-radius);
    background: var(--pico-card-background-color);
  }
  .empty {
    text-align: center;
    padding: 60px 20px;
    opacity: 0.5;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    margin: 0;
    font-size: 13px;
  }
  thead {
    position: sticky;
    top: 0;
    z-index: 1;
    background: var(--pico-card-sectioning-background-color);
  }
  th {
    padding: 8px 10px;
    text-align: left;
    font-weight: 600;
    font-size: 12px;
    opacity: 0.6;
    border-bottom: 1px solid var(--pico-muted-border-color);
    white-space: nowrap;
  }
  td {
    padding: 6px 10px;
    border-bottom: 1px solid var(--pico-muted-border-color);
    white-space: nowrap;
  }
  tr:last-child td { border-bottom: none; }
  tr:hover { background: var(--pico-card-sectioning-background-color); }
  tr.checked { background: rgba(74, 158, 255, 0.06); }

  .col-check { width: 36px; text-align: center; }
  .col-check input { margin: 0; }
  .col-play { width: 36px; text-align: center; }
  .col-name {
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 0;
    width: 100%;
  }
  .col-dur, .col-rate, .col-ch, .col-size {
    text-align: right;
    opacity: 0.65;
    width: 70px;
  }
  .col-ch { width: 60px; }

  .play-btn {
    all: unset;
    cursor: pointer;
    width: 24px;
    height: 24px;
    line-height: 24px;
    text-align: center;
    border-radius: 50%;
    font-size: 11px;
    transition: background 0.15s;
  }
  .play-btn:hover {
    background: var(--pico-muted-border-color);
  }

  .summary {
    padding: 6px 12px;
    border-top: 1px solid var(--pico-muted-border-color);
    background: var(--pico-card-sectioning-background-color);
    opacity: 0.7;
  }
</style>
