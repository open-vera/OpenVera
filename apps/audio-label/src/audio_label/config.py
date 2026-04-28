"""预检与模型相关的默认配置。"""

# Ollama 中常见与「语音/多模态/标注」相关的模型名片段（小写匹配）
OLLAMA_MODEL_HINTS: tuple[str, ...] = (
    "qwen",
    "whisper",
    "parakeet",
    "phi",
    "gemma",
    "granite",  # IBM，部分场景作 ASR/语音辅助
)

# 支持的音频文件扩展名
AUDIO_EXTENSIONS: frozenset[str] = frozenset(
    {".wav", ".mp3", ".m4a", ".flac", ".ogg", ".opus", ".webm", ".aac"}
)

# ── 后端模型 ID ──────────────────────────────────────────

# Qwen3-ASR (MLX)
DEFAULT_MODEL_SIZE = "0.6B"
MLX_MODEL_ID_TPL = "Qwen/Qwen3-ASR-{size}"

# Parakeet TDT (MLX)
PARAKEET_MODEL_ID = "mlx-community/parakeet-tdt-0.6b-v3"

# VibeVoice-ASR (Transformers)
VIBEVOICE_MODEL_ID = "microsoft/VibeVoice-ASR-HF"

# Gemma 4 (Transformers)
GEMMA_MODEL_ID = "google/gemma-4-E4B-it"

# 默认后端
DEFAULT_BACKEND = "qwen3"

# Ollama API 地址
OLLAMA_BASE_URL = "http://localhost:11434"

# ── 文档链接 ─────────────────────────────────────────────
URL_OLLAMA = "https://ollama.com/download"
URL_MLX = "https://github.com/ml-explore/mlx"
URL_QWEN_ASR = "https://huggingface.co/collections/Qwen/qwen3-asr"
