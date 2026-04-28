"""Ollama HTTP 客户端：封装 REST API 调用，供 ASR 转写和 LLM 标注共用。"""

from __future__ import annotations

import base64
from pathlib import Path

import httpx

OLLAMA_BASE = "http://localhost:11434"
_TIMEOUT = 300  # 模型推理可能较慢

# 多模态模型关键词（用于判断是否可做 ASR）
MULTIMODAL_HINTS: tuple[str, ...] = (
    "vl", "vision", "llava", "minicpm-v", "gemma3",
)

# 模块级持久连接池，避免每次请求都建立新连接
_client = httpx.Client(timeout=_TIMEOUT, limits=httpx.Limits(max_connections=20))
_list_client = httpx.Client(timeout=5)


def ollama_list() -> list[dict]:
    """获取本地已安装的 Ollama 模型列表。

    Returns
    -------
    list[dict]
        每项包含 name, size 等字段。空列表表示 Ollama 不可用。
    """
    try:
        resp = _list_client.get(f"{OLLAMA_BASE}/api/tags")
        resp.raise_for_status()
        return resp.json().get("models", [])
    except (httpx.HTTPError, OSError):
        return []


def ollama_chat(
    model: str,
    messages: list[dict],
    *,
    temperature: float = 0.1,
    stream: bool = False,
) -> str:
    """调用 Ollama Chat API，返回助手回复文本。

    Parameters
    ----------
    model : str
        Ollama 模型名（如 "qwen3.5:9b"）
    messages : list[dict]
        聊天消息列表，格式同 OpenAI
    temperature : float
        生成温度，默认 0.1 保证稳定输出
    stream : bool
        是否流式（当前仅支持非流式）
    """
    resp = _client.post(
        f"{OLLAMA_BASE}/api/chat",
        json={
            "model": model,
            "messages": messages,
            "stream": stream,
            "options": {"temperature": temperature},
        },
    )
    resp.raise_for_status()
    return resp.json()["message"]["content"]


def ollama_unload_all() -> None:
    """卸载所有当前加载在 Ollama 内存中的模型，立即释放显存/内存。"""
    try:
        resp = _list_client.get(f"{OLLAMA_BASE}/api/ps")
        resp.raise_for_status()
        running = resp.json().get("models", [])
    except (httpx.HTTPError, OSError):
        return
    for m in running:
        name = m.get("name") or m.get("model", "")
        if not name:
            continue
        try:
            _client.post(
                f"{OLLAMA_BASE}/api/chat",
                json={"model": name, "messages": [], "keep_alive": 0},
            )
        except (httpx.HTTPError, OSError):
            pass


def audio_to_base64(path) -> str:
    """将音频文件读取并编码为 base64 字符串。"""
    return base64.b64encode(path.read_bytes()).decode("ascii")


def is_multimodal(model_name: str) -> bool:
    """判断模型是否为多模态模型（可处理音频/图像）。"""
    name_lower = model_name.lower()
    return any(hint in name_lower for hint in MULTIMODAL_HINTS)


def categorize_models(models: list[dict]) -> dict:
    """将 Ollama 模型分为 ASR 可用（多模态）和 LLM 标注可用两类。

    Returns
    -------
    dict
        {"asr_models": [...], "llm_models": [...]}
    """
    asr_models = []
    llm_models = []
    for m in models:
        name = m.get("name", "")
        info = {"name": name, "size": m.get("size", 0)}
        if is_multimodal(name):
            asr_models.append(info)
        llm_models.append(info)  # 所有模型都可用于 LLM 标注
    return {"asr_models": asr_models, "llm_models": llm_models}
