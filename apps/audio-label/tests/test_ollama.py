"""测试 ollama.py 中的纯逻辑函数（不需要真实 Ollama 连接）。"""
from __future__ import annotations

import pytest

from audio_label.infra.ollama import categorize_models, is_multimodal


# ── is_multimodal ─────────────────────────────────────────

@pytest.mark.parametrize("name,expected", [
    ("qwen3-vl:8b",    True),
    ("llava:7b",       True),
    ("minicpm-v:3b",   True),
    ("gemma3:4b",      True),
    ("vision-pro:13b", True),
    ("qwen3.5:9b",     False),
    ("gemma2:2b",      False),  # gemma2 不含 gemma3
    ("deepseek:7b",    False),
    ("phi4:14b",       False),
    ("",               False),
])
def test_is_multimodal(name, expected):
    assert is_multimodal(name) is expected


# ── categorize_models ─────────────────────────────────────

def test_categorize_models_empty():
    result = categorize_models([])
    assert result == {"asr_models": [], "llm_models": []}


def test_categorize_models_all_llm_only():
    models = [
        {"name": "qwen3.5:9b", "size": 5_000_000_000},
        {"name": "gemma2:2b",  "size": 1_500_000_000},
    ]
    result = categorize_models(models)
    assert result["asr_models"] == []
    assert len(result["llm_models"]) == 2


def test_categorize_models_multimodal_in_both_lists():
    """多模态模型同时出现在 asr_models 和 llm_models。"""
    models = [
        {"name": "qwen3-vl:8b", "size": 4_000_000_000},
        {"name": "qwen3.5:9b",  "size": 5_000_000_000},
    ]
    result = categorize_models(models)
    asr_names = [m["name"] for m in result["asr_models"]]
    llm_names = [m["name"] for m in result["llm_models"]]
    assert "qwen3-vl:8b" in asr_names
    assert "qwen3-vl:8b" in llm_names   # 多模态也可做 LLM 标注
    assert "qwen3.5:9b" not in asr_names
    assert "qwen3.5:9b" in llm_names


def test_categorize_models_preserves_name_and_size():
    models = [{"name": "llava:13b", "size": 7_000_000_000, "extra": "ignored"}]
    result = categorize_models(models)
    assert result["asr_models"][0] == {"name": "llava:13b", "size": 7_000_000_000}
