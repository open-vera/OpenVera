<script lang="ts">
  import { getSystemStats, type SystemStats } from "../../api";

  interface Props {
    visible: boolean;
    statusMessage: string;
    llmWorkers?: number;
  }
  let { visible, statusMessage, llmWorkers = 0 }: Props = $props();

  let stats: SystemStats | null = $state(null);
  let cpuHistory: number[] = $state([]);
  let showPopover = $state(false);

  $effect(() => {
    if (!visible) { stats = null; cpuHistory = []; return; }

    async function fetchStats() {
      try {
        const s = await getSystemStats();
        stats = s;
        cpuHistory = [...cpuHistory.slice(-9), s.cpu_percent];
      } catch {}
    }

    fetchStats();
    const id = setInterval(fetchStats, 3000);
    return () => clearInterval(id);
  });

  function memColor(v: number) { return v < 70 ? "green" : v < 85 ? "orange" : "red"; }
  function cpuColor(v: number) { return v < 60 ? "green" : v < 85 ? "orange" : "red"; }
  function gpuColor(v: number) { return v < 60 ? "green" : v < 85 ? "orange" : "red"; }
</script>

{#if visible}
  <div class="mem-widget"
       role="status"
       onmouseenter={() => showPopover = true}
       onmouseleave={() => showPopover = false}>
    <span class="mem-pill {memColor(stats?.memory_percent ?? 0)}">
      MEM {stats ? `${stats.memory_used_gb}/${stats.memory_total_gb}GB` : "--"}
    </span>
    {#if showPopover}
      <div class="pop" role="tooltip">
        <div class="pop-title">系统资源</div>
        <div class="pop-row">
          <span>CPU</span>
          <span class="pv {cpuColor(stats?.cpu_percent ?? 0)}">{stats ? `${Math.round(stats.cpu_percent)}%` : "--"}</span>
        </div>
        <div class="pop-row">
          <span>内存</span>
          <span class="pv {memColor(stats?.memory_percent ?? 0)}">{stats ? `${stats.memory_used_gb} / ${stats.memory_total_gb} GB` : "--"}</span>
        </div>
        <div class="pop-row">
          <span class:unavail-label={stats?.gpu_percent == null}>GPU</span>
          <span class="pv" class:unavail={stats?.gpu_percent == null} class:green={stats?.gpu_percent != null && stats.gpu_percent < 60} class:orange={stats?.gpu_percent != null && stats.gpu_percent >= 60 && stats.gpu_percent < 85} class:red={stats?.gpu_percent != null && stats.gpu_percent >= 85}>
            {stats?.gpu_percent != null ? `${Math.round(stats.gpu_percent)}%` : "不可用"}
          </span>
        </div>
        {#if stats?.thermal_throttled}
          <div class="pop-row pop-warn">
            <span>⚠ 热节流</span>
            <span class="pv red">已触发</span>
          </div>
        {/if}
        {#if llmWorkers > 0}
          <div class="pop-sep"></div>
          <div class="pop-row">
            <span>LLM 并发</span>
            <span class="pv">{llmWorkers} workers</span>
          </div>
        {/if}
        {#if cpuHistory.length > 1}
          <div class="pop-sparkline">
            {#each cpuHistory as v}
              <span class="spk-bar" style="height:{Math.max(3, Math.round((v / 100) * 20))}px"></span>
            {/each}
            <span class="spk-label">CPU 近期趋势</span>
          </div>
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  :global(:root) {
    --c-green:  #22c55e;
    --c-orange: #fb923c;
    --c-red:    #f87171;
  }

  .mem-widget {
    position: relative;
    cursor: default;
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
  }

  .mem-pill {
    font-size: 11px;
    font-family: "SF Mono", "Fira Code", "Consolas", monospace;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 10px;
    background: var(--pico-card-sectioning-background-color);
    border: 1px solid var(--pico-muted-border-color);
    white-space: nowrap;
  }
  .mem-pill.green  { color: var(--c-green); border-color: rgba(34,197,94,0.3); }
  .mem-pill.orange { color: var(--c-orange); border-color: rgba(251,146,60,0.3); }
  .mem-pill.red    { color: var(--c-red); border-color: rgba(248,113,113,0.4); animation: blink-warn 1.5s ease-in-out infinite; }

  @keyframes blink-warn { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }

  .pop {
    position: absolute;
    top: calc(100% + 8px);
    right: 0;
    z-index: 200;
    min-width: 200px;
    background: var(--pico-card-background-color);
    border: 1px solid var(--pico-muted-border-color);
    border-radius: 10px;
    padding: 12px 14px;
    box-shadow: 0 6px 24px rgba(0,0,0,0.12);
    font-size: 12px;
    font-family: "SF Mono", "Fira Code", "Consolas", monospace;
  }
  .pop-title {
    font-size: 10px;
    font-weight: 700;
    opacity: 0.4;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 8px;
  }
  .pop-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 3px 0;
    font-size: 12px;
    opacity: 0.85;
  }
  .pop-row.pop-warn { color: var(--c-red); opacity: 1; }
  .pv { font-weight: 700; }
  .pv.green  { color: var(--c-green); }
  .pv.orange { color: var(--c-orange); }
  .pv.red    { color: var(--c-red); }
  .pv.unavail { opacity: 0.3; font-weight: 400; }
  .unavail-label { opacity: 0.45; }
  .pop-sep { height: 1px; background: var(--pico-muted-border-color); margin: 8px 0; }

  .pop-sparkline {
    position: relative;
    display: flex;
    align-items: flex-end;
    gap: 2px;
    height: 28px;
    margin-top: 8px;
    padding-top: 6px;
    border-top: 1px solid var(--pico-muted-border-color);
  }
  .spk-bar {
    width: 6px;
    border-radius: 2px 2px 0 0;
    background: var(--pico-primary);
    opacity: 0.55;
    transition: height 0.3s;
  }
  .spk-label {
    position: absolute;
    right: 0;
    top: 7px;
    font-size: 9px;
    opacity: 0.3;
    font-family: inherit;
  }
</style>
