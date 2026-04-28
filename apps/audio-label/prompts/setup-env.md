# Vera Label 环境安装向导

> 把这段 prompt 复制给 Claude Code / Cursor / 任意 AI Agent，让它帮你一键完成环境配置。

---

我需要为 Apple Silicon Mac（M 系列芯片）配置 **Vera Label** 音频标注工具的运行环境。
请按以下步骤逐一检测并安装所有依赖，**每步先检测再安装，已安装的跳过**。

## 第一阶段：基础工具

1. **Homebrew**
   - 检测：`which brew`
   - 安装：`/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"`
   - 安装后执行提示的 `eval` 命令将 brew 加入 PATH

2. **Python 3**
   - 检测：`python3 --version`（需要 3.10+）
   - 安装：`brew install python3`

3. **ffmpeg**
   - 检测：`which ffmpeg`
   - 安装：`brew install ffmpeg`

## 第二阶段：ASR 推理引擎（二选一，推荐 MLX）

### 方案 A：MLX（推荐，Apple Silicon 原生，速度更快）

4. **创建 ML 虚拟环境**（路径固定）
   ```bash
   VENV="$HOME/Library/Application Support/com.vera.veralabel/venv"
   python3 -m venv "$VENV"
   "$VENV/bin/pip" install --upgrade pip
   ```

5. **安装 MLX 相关包**
   ```bash
   VENV="$HOME/Library/Application Support/com.vera.veralabel/venv"
   "$VENV/bin/pip" install mlx mlx-lm mlx-qwen3-asr
   ```

6. **下载 Qwen3-ASR 模型权重**（约 1.2 GB，首次需联网）
   ```bash
   VENV="$HOME/Library/Application Support/com.vera.veralabel/venv"
   "$VENV/bin/python3" -c "from mlx_qwen3_asr import Session; Session()"
   ```

7. **下载时间戳对齐模型**（约 600 MB）
   ```bash
   VENV="$HOME/Library/Application Support/com.vera.veralabel/venv"
   "$VENV/bin/python3" -c "
   from huggingface_hub import snapshot_download
   snapshot_download('Qwen/Qwen3-ForcedAligner-0.6B')
   "
   ```

### 方案 B：Ollama（备选，联网或本地大模型）

4. **安装 Ollama**
   - 检测：`which ollama`
   - 安装：`brew install ollama`

5. **拉取推理模型**
   ```bash
   ollama pull qwen2.5
   ```

## 第三阶段：可选增强（可跳过）

8. **音频降噪 DeepFilterNet**（用于嘈杂录音预处理）
   ```bash
   VENV="$HOME/Library/Application Support/com.vera.veralabel/venv"
   "$VENV/bin/pip" install deepfilternet
   ```

9. **说话人分离 pyannote.audio**（多人对话场景）
   ```bash
   VENV="$HOME/Library/Application Support/com.vera.veralabel/venv"
   "$VENV/bin/pip" install pyannote.audio torch
   ```
   > 注意：还需在 https://hf.co/pyannote/speaker-diarization-3.1 接受许可，
   > 并设置环境变量 `HUGGINGFACE_HUB_TOKEN=hf_xxxxxxxx`

---

全部安装完成后，重新启动 Vera Label，进入「环境检查」页面确认所有项为绿色即可。
