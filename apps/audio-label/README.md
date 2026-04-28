# VeraLabel

本地**音频批量标注**工具。支持 CLI 和桌面 GUI 两种用法，四种 ASR 转写后端，内置 LLM 自动标注流水线。

| 后端 | 模型 | 参数量 | 适用场景 | 运行要求 |
|------|------|--------|----------|----------|
| `qwen3` | Qwen3-ASR | 0.6B / 1.7B | 中文 + 多语言，精度最高 | Apple Silicon + MLX |
| `parakeet` | Parakeet TDT | 0.6B | 英文极速（RTFx >2000） | Apple Silicon + MLX |
| `vibevoice` | VibeVoice-ASR | 9B | 长音频（60min）、说话人分离 | GPU / 大内存 |
| `gemma` | Gemma 4 E4B | 4.5B | 多模态理解（限 30s） | GPU / 大内存 |
| `ollama:<model>` | 任意 Ollama 多模态模型 | - | 本地 Ollama 已安装的模型 | Ollama |

---

## 前置依赖

| 依赖 | 说明 |
|------|------|
| Python 3.12 | `brew install python@3.12` |
| Node.js >= 18 | 仅 GUI 开发需要 |
| Rust / Cargo | 仅 GUI 开发需要 |
| ffmpeg（可选）| 处理非 WAV 格式：`brew install ffmpeg` |
| Apple Silicon | `qwen3` / `parakeet` 后端必须 |
| Ollama | `ollama` 后端必须，[安装](https://ollama.com) |

---

## 本地开发

### 第一步：一键安装依赖

```bash
bash scripts/setup-dev.sh
```

脚本会创建 `.venv`、安装 Python 包（mlx + server + dev）、安装前端 npm 依赖。

### 第二步：启动

**方式 A — GUI（推荐）**

```bash
bash dev.sh
```

Tauri 会自动从 `.venv` 启动 Python 后端，无需另开终端。

**方式 B — 分离启动（前后端独立调试）**

```bash
# 终端 1：后端
bash scripts/dev-server.sh

# 终端 2：前端
cd gui && npm run dev
```

**方式 C — 仅 CLI**

```bash
source .venv/bin/activate
veralabel doctor           # 环境检查
veralabel annotate ./audio # 批量转写
```

---

## CLI 命令

### `annotate` — 批量转写 + LLM 标注

```bash
# 仅 ASR（默认 qwen3 后端，输出 annotations.jsonl）
veralabel annotate ./audio

# ASR + LLM 自动标注
veralabel annotate ./audio --llm-model qwen3.5:9b --llm-prompt asr-correction

# Ollama ASR + 提示词注入 + LLM 标注，输出 CSV
veralabel annotate ./audio \
  --backend ollama:qwen3-vl:8b \
  --asr-prompt asr-correction \
  --llm-model qwen3.5:9b \
  --llm-prompt asr-correction \
  --format csv -o result.csv
```

| 参数 | 说明 | 默认 |
|------|------|------|
| `PATHS` | 音频文件或目录，支持多个 | 必填 |
| `--backend, -b` | ASR 后端，见上方表格 | `qwen3` |
| `--model, -m` | 模型大小（qwen3: `0.6B`/`1.7B`） | `0.6B` |
| `--asr-prompt` | 注入 Ollama ASR 的提示词名称 | - |
| `--llm-model` | LLM 标注模型（Ollama） | - |
| `--llm-prompt` | LLM 标注提示词名称 | - |
| `--format, -f` | `jsonl` 或 `csv` | `jsonl` |
| `--output, -o` | 输出路径 | `annotations.jsonl` |
| `--llm-workers` | LLM 并发数 | `2` |
| `--prompts-dir` | 提示词目录 | `./prompts` |
| `--skip-check` | 跳过环境预检 | `False` |

### `doctor` — 环境检查

```bash
veralabel doctor             # 严格模式（默认）
veralabel doctor --no-strict # 宽松模式
```

### `prompts` — 列出可用提示词

```bash
veralabel prompts
veralabel prompts --dir ./my-prompts
```

### `version`

```bash
veralabel version
```

---

## 测试

```bash
bash scripts/test.sh           # 运行全套测试
bash scripts/test.sh -v        # 详细输出
bash scripts/test.sh tests/test_cli.py  # 单模块
```

或直接用 pytest：

```bash
source .venv/bin/activate
pytest tests/
```

---

## 性能基准测试

测试全流程（ASR + LLM + 提示词 + 中文分词）的实际吞吐率。

音频文件通过软链接 `bench/audio` 指向本机音频目录（gitignored），报告写入 `bench/reports/<timestamp>/`（gitignored）。

```bash
# 默认：qwen3-vl:8b ASR + qwen3.5:9b LLM，处理 bench/audio 下全部文件
python bench/run_bench.py

# 仅测 ASR
python bench/run_bench.py --no-llm

# 自定义模型，限制 5 个文件快速验证
python bench/run_bench.py --asr-model qwen3-vl:8b --llm-model qwen3.5:9b --limit 5

# 指定其他音频目录
python bench/run_bench.py --audio-dir /path/to/wav
```

**报告内容**

| 文件 | 说明 |
|------|------|
| `results.jsonl` | 完整标注产物（与主流程格式相同）|
| `bench.json` | 机器可读计时汇总 |
| `bench.md` | 人类可读报告（RTF、吞吐率、逐文件明细）|

---

## 打包发布

```bash
bash build.sh
```

交互式选择版本号（patch / minor / major），然后依次执行：

1. 同步版本号到所有文件
2. PyInstaller 打包 Python 二进制
3. 前端 build
4. Tauri release 构建

产出物：`gui/src-tauri/target/release/bundle/dmg/*.dmg`

---

## 项目结构

```
veralabel/
├── src/audio_label/
│   ├── cli.py                # CLI 入口
│   ├── server.py             # FastAPI HTTP API（供 GUI 调用）
│   ├── transcribers/         # ASR 后端（qwen3 / parakeet / vibevoice / gemma / ollama）
│   ├── pipeline/             # 核心流水线（scanner / scheduler / annotator / labeler / exporter）
│   └── infra/                # 基础设施（ollama / metrics / mem_monitor / preflight）
├── gui/                      # Tauri + Svelte 桌面客户端
├── prompts/                  # 提示词文件（*.md）
├── bench/                    # 性能基准测试
│   ├── run_bench.py
│   ├── audio -> ~/Downloads  # 软链接（gitignored）
│   └── reports/              # 测试报告（gitignored）
├── tests/                    # 自动化测试
├── scripts/
│   ├── setup-dev.sh          # 一键安装开发依赖
│   ├── dev-server.sh         # 启动后端开发服务
│   ├── test.sh               # 运行测试
│   └── build-python.sh       # PyInstaller 打包
├── build.sh                  # 一键发布脚本
└── pyproject.toml
```

---

## 输出格式

### JSONL（默认）

每行一条记录，流式写入，支持增量追加：

```jsonl
{"file": "/path/audio.wav", "text": "你好，欢迎使用。", "language": "zh", "duration_sec": 5.2, "segments": [...], "label": {...}}
```

### CSV

```
file,text,language,duration_sec,sample_rate,segments,label
/path/audio.wav,你好，欢迎使用。,zh,5.2,16000,"[...]","[...]"
```

---

## 支持的音频格式

`.wav` `.mp3` `.m4a` `.flac` `.ogg` `.opus` `.webm` `.aac`

> 非 WAV 格式需安装 ffmpeg：`brew install ffmpeg`

---

## 常见问题

**Q: GUI 启动报"无法启动 Python 服务"？**

确保已在项目根目录完成 `bash scripts/setup-dev.sh`，Tauri 通过遍历父目录查找 `.venv/bin/veralabel`。

**Q: `doctor` 提示「未安装 MLX」？**

确保在 Apple Silicon Mac 上运行，并执行 `pip install -e ".[mlx]"`。

**Q: 转写非 WAV 文件报错？**

安装 ffmpeg：`brew install ffmpeg`。

**Q: Gemma 4 截断了音频？**

Gemma 4 限制 30 秒，长音频请改用 `qwen3` 或 `vibevoice`。
