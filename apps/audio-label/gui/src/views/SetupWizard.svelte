<script lang="ts">
  import { preflight, installStream, type CheckItem } from "../api";

  interface Props {
    onReady: () => void;
  }
  let { onReady }: Props = $props();

  let checks = $state<CheckItem[]>([]);
  let loading = $state(true);
  let installing = $state<Record<string, boolean>>({});
  let installLogs = $state<Record<string, string[]>>({});
  let installDone = $state<Record<string, boolean | null>>({});
  let allReady = $state(false);
  let showComplete = $state(false);
  let copied = $state(false);

  const SETUP_PROMPT = `我需要为 Apple Silicon Mac（M 系列芯片）配置 Vera Label 音频标注工具的运行环境。
请按以下步骤逐一检测并安装所有依赖，每步先检测再安装，已安装的跳过。

## 第一阶段：基础工具

1. Homebrew
   - 检测：which brew
   - 安装：/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
   - 安装后执行提示的 eval 命令将 brew 加入 PATH

2. Python 3
   - 检测：python3 --version（需要 3.10+）
   - 安装：brew install python3

3. ffmpeg
   - 检测：which ffmpeg
   - 安装：brew install ffmpeg

## 第二阶段：ASR 推理引擎（二选一，推荐 MLX）

### 方案 A：MLX（推荐，Apple Silicon 原生，速度更快）

4. 创建 ML 虚拟环境（路径固定）
   VENV="$HOME/Library/Application Support/com.vera.veralabel/venv"
   python3 -m venv "$VENV"
   "$VENV/bin/pip" install --upgrade pip

5. 安装 MLX 相关包
   "$VENV/bin/pip" install mlx mlx-lm mlx-qwen3-asr

6. 下载 Qwen3-ASR 模型权重（约 1.2 GB，首次需联网）
   "$VENV/bin/python3" -c "from mlx_qwen3_asr import Session; Session()"

7. 下载时间戳对齐模型（约 600 MB）
   "$VENV/bin/python3" -c "from huggingface_hub import snapshot_download; snapshot_download('Qwen/Qwen3-ForcedAligner-0.6B')"

### 方案 B：Ollama（备选）

4. 安装 Ollama：brew install ollama
5. 拉取模型：ollama pull qwen2.5

## 第三阶段：可选增强

- 音频降噪："$VENV/bin/pip" install deepfilternet
- 说话人分离："$VENV/bin/pip" install pyannote.audio torch
  （还需在 https://hf.co/pyannote/speaker-diarization-3.1 接受许可并设置 HUGGINGFACE_HUB_TOKEN）

全部完成后重启 Vera Label，在「环境检查」页面确认所有项为绿色即可。`;

  function copyPrompt() {
    navigator.clipboard.writeText(SETUP_PROMPT).then(() => {
      copied = true;
      setTimeout(() => { copied = false; }, 2000);
    });
  }

  async function runCheck() {
    loading = true;
    try {
      const res = await preflight();
      checks = res.checks;
      if (res.ready) {
        onReady();
        return;
      }
    } catch (e) {
      checks = [{ name: "API 连接", ok: false, detail: `${e}`, install_cmd: null }];
    }
    loading = false;
  }

  function handleInstall(check: CheckItem) {
    if (!check.install_cmd) return;
    installing[check.name] = true;
    installLogs[check.name] = [`$ ${check.install_cmd}`];
    installDone[check.name] = null;

    installStream(check.install_cmd, (ev) => {
      if (ev.event === "log" && ev.line !== undefined) {
        installLogs[check.name] = [...(installLogs[check.name] || []), ev.line];
      } else if (ev.event === "done") {
        installDone[check.name] = ev.ok ?? false;
        installing[check.name] = false;
        if (ev.ok) {
          // 重新检测
          runCheck();
        }
      }
    });
  }

  $effect(() => { runCheck(); });

  let hasAnyPath = $derived(
    checks.length >= 7 && (
      (checks[3]?.ok && checks[4]?.ok) ||
      (checks[5]?.ok && checks[6]?.ok)
    )
  );

</script>

<article class="wizard">
  <header>
    <h3>环境检查</h3>
    <p><small>检测运行所需的依赖，缺失项可一键安装</small></p>
  </header>

  <div class="agent-tip">
    <span class="tip-icon">🤖</span>
    <div class="tip-body">
      <span>也可以复制安装指引，粘贴给 Claude Code / Cursor 自动完成配置</span>
      <button class="outline btn-sm" onclick={copyPrompt}>
        {copied ? "已复制" : "复制安装指引"}
      </button>
    </div>
  </div>

  {#if loading && checks.length === 0}
    <p aria-busy="true">正在检测环境…</p>
  {:else}
    <div class="check-list">
      {#each checks as check (check.name)}
        <div class="check-item">
          <span class="icon" class:ok={check.ok} class:fail={!check.ok}>
            {check.ok ? "✓" : "✗"}
          </span>
          <div class="info">
            <strong>{check.name}</strong>
            <small>{check.detail.split("\n")[0]}</small>
          </div>
          <div class="action">
            {#if !check.ok && check.install_cmd}
              {#if installing[check.name]}
                <button class="outline secondary btn-sm" aria-busy="true" disabled>安装中</button>
              {:else if installDone[check.name] === true}
                <small class="ok-text">已安装</small>
              {:else if installDone[check.name] === false}
                <button class="outline contrast btn-sm" onclick={() => handleInstall(check)}>重试</button>
              {:else}
                <button class="outline btn-sm" onclick={() => handleInstall(check)}>安装</button>
              {/if}
            {/if}
          </div>
        </div>
        {#if installLogs[check.name]?.length}
          <details class="log-panel" open>
            <summary>
              {installing[check.name] ? "正在执行…" : installDone[check.name] ? "安装完成" : "安装失败"} — {check.name}
            </summary>
            <pre class="log-output">{installLogs[check.name].join("\n")}</pre>
          </details>
        {/if}
      {/each}
      </div>

      <!-- 就绪提示 -->
      {#if allReady}
        <div class="ready-banner">
          <span class="ready-icon">&#10003;</span>
          <div>
            <strong>环境配置已完成</strong>
            <small>所有依赖已就绪，可以开始标注音频了</small>
          </div>
        </div>
      {/if}
    {/if}

    <footer>
      <button class="secondary outline" onclick={runCheck} disabled={loading}>重新检测</button>
      <button onclick={onReady} disabled={!hasAnyPath}>
        {allReady ? "进入标注流程" : hasAnyPath ? "继续" : "请至少安装一种 ASR 路径"}
      </button>
    </footer>
</article>

<style>
  .wizard {
    max-width: 580px;
    margin: 40px auto;
  }
  .check-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 1rem;
  }
  .check-item {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
    border-radius: var(--pico-border-radius);
    background: var(--pico-card-sectioning-background-color);
  }
  .icon {
    font-size: 18px;
    width: 24px;
    text-align: center;
    flex-shrink: 0;
  }
  .icon.ok { color: var(--pico-ins-color, #4ade80); }
  .icon.fail { color: var(--pico-del-color, #f87171); }
  .info {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
    overflow: hidden;
    min-width: 0;
  }
  .info small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    opacity: 0.7;
  }
  .action {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }
  .btn-sm {
    padding: 4px 14px !important;
    font-size: 13px !important;
    margin: 0 !important;
    width: auto !important;
  }
  .ok-text { color: var(--pico-ins-color, #4ade80); font-weight: 600; }

  .log-panel {
    margin-bottom: 1rem;
    border: 1px solid var(--pico-muted-border-color);
    border-radius: var(--pico-border-radius);
  }
  .log-panel summary {
    padding: 8px 12px;
    font-size: 13px;
    cursor: pointer;
  }
  .log-output {
    max-height: 180px;
    overflow-y: auto;
    margin: 0;
    padding: 8px 12px;
    font-size: 11px;
    line-height: 1.5;
    border-top: 1px solid var(--pico-muted-border-color);
    white-space: pre-wrap;
    word-break: break-all;
  }

  .ready-banner {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 14px 16px;
    border-radius: var(--pico-border-radius);
    background: rgba(74, 222, 128, 0.1);
    border: 1px solid rgba(74, 222, 128, 0.3);
    margin-bottom: 1rem;
  }
  .ready-icon {
    width: 36px;
    height: 36px;
    line-height: 36px;
    border-radius: 50%;
    background: var(--pico-ins-color, #4ade80);
    color: white;
    font-size: 18px;
    text-align: center;
    flex-shrink: 0;
  }
  .ready-banner small {
    opacity: 0.7;
    display: block;
  }

  footer {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }
  footer button { width: auto; }

  .agent-tip {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    border-radius: var(--pico-border-radius);
    background: var(--pico-card-sectioning-background-color);
    border: 1px solid var(--pico-muted-border-color);
    margin-bottom: 1rem;
    font-size: 13px;
  }
  .tip-icon { font-size: 18px; flex-shrink: 0; }
  .tip-body {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }
  .tip-body span { opacity: 0.8; }
</style>
