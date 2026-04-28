"""FastAPI 服务：为 Tauri GUI 提供 HTTP API。"""
from __future__ import annotations

import asyncio
import hashlib
import json
import queue
import subprocess
import sys
import threading
from pathlib import Path
from typing import AsyncGenerator, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from audio_label.infra.runtime import data_dir, inject_ml_venv, inject_system_path, is_bundled, ml_venv_pip, ml_venv_python
from audio_label.pipeline.scanner import scan_audio_files
from audio_label.transcribers import BACKENDS, create_transcriber

# ── 路径：bundled 模式使用用户数据目录 ──────────────────
if is_bundled():
    _DATA_DIR = data_dir()
    _DATA_DIR.mkdir(parents=True, exist_ok=True)
    _PROMPTS_DIR = _DATA_DIR / "prompts"
    _STATE_FILE = _DATA_DIR / ".app_state.json"
    # 注入 ML venv 的 site-packages 到 sys.path
    inject_ml_venv()
else:
    _PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
    _PROMPTS_DIR = _PROJECT_ROOT / "prompts"
    _STATE_FILE = _PROJECT_ROOT / ".app_state.json"

app = FastAPI(title="VeraLabel", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── 全局缓存 ─────────────────────────────────────────

_progress_queue: queue.Queue[dict] = queue.Queue(maxsize=2000)

# 缓存已加载的 transcriber，避免每次重新加载模型
# 限制最多缓存 1 个模型，切换时主动释放旧模型内存
_transcriber_cache: dict[str, object] = {}  # key: "backend:model_size"
_MAX_CACHED_MODELS = 1

# 当前标注任务的 LLM 并发数（供 /api/system-stats 读取）
_current_llm_workers: int = 0
_transcriber_cache_lock: threading.Lock = threading.Lock()
_current_llm_workers_lock: threading.Lock = threading.Lock()

# 标注任务暂停/停止控制
# _pause_event: set = 可继续执行；clear = 暂停中（asr_worker 会轮询等待）
# _stop_event:  set = 要求终止
_pause_event: threading.Event = threading.Event()
_pause_event.set()  # 初始可运行
_stop_event: threading.Event = threading.Event()

# ── 安全命令白名单 ──────────────────────────────────

def _allowed_prefixes() -> tuple[str, ...]:
    base = (
        "pip install", "pip uninstall",
        "brew install",
        "ollama pull",
        "/bin/bash -c ",          # Homebrew 安装脚本
        "python3 -m venv ",       # ML venv 创建
        sys.executable + " -m pip install",
        sys.executable + " -m pip uninstall",
        sys.executable + " -c ",
    )
    if is_bundled():
        venv_pip = ml_venv_pip()
        venv_py = ml_venv_python()
        return base + (venv_pip + " install", venv_pip + " uninstall", venv_py + " -c ")
    return base


def _pip_install_cmd(pkg: str) -> str:
    """返回安装指定包的 pip 命令。bundled 模式使用 ML venv 的 pip。"""
    if is_bundled():
        return f"{ml_venv_pip()} install {pkg}"
    return f"{sys.executable} -m pip install {pkg}"


def _python_exec_cmd(code: str) -> str:
    """返回执行 Python 代码的命令。bundled 模式使用 ML venv 的 python。"""
    if is_bundled():
        return f'{ml_venv_python()} -c "{code}"'
    return f'{sys.executable} -c "{code}"'


def _check_cmd(cmd: str) -> str:
    cmd = cmd.strip()
    if not any(cmd.startswith(p) for p in _allowed_prefixes()):
        raise HTTPException(400, f"不允许执行此命令：{cmd}")
    return cmd


# ── 请求模型 ─────────────────────────────────────────

class ScanRequest(BaseModel):
    paths: list[str]


class AnnotateRequest(BaseModel):
    files: list[str]
    backend: str = "qwen3"
    model_size: str = "0.6B"
    format: str = "json"
    output: Optional[str] = None
    prompt: Optional[str] = None
    # 并行流水线：LLM 后处理字段（可选；不传则纯 ASR）
    llm_model: Optional[str] = None
    prompt_name: Optional[str] = None
    prompt_content: Optional[str] = None
    llm_workers: int = 2  # LLM 初始并发数（Phase 2）
    # 质量增强选项
    denoise: bool = False           # DeepFilterNet 降噪预处理
    diarize: bool = False           # pyannote 说话人分离
    num_speakers: Optional[int] = None  # 已知说话人数，None = 自动推断


class PromptRequest(BaseModel):
    name: str
    content: str


class InstallRequest(BaseModel):
    cmd: str


class UninstallRequest(BaseModel):
    model_id: str


class SaveAnnotationsRequest(BaseModel):
    output_dir: str
    file: str
    annotations: list[dict]
    corrections: list[dict] | None = None  # [{seg_start, seg_end, original, corrected}]


class CerRequest(BaseModel):
    hypothesis: str
    reference: str


# ── 端点：健康检查 ───────────────────────────────────

@app.get("/api/health")
def health():
    from audio_label.infra.ollama import ollama_list
    ollama_available = len(ollama_list()) > 0
    return {"status": "ok", "backends": list(BACKENDS), "ollama_available": ollama_available}


@app.get("/api/memory")
def memory_usage():
    """返回当前进程内存用量及 transcriber 缓存状态（开发调试用）。"""
    from audio_label.infra.mem_monitor import get_rss_mb
    return {
        "rss_mb": round(get_rss_mb(), 1),
        "transcriber_cache": list(_transcriber_cache.keys()),
    }


@app.get("/api/system-stats")
def system_stats():
    """系统资源快照：CPU / 内存 / 热节流状态，供状态栏 3s 轮询。"""
    with _current_llm_workers_lock:
        llm_conc = _current_llm_workers
    try:
        import psutil
        mem = psutil.virtual_memory()
        cpu = psutil.cpu_percent(interval=0.1)
        thermal = False
        try:
            freq = psutil.cpu_freq()
            if freq and freq.current < freq.max * 0.7:
                thermal = True
        except Exception:
            pass
        return {
            "cpu_percent": round(cpu, 1),
            "memory_used_gb": round((mem.total - mem.available) / (1024 ** 3), 1),
            "memory_total_gb": round(mem.total / (1024 ** 3), 1),
            "memory_percent": round(mem.percent, 1),
            "gpu_percent": None,   # macOS GPU 需要 sudo powermetrics，暂不支持
            "temperature": None,
            "thermal_throttled": thermal,
            "model_memory": {"asr": None, "llm": None},
            "llm_concurrency": llm_conc,
        }
    except ImportError:
        return {
            "cpu_percent": 0.0,
            "memory_used_gb": 0.0,
            "memory_total_gb": 0.0,
            "memory_percent": 0.0,
            "gpu_percent": None,
            "temperature": None,
            "thermal_throttled": False,
            "model_memory": {"asr": None, "llm": None},
            "llm_concurrency": llm_conc,
        }


@app.get("/api/state")
def get_state():
    """读取持久化的应用状态。"""
    if _STATE_FILE.exists():
        return json.loads(_STATE_FILE.read_text(encoding="utf-8"))
    return {}


class StateUpdate(BaseModel):
    key: str
    value: str


@app.put("/api/state")
def update_state(req: StateUpdate):
    """更新单个状态字段。"""
    state = {}
    if _STATE_FILE.exists():
        state = json.loads(_STATE_FILE.read_text(encoding="utf-8"))
    state[req.key] = req.value
    _STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"ok": True}


# ── 端点：环境预检 ───────────────────────────────────

@app.get("/api/preflight")
def preflight():
    from audio_label.infra.preflight import (
        check_homebrew,
        check_python3,
        check_ml_venv,
        check_ffmpeg,
        check_forced_aligner,
        check_mlx,
        check_mlx_asr_model,
        check_ollama_binary,
        check_ollama_models,
        check_pyannote,
        check_deepfilternet,
    )

    checks = [
        check_homebrew(),
        check_python3(),
        check_ml_venv(),
        check_ollama_binary(),
        check_ollama_models(),
        check_mlx(),
        check_mlx_asr_model(),
        check_forced_aligner(),
        check_ffmpeg(),
        check_pyannote(),
        check_deepfilternet(),
    ]

    ollama_ok = checks[3].ok and checks[4].ok
    mlx_ok = checks[5].ok and checks[6].ok

    return {
        "checks": [
            {"name": c.name, "ok": c.ok, "detail": c.detail, "install_cmd": c.install_cmd}
            for c in checks
        ],
        "ready": ollama_ok or mlx_ok,
    }


# ── 端点：安装（SSE 流式日志）────────────────────────

@app.get("/api/install")
def install_stream(cmd: str) -> StreamingResponse:
    """SSE 流式执行安装命令，实时输出日志。"""
    cmd = _check_cmd(cmd)

    def generate():
        # bundled 模式下确保 ML venv 存在
        if is_bundled():
            from audio_label.infra.runtime import ensure_ml_venv
            try:
                yield f"data: {json.dumps({'event': 'log', 'line': '准备 Python 环境…'})}\n\n"
                ensure_ml_venv()
            except Exception as e:
                yield f"data: {json.dumps({'event': 'done', 'ok': False, 'error': f'创建 Python 环境失败：{e}'})}\n\n"
                return

        yield f"data: {json.dumps({'event': 'start', 'cmd': cmd})}\n\n"
        proc = None
        try:
            # shell=True 以支持 && 、$() 等 shell 语法（Homebrew / venv 初始化需要）
            proc = subprocess.Popen(
                cmd,
                shell=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
            )
            for line in iter(proc.stdout.readline, ""):
                yield f"data: {json.dumps({'event': 'log', 'line': line.rstrip()})}\n\n"
            proc.wait(timeout=300)
            ok = proc.returncode == 0
            yield f"data: {json.dumps({'event': 'done', 'ok': ok, 'code': proc.returncode})}\n\n"
        except Exception as e:
            if proc is not None:
                try:
                    proc.kill()
                except Exception:
                    pass
            yield f"data: {json.dumps({'event': 'done', 'ok': False, 'error': str(e)})}\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ── 端点：模型管理 ───────────────────────────────────

# 可管理的模型目录
def _model_registry() -> list[dict]:
    return [
        {
            "id": "qwen3-asr-0.6B",
            "name": "Qwen3-ASR 0.6B",
            "size": "~1.2 GB",
            "pip_pkg": "mlx-qwen3-asr",
            "hf_pattern": "models--Qwen--Qwen3-ASR-0.6B",
            "install_cmd": _pip_install_cmd("mlx-qwen3-asr"),
        },
        {
            "id": "qwen3-asr-1.7B",
            "name": "Qwen3-ASR 1.7B",
            "size": "~3.4 GB",
            "pip_pkg": None,
            "hf_pattern": "models--Qwen--Qwen3-ASR-1.7B",
            "install_cmd": _python_exec_cmd("from mlx_qwen3_asr import Session; Session(model='Qwen/Qwen3-ASR-1.7B')"),
        },
        {
            "id": "parakeet-tdt",
            "name": "Parakeet TDT 0.6B",
            "size": "~1.1 GB",
            "pip_pkg": "parakeet-mlx",
            "hf_pattern": "models--mlx-community--parakeet-tdt*",
            "install_cmd": _pip_install_cmd("parakeet-mlx"),
        },
    ]


def _hf_cache() -> Path:
    return Path.home() / ".cache" / "huggingface" / "hub"


def _is_model_cached(backend: str, model_size: str) -> bool:
    """检查模型权重是否已在 HuggingFace 缓存中。"""
    cache = _hf_cache()
    if not cache.exists():
        return False
    if backend == "qwen3":
        return bool(list(cache.glob(f"models--Qwen--Qwen3-ASR-{model_size}*")))
    if backend == "parakeet":
        return bool(list(cache.glob("models--mlx-community--parakeet-tdt*")))
    return False


def _is_model_installed(m: dict) -> bool:
    from importlib.util import find_spec

    # 检查 pip 包
    pkg_name = m["pip_pkg"].replace("-", "_") if m["pip_pkg"] else None
    if pkg_name and find_spec(pkg_name) is None:
        return False
    # 检查 HF 缓存中的权重
    cache = _hf_cache()
    if cache.exists() and list(cache.glob(m["hf_pattern"])):
        return True
    # 有包但没权重也算「部分安装」，标为 True（首次使用会下载）
    if pkg_name and find_spec(pkg_name):
        return True
    return False


@app.get("/api/models")
def list_models():
    registry = _model_registry()
    models = []
    for m in registry:
        models.append({
            "id": m["id"],
            "name": m["name"],
            "size": m["size"],
            "installed": _is_model_installed(m),
            "install_cmd": m["install_cmd"],
        })
    installed_count = sum(1 for m in models if m["installed"])
    return {"models": models, "installed_count": installed_count}


@app.post("/api/models/uninstall")
def uninstall_model(req: UninstallRequest):
    registry = _model_registry()
    # 查找模型
    m = next((m for m in registry if m["id"] == req.model_id), None)
    if not m:
        raise HTTPException(404, f"未知模型：{req.model_id}")

    # 检查是否是最后一个
    installed = [x for x in registry if _is_model_installed(x)]
    if len(installed) <= 1:
        raise HTTPException(400, "至少需要保留一个已安装的模型")

    errors = []

    # 卸载 pip 包
    if m["pip_pkg"]:
        try:
            pip_exe = ml_venv_python() if is_bundled() else sys.executable
            subprocess.run(
                [pip_exe, "-m", "pip", "uninstall", "-y", m["pip_pkg"]],
                capture_output=True, text=True, timeout=60,
            )
        except Exception as e:
            errors.append(f"pip uninstall 失败：{e}")

    # 删除 HF 缓存
    cache = _hf_cache()
    if cache.exists():
        import shutil
        for d in cache.glob(m["hf_pattern"]):
            try:
                shutil.rmtree(d)
            except Exception as e:
                errors.append(f"删除缓存失败：{e}")

    return {"ok": len(errors) == 0, "errors": errors}


# ── 端点：提示词管理 ─────────────────────────────────

@app.get("/api/prompts")
def list_prompts():
    _PROMPTS_DIR.mkdir(exist_ok=True)
    prompts = []
    for f in sorted(_PROMPTS_DIR.glob("*.md")):
        content = f.read_text(encoding="utf-8")
        prompts.append({
            "name": f.stem,
            "content": content,
            "preview": content[:100].replace("\n", " "),
        })
    return {"prompts": prompts}


@app.post("/api/prompts")
def save_prompt(req: PromptRequest):
    import re
    _PROMPTS_DIR.mkdir(exist_ok=True)
    name = req.name.strip()
    if not name or not re.match(r'^[\w\-]+$', name):
        raise HTTPException(400, "提示词名称只能包含字母、数字、下划线和连字符")
    path = _PROMPTS_DIR / f"{name}.md"
    path.write_text(req.content, encoding="utf-8")
    return {"ok": True, "path": str(path)}


@app.delete("/api/prompts")
def delete_prompt(name: str):
    import re
    if not name or not re.match(r'^[\w\-]+$', name):
        raise HTTPException(400, "无效的提示词名称")
    path = _PROMPTS_DIR / f"{name}.md"
    if not path.exists():
        raise HTTPException(404, f"提示词不存在：{name}")
    path.unlink()
    return {"ok": True}


# ── 端点：结果读取 ───────────────────────────────────

@app.get("/api/results")
def read_results(path: str):
    """读取本地 JSON 结果文件。"""
    p = Path(path)
    if not p.is_file():
        raise HTTPException(404, f"文件不存在：{path}")
    return json.loads(p.read_text(encoding="utf-8"))


@app.post("/api/cer")
def compute_cer(req: CerRequest):
    """计算字错误率 (CER)，用于量化 ASR 转写质量。"""
    from audio_label.infra.metrics import calculate_cer
    cer = calculate_cer(req.hypothesis, req.reference)
    return {"cer": round(cer, 4)}


@app.post("/api/save-annotations")
def save_manual_annotations(req: SaveAnnotationsRequest):
    """将手动标注保存到 label-result/ 目录下的独立文件。"""
    result_dir = Path(req.output_dir)
    if not result_dir.exists():
        result_dir.mkdir(parents=True, exist_ok=True)

    # 保存到 manual_annotations.json，按文件名索引
    ann_file = result_dir / "manual_annotations.json"
    data: dict = {}
    if ann_file.exists():
        data = json.loads(ann_file.read_text(encoding="utf-8"))
    data[req.file] = req.annotations
    ann_file.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

    # 保存人工修正记录到 corrections.jsonl（用于主动学习分析）
    if req.corrections:
        from audio_label.infra.metrics import calculate_cer
        from datetime import datetime
        corrections_file = result_dir / "corrections.jsonl"
        ts = datetime.now().isoformat()
        with corrections_file.open("a", encoding="utf-8") as f:
            for corr in req.corrections:
                original = corr.get("original", "")
                corrected = corr.get("corrected", "")
                cer = calculate_cer(original, corrected) if original or corrected else None
                record = {
                    "file": req.file,
                    "seg_start": corr.get("seg_start"),
                    "seg_end": corr.get("seg_end"),
                    "original": original,
                    "corrected": corrected,
                    "cer": round(cer, 4) if cer is not None else None,
                    "ts": ts,
                }
                f.write(json.dumps(record, ensure_ascii=False) + "\n")

    # 每次数据变更后自动重新合并 final.jsonl（仅当 records.jsonl 存在时才有意义）
    if (result_dir / "records.jsonl").exists():
        from audio_label.pipeline.exporter import merge_export
        merge_export(result_dir)

    return {"ok": True}


# ── 端点：音频播放 ───────────────────────────────────

@app.get("/api/audio")
def serve_audio(path: str):
    """流式返回音频文件，供前端播放。"""
    from starlette.responses import FileResponse

    p = Path(path)
    if not p.is_file():
        raise HTTPException(404, f"文件不存在：{path}")

    # 根据扩展名设置 MIME
    mime_map = {
        ".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4",
        ".flac": "audio/flac", ".ogg": "audio/ogg", ".opus": "audio/opus",
        ".webm": "audio/webm", ".aac": "audio/aac",
    }
    mime = mime_map.get(p.suffix.lower(), "application/octet-stream")
    return FileResponse(str(p), media_type=mime)


# ── 端点：扫描 ───────────────────────────────────────

@app.post("/api/scan")
def scan(req: ScanRequest):
    audio_files = scan_audio_files(req.paths)
    result = []
    for af in audio_files:
        size = None
        try:
            size = af.path.stat().st_size
        except OSError:
            pass
        result.append({
            "path": str(af.path),
            "name": af.path.name,
            "duration_sec": af.duration_sec,
            "sample_rate": af.sample_rate,
            "channels": af.channels,
            "size_bytes": size,
        })
    return result


# ── 端点：Ollama 模型 ──────────────────────────────────

@app.get("/api/ollama-models")
def ollama_models():
    """返回 Ollama 已安装模型，分为 ASR 可用（多模态）和 LLM 标注可用。"""
    from audio_label.infra.ollama import ollama_list, categorize_models
    models = ollama_list()
    if not models:
        return {"available": False, "asr_models": [], "llm_models": []}
    cats = categorize_models(models)
    return {"available": True, **cats}


class OllamaRmRequest(BaseModel):
    model: str


@app.post("/api/ollama/rm")
def ollama_rm(req: OllamaRmRequest):
    """卸载 Ollama 模型（ollama rm）。"""
    import re
    import subprocess
    # 只允许合法的模型名（字母、数字、:.-_），防注入
    if not re.match(r"^[a-zA-Z0-9][a-zA-Z0-9:._/-]*$", req.model):
        raise HTTPException(400, f"无效的模型名称：{req.model}")
    result = subprocess.run(
        ["ollama", "rm", req.model],
        capture_output=True, text=True, timeout=30,
    )
    output = (result.stdout + result.stderr).strip()
    return {"ok": result.returncode == 0, "output": output}


# ── 端点：LLM 标注 ────────────────────────────────────

class LabelRequest(BaseModel):
    file: str
    text: str
    segments: list[dict]
    prompt_name: str
    prompt_content: str
    model: str


@app.post("/api/label")
def label_file(req: LabelRequest):
    """调用 Ollama LLM 对转写结果做标注。同步返回。"""
    from audio_label.pipeline.labeler import label_transcript
    try:
        result = label_transcript(
            text=req.text,
            segments=req.segments,
            prompt_content=req.prompt_content,
            model=req.model,
            prompt_name=req.prompt_name,
        )
        return {"ok": True, "label": {
            "prompt_name": result.prompt_name,
            "model": result.model,
            "result": result.result,
            "segment_labels": result.segment_labels,
            "label_confidence": result.label_confidence,
            "sections": result.sections,
        }}
    except Exception as e:
        return {"ok": False, "error": str(e)}


# ── 端点：AI 标签人工确认/纠错 ────────────────────────────

class LabelCorrectionRequest(BaseModel):
    output_dir: str
    file: str
    prompt_name: str
    model: str
    ai_result: str
    human_result: str
    status: str  # "confirmed" | "corrected"


@app.post("/api/label-corrections")
def save_label_correction(req: LabelCorrectionRequest):
    """保存 AI 标注的人工确认/纠错记录，写入 label_corrections.jsonl。

    每次保存后触发 merge_export，使 annotations.json / final.jsonl 自动更新。
    """
    if req.status not in ("confirmed", "corrected"):
        raise HTTPException(400, f"无效 status：{req.status}")

    result_dir = Path(req.output_dir)
    if not result_dir.exists():
        result_dir.mkdir(parents=True, exist_ok=True)

    from datetime import datetime
    record = {
        "file": req.file,
        "prompt_name": req.prompt_name,
        "model": req.model,
        "status": req.status,
        "ai_result": req.ai_result,
        "human_result": req.human_result,
        "ts": datetime.now().isoformat(),
    }
    corr_file = result_dir / "label_corrections.jsonl"
    with corr_file.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")

    # 重新合并导出（仅当 records.jsonl 存在时有意义）
    if (result_dir / "records.jsonl").exists():
        from audio_label.pipeline.exporter import merge_export
        merge_export(result_dir)

    return {"ok": True}


# ── 端点：标注 ───────────────────────────────────────

@app.post("/api/annotate")
def annotate(req: AnnotateRequest):
    if not req.backend.startswith("ollama:") and req.backend not in BACKENDS:
        raise HTTPException(400, f"未知后端 '{req.backend}'，可选：{', '.join(BACKENDS)} 或 ollama:<模型名>")
    thread = threading.Thread(target=_run_annotate, args=(req,), daemon=True)
    thread.start()
    return {"status": "started", "total": len(req.files)}


@app.post("/api/annotate/pause")
def pause_annotate():
    """暂停标注任务（当前文件处理完后在文件间隙暂停）。"""
    _pause_event.clear()
    return {"ok": True}


@app.post("/api/annotate/resume")
def resume_annotate():
    """继续已暂停的标注任务。"""
    _pause_event.set()
    return {"ok": True}


@app.post("/api/annotate/stop")
def stop_annotate():
    """终止标注任务（已完成的文件结果不受影响）。"""
    _stop_event.set()
    _pause_event.set()  # 若暂停中，解除阻塞让 worker 检查 stop
    return {"ok": True}

def _download_model_with_logs(backend: str, model_size: str, log) -> None:
    """用子进程预下载模型权重，捕获 huggingface_hub 的进度输出。"""
    import re

    if backend == "qwen3":
        model_id = f"Qwen/Qwen3-ASR-{model_size}"
    elif backend == "parakeet":
        model_id = "mlx-community/parakeet-tdt-0.6b-v3"
    elif backend == "forced_aligner":
        model_id = f"Qwen/Qwen3-ForcedAligner-{model_size}"
    else:
        return  # 其他后端不支持预下载

    # 用 huggingface_hub.snapshot_download 下载，捕获 stderr 进度
    python_exe = ml_venv_python() if is_bundled() else sys.executable
    cmd = [
        python_exe, "-c",
        f"from huggingface_hub import snapshot_download; snapshot_download('{model_id}')"
    ]
    log(f"下载模型 {model_id}…")
    proc = None
    try:
        proc = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1,
        )
        last_pct = ""
        for line in iter(proc.stdout.readline, ""):
            line = line.rstrip()
            if not line:
                continue
            # 提取百分比进度（如 "Fetching 3 files:  30%|███"）
            m = re.search(r"(\d+)%\|", line)
            if m:
                pct = m.group(1)
                if pct != last_pct:
                    log(f"  下载进度：{pct}%")
                    last_pct = pct
            elif "Fetching" in line or "Downloading" in line:
                log(f"  {line[:120]}")
        proc.wait(timeout=600)
        if proc.returncode == 0:
            log("模型下载完成")
        else:
            log(f"模型下载可能有问题 (exit code {proc.returncode})")
    except Exception as e:
        if proc is not None:
            try:
                proc.kill()
            except Exception:
                pass
        log(f"下载过程出错：{e}")


def _evict_transcribers(log_fn=None) -> None:
    """清空 transcriber 缓存，主动释放模型内存。"""
    from audio_label.infra.mem_monitor import release_model_memory
    from audio_label.transcribers.qwen3 import stop_worker
    from audio_label.infra.ollama import ollama_unload_all
    if log_fn and _transcriber_cache:
        log_fn(f"释放旧模型缓存（{list(_transcriber_cache.keys())}）…")
    _transcriber_cache.clear()
    stop_worker()
    ollama_unload_all()
    release_model_memory()


def _put_progress(ev: dict) -> None:
    """线程安全地向进度队列写入事件，队列满时丢弃（不阻塞）。"""
    try:
        _progress_queue.put_nowait(ev)
    except queue.Full:
        pass


def _hash_files(files: list[str]) -> str:
    """对文件列表生成稳定哈希，用于 checkpoint 匹配同一批任务。"""
    return hashlib.md5("\n".join(sorted(files)).encode()).hexdigest()[:16]


def _run_annotate(req: AnnotateRequest) -> None:
    import time
    from datetime import datetime
    from audio_label.pipeline.annotator import AnnotationRecord
    from audio_label.pipeline.exporter import export_csv
    from audio_label.infra.mem_monitor import log_memory, MemoryWatcher
    from audio_label.infra.logger import setup_logging

    # 重置暂停/停止信号
    _stop_event.clear()
    _pause_event.set()

    # 清空上一个任务遗留的队列消息，防止积压
    drained = 0
    while not _progress_queue.empty():
        try:
            _progress_queue.get_nowait()
            drained += 1
        except queue.Empty:
            break
    if drained:
        import logging
        logging.getLogger("audio_label").info(f"Drained {drained} stale queue items from previous job")

    # ── 创建任务归档目录（按时间戳二级分组）─────────────────
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    if req.files:
        audio_root = Path(req.files[0]).parent
    else:
        audio_root = Path.home() / "Desktop"
    result_dir = audio_root / "label-result" / ts
    result_dir.mkdir(parents=True, exist_ok=True)

    # 任务日志：同时写进度队列和 task.log 文件
    _log_file = (result_dir / "task.log").open("a", encoding="utf-8", buffering=1)
    _log_start = datetime.now().isoformat(timespec="seconds")
    _log_file.write(f"[{_log_start}] 任务开始\n")

    def log(msg: str):
        _put_progress({"event": "log", "message": msg})
        _log_file.write(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}\n")

    total = len(req.files)
    _put_progress({"event": "start", "total": total})
    log(f"标注任务开始：{total} 个文件，后端 {req.backend}，模型 {req.model_size}")

    # ── 断点续传：检查 checkpoint ──────────────────────────
    checkpoint_path = audio_root / "label-result" / ".checkpoint.json"
    completed_set: set[str] = set()
    file_hash = _hash_files(req.files)

    if checkpoint_path.exists():
        try:
            ckpt = json.loads(checkpoint_path.read_text(encoding="utf-8"))
            if ckpt.get("file_hash") == file_hash:
                prev_dir = Path(ckpt["result_dir"])
                if prev_dir.exists():
                    result_dir = prev_dir
                    completed_set = set(ckpt.get("completed", []))
                    log(f"断点续传：已完成 {len(completed_set)}/{total}，从断点继续")
        except Exception:
            pass  # 损坏的 checkpoint 忽略，重新开始

    def _save_checkpoint() -> None:
        checkpoint_path.parent.mkdir(parents=True, exist_ok=True)
        checkpoint_path.write_text(json.dumps({
            "file_hash": file_hash,
            "completed": list(completed_set),
            "result_dir": str(result_dir),
        }, ensure_ascii=False), encoding="utf-8")

    _save_checkpoint()

    # 确保日志已初始化（server 直接调用时已 setup，此处幂等）
    setup_logging()
    mem_watcher = None
    try:
        mem_watcher = MemoryWatcher(interval_sec=15.0)
        mem_watcher.start()

        log_memory("任务开始", log)

        # 加载模型（优先用缓存）
        import hashlib as _hashlib
        is_ollama = req.backend.startswith("ollama:")
        # Ollama 后端缓存 key 含 prompt hash，避免换提示词后复用旧实例
        cache_key = (
            f"{req.backend}:{req.model_size}:{_hashlib.sha256((req.prompt or '').encode()).hexdigest()[:16]}"
            if is_ollama
            else f"{req.backend}:{req.model_size}"
        )
        with _transcriber_cache_lock:
            cached_transcriber = _transcriber_cache.get(cache_key)

        if cached_transcriber:
            log(f"模型 {req.backend} {req.model_size} 已在内存中（复用缓存）")
            _put_progress({"event": "loading_model", "backend": req.backend, "model_size": req.model_size, "cached": True})
            transcriber = cached_transcriber
            _put_progress({"event": "model_ready"})
        elif is_ollama:
            # Ollama 后端：模型由 Ollama 管理，无需本地缓存检查
            _put_progress({"event": "loading_model", "backend": req.backend, "model_size": req.model_size, "cached": True})
            log(f"使用 Ollama 模型 {req.backend}")
            with _transcriber_cache_lock:
                if len(_transcriber_cache) >= _MAX_CACHED_MODELS:
                    _evict_transcribers(log)
                    log_memory("驱逐旧模型后", log)
            try:
                transcriber = create_transcriber(req.backend, model_size=req.model_size, prompt=req.prompt)
                with _transcriber_cache_lock:
                    _transcriber_cache[cache_key] = transcriber
            except RuntimeError as e:
                log(f"Ollama 模型初始化失败：{e}")
                _put_progress({"event": "error", "message": str(e)})
                return
            _put_progress({"event": "model_ready"})
        else:
            cached = _is_model_cached(req.backend, req.model_size)
            _put_progress({"event": "loading_model", "backend": req.backend, "model_size": req.model_size, "cached": cached})

            with _transcriber_cache_lock:
                # 切换模型时，先驱逐缓存中的其他模型以释放内存
                if len(_transcriber_cache) >= _MAX_CACHED_MODELS and cache_key not in _transcriber_cache:
                    _evict_transcribers(log)
                    log_memory("驱逐旧模型后", log)

            if not cached:
                log(f"模型 {req.backend} {req.model_size} 未在本地缓存，开始下载…")
                _download_model_with_logs(req.backend, req.model_size, log)
            else:
                size_hint = {"0.6B": "~1.2GB", "1.7B": "~3.4GB"}.get(req.model_size, "")
                log(f"首次加载模型 {req.backend} {req.model_size} 到内存 {size_hint}（后续标注将秒启动）…")

            t0 = time.time()
            try:
                transcriber = create_transcriber(req.backend, model_size=req.model_size)
                with _transcriber_cache_lock:
                    _transcriber_cache[cache_key] = transcriber
            except RuntimeError as e:
                log(f"模型加载失败：{e}")
                _put_progress({"event": "error", "message": str(e)})
                return
            elapsed = time.time() - t0
            log_memory(f"模型 {req.backend} {req.model_size} 加载完成 ({elapsed:.1f}s)", log)
            _put_progress({"event": "model_ready"})

        # 检查并预下载 ForcedAligner（时间戳对齐需要，仅 qwen3 MLX 后端）
        if req.backend == "qwen3":
            from pathlib import Path as _P
            hf_cache = _P.home() / ".cache" / "huggingface" / "hub"
            has_aligner = hf_cache.exists() and list(hf_cache.glob("models--Qwen--Qwen3-ForcedAligner-*"))
            if not has_aligner:
                log("下载时间戳对齐模型 Qwen3-ForcedAligner-0.6B…")
                _download_model_with_logs("forced_aligner", "0.6B", log)
            else:
                log("时间戳对齐模型已就绪")

        # ── 并行调度器（Phase 1/2/3）────────────────────────────
        from audio_label.pipeline.scheduler import AnnotationScheduler, LoadMonitor, LLMConfig

        llm_config: LLMConfig | None = None
        if req.llm_model and req.prompt_content:
            llm_config = LLMConfig(
                model=req.llm_model,
                prompt_name=req.prompt_name or "",
                prompt_content=req.prompt_content,
            )
            log(f"LLM 后处理已启用：model={req.llm_model} prompt={req.prompt_name} workers={req.llm_workers}")
        else:
            log("纯 ASR 模式（未配置 LLM）")

        monitor = LoadMonitor(initial_workers=req.llm_workers)

        # 降噪预处理器（可选）
        from audio_label.pipeline.preprocessor import AudioPreprocessor
        preprocessor = AudioPreprocessor(denoise=req.denoise)
        if req.denoise:
            log("已启用 DeepFilterNet 降噪预处理")

        # 说话人分离函数（可选）
        diarize_fn = None
        if req.diarize:
            from audio_label.pipeline import diarization as _diar
            if not _diar.is_available():
                log("⚠ 说话人分离已请求但 pyannote.audio 未安装，跳过")
            else:
                num_spk = req.num_speakers
                def diarize_fn(audio_path):
                    segs = _diar.diarize(audio_path, num_speakers=num_spk)
                    return segs
                log(f"已启用说话人分离（num_speakers={req.num_speakers}）")

        scheduler = AnnotationScheduler(
            transcriber=transcriber,
            llm_config=llm_config,
            monitor=monitor,
            progress_fn=lambda ev: _put_progress(ev),
            stop_event=_stop_event,
            pause_event=_pause_event,
            preprocessor=preprocessor,
            diarize_fn=diarize_fn,
        )

        # ── 增量 JSONL + 断点 checkpoint ──────────────────────
        jsonl_path = result_dir / "records.jsonl"
        _jsonl_fh = jsonl_path.open("a", encoding="utf-8")

        def _progress_fn(ev: dict) -> None:
            _put_progress(ev)
            if ev.get("event") == "file_done":
                result = ev.get("result")
                if result:
                    _jsonl_fh.write(json.dumps(result, ensure_ascii=False) + "\n")
                    _jsonl_fh.flush()
                    completed_set.add(result.get("file", ""))
                    _save_checkpoint()

        scheduler._progress = _progress_fn  # 替换为增量写版本

        global _current_llm_workers
        with _current_llm_workers_lock:
            _current_llm_workers = req.llm_workers if llm_config else 0

        pending_files = [Path(f) for f in req.files if str(f) not in completed_set]
        if len(pending_files) < total:
            log(f"跳过 {total - len(pending_files)} 个已完成文件，继续处理剩余 {len(pending_files)} 个")

        try:
            records = scheduler.run_sync(pending_files)
        finally:
            with _current_llm_workers_lock:
                _current_llm_workers = 0
            preprocessor.cleanup()
            _jsonl_fh.close()

        # 被用户停止时跳过导出和 done 事件
        if _stop_event.is_set():
            return

        # records.jsonl 已在标注过程中逐条写入，此处只做 CSV 快照 + 合并导出
        csv_path = result_dir / "annotations.csv"

        log(f"导出结果到 {result_dir}/")
        export_csv(records, csv_path)
        from audio_label.pipeline.exporter import merge_export
        merge_export(result_dir)

        # 全部完成，清除 checkpoint
        checkpoint_path.unlink(missing_ok=True)
        log(f"完成！{len(records)}/{len(pending_files)} 条标注已写入")

        log_memory("任务完成", log)

        # done 事件：前端结果已通过 file_done 逐条推送，此处只携带统计信息
        _put_progress({
            "event": "done",
            "total_files": total,
            "success": len(records),
            "output": str(jsonl_path),
            "output_dir": str(result_dir),
        })
    finally:
        if mem_watcher is not None:
            mem_watcher.stop()
        _evict_transcribers()
        _log_file.write(f"[{datetime.now().strftime('%H:%M:%S')}] 任务结束\n")
        _log_file.close()


@app.get("/api/progress")
async def progress_stream() -> StreamingResponse:
    async def event_generator() -> AsyncGenerator[str, None]:
        while True:
            try:
                msg = _progress_queue.get_nowait()
            except queue.Empty:
                await asyncio.sleep(0.1)
                continue
            yield f"data: {json.dumps(msg, ensure_ascii=False)}\n\n"
            if msg.get("event") in ("done", "error"):
                break

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ── 启动 ─────────────────────────────────────────────

def _watch_parent(parent_pid: int) -> None:
    """父进程监控线程：若 Tauri 进程消失，Python server 自动退出。"""
    import os
    import time
    while True:
        time.sleep(3)
        try:
            os.kill(parent_pid, 0)
        except (ProcessLookupError, PermissionError):
            # 父进程已消失，清理模型内存后退出
            _evict_transcribers()
            os._exit(0)


def start_server(host: str = "127.0.0.1", port: int = 0) -> None:
    import logging
    import os
    import signal
    import socket
    import threading
    import uvicorn
    from audio_label.infra.logger import setup_logging

    # 父进程监控：Tauri 关闭后 3s 内自动退出
    parent_pid = os.getppid()
    watcher = threading.Thread(target=_watch_parent, args=(parent_pid,), daemon=True)
    watcher.start()

    # SIGTERM 处理：主动清理模型内存再退出
    def _on_sigterm(sig, frame):
        _evict_transcribers()
        os._exit(0)
    signal.signal(signal.SIGTERM, _on_sigterm)

    # 打包模式：补全 PATH + 确保 ML venv 存在
    if is_bundled():
        inject_system_path()
        try:
            ensure_ml_venv()
        except Exception:
            pass  # venv 创建失败不阻止服务启动，依赖检查会给出提示
        inject_ml_venv()

    # 统一初始化日志（app.log + memory.log 都在同一目录）
    log_dir = setup_logging()
    app_log = log_dir / "app.log"

    logging.getLogger("audio_label").info("server starting")

    if port == 0:
        with socket.socket() as s:
            s.bind(("", 0))
            port = s.getsockname()[1]

    print(f"AUDIO_LABEL_PORT={port}", flush=True)
    logging.getLogger("audio_label").info(f"listening on {host}:{port}, logs → {log_dir}")

    uvicorn.run(app, host=host, port=port, log_level="info",
                log_config={"version": 1, "disable_existing_loggers": False,
                            "handlers": {"file": {"class": "logging.FileHandler", "filename": str(app_log), "formatter": "default"}},
                            "formatters": {"default": {"fmt": "%(asctime)s %(levelname)s %(name)s: %(message)s"}},
                            "root": {"handlers": ["file"], "level": "INFO"}})
