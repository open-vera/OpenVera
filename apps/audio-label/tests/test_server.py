"""测试 FastAPI 端点（不依赖真实模型或 Ollama）。"""
from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

import audio_label.server as srv
from audio_label.server import app


@pytest.fixture(autouse=True)
def reset_events():
    """每个测试前重置 pause/stop 状态，防止测试间污染。"""
    srv._stop_event.clear()
    srv._pause_event.set()
    yield
    srv._stop_event.clear()
    srv._pause_event.set()


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def prompts_dir(tmp_path, monkeypatch):
    """将服务端的 _PROMPTS_DIR 指向临时目录。"""
    monkeypatch.setattr(srv, "_PROMPTS_DIR", tmp_path)
    return tmp_path


# ── /api/health ───────────────────────────────────────────

def test_health_ok(client):
    with patch("audio_label.infra.ollama.ollama_list", return_value=[]):
        resp = client.get("/api/health")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "ok"
    assert "backends" in data
    assert data["ollama_available"] is False


def test_health_ollama_available(client):
    with patch("audio_label.infra.ollama.ollama_list", return_value=[{"name": "qwen3.5:9b"}]):
        resp = client.get("/api/health")
    assert resp.json()["ollama_available"] is True


# ── /api/prompts ──────────────────────────────────────────

def test_list_prompts_empty(client, prompts_dir):
    resp = client.get("/api/prompts")
    assert resp.status_code == 200
    assert resp.json()["prompts"] == []


def test_create_and_list_prompt(client, prompts_dir):
    resp = client.post("/api/prompts", json={"name": "纠错", "content": "请纠错以下内容"})
    assert resp.status_code == 200
    assert resp.json()["ok"] is True

    resp = client.get("/api/prompts")
    prompts = resp.json()["prompts"]
    assert len(prompts) == 1
    assert prompts[0]["name"] == "纠错"
    assert prompts[0]["content"] == "请纠错以下内容"


def test_create_prompt_saves_md_file(client, prompts_dir):
    client.post("/api/prompts", json={"name": "翻译", "content": "翻译为英文"})
    assert (prompts_dir / "翻译.md").exists()
    assert (prompts_dir / "翻译.md").read_text(encoding="utf-8") == "翻译为英文"


def test_delete_prompt(client, prompts_dir):
    (prompts_dir / "test.md").write_text("内容", encoding="utf-8")
    resp = client.delete("/api/prompts?name=test")
    assert resp.status_code == 200
    assert not (prompts_dir / "test.md").exists()


def test_delete_nonexistent_prompt(client, prompts_dir):
    resp = client.delete("/api/prompts?name=不存在")
    assert resp.status_code == 404


def test_list_prompts_sorted(client, prompts_dir):
    for name in ["z提示词", "a提示词", "m提示词"]:
        (prompts_dir / f"{name}.md").write_text("内容", encoding="utf-8")
    names = [p["name"] for p in client.get("/api/prompts").json()["prompts"]]
    assert names == sorted(names)


def test_prompt_preview_truncated(client, prompts_dir):
    (prompts_dir / "long.md").write_text("A" * 500, encoding="utf-8")
    prompts = client.get("/api/prompts").json()["prompts"]
    assert len(prompts[0]["preview"]) <= 200


# ── /api/annotate/pause, resume, stop ────────────────────

def test_pause_clears_event(client):
    assert srv._pause_event.is_set()
    resp = client.post("/api/annotate/pause")
    assert resp.status_code == 200
    assert resp.json()["ok"] is True
    assert not srv._pause_event.is_set()


def test_resume_sets_event(client):
    srv._pause_event.clear()
    resp = client.post("/api/annotate/resume")
    assert resp.status_code == 200
    assert srv._pause_event.is_set()


def test_stop_sets_stop_event(client):
    assert not srv._stop_event.is_set()
    resp = client.post("/api/annotate/stop")
    assert resp.status_code == 200
    assert resp.json()["ok"] is True
    assert srv._stop_event.is_set()


def test_stop_unblocks_paused(client):
    """stop 时若处于暂停中，应同时解除 pause，避免 worker 死锁。"""
    srv._pause_event.clear()  # 模拟暂停中
    client.post("/api/annotate/stop")
    assert srv._stop_event.is_set()
    assert srv._pause_event.is_set()  # 已解除暂停


def test_pause_resume_cycle(client):
    client.post("/api/annotate/pause")
    assert not srv._pause_event.is_set()
    client.post("/api/annotate/resume")
    assert srv._pause_event.is_set()
    assert not srv._stop_event.is_set()
