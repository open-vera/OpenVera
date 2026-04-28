from __future__ import annotations

import signal
import threading
from enum import Enum
from pathlib import Path

import typer
from rich.console import Console
from rich.progress import Progress, SpinnerColumn, TextColumn, BarColumn, TaskProgressColumn
from rich.table import Table

from audio_label import __version__
from audio_label.config import DEFAULT_BACKEND, DEFAULT_MODEL_SIZE
from audio_label.infra.preflight import run_preflight
from audio_label.transcribers import BACKENDS

app = typer.Typer(
    name="veralabel",
    help="本地音频批量标注工具（启动前会检查 Ollama / MLX / 模型）。",
    no_args_is_help=True,
)
console = Console()


class OutputFormat(str, Enum):
    csv = "csv"
    jsonl = "jsonl"


@app.command()
def version() -> None:
    """显示版本号。"""
    console.print(__version__)


@app.command()
def doctor(
    strict: bool = typer.Option(
        True,
        "--strict/--no-strict",
        help="严格模式：不满足 Ollama 或 MLX 任一路径则返回非 0。",
    ),
) -> None:
    """检查 Ollama、MLX 与已拉取的模型，并给出安装指引。"""
    raise typer.Exit(run_preflight(strict=strict))


@app.command()
def prompts(
    prompts_dir: str = typer.Option(
        None,
        "--dir", "-d",
        help="提示词目录（默认：<工作目录>/prompts）。",
    ),
) -> None:
    """列出可用的提示词。"""
    p_dir = Path(prompts_dir) if prompts_dir else Path.cwd() / "prompts"
    if not p_dir.exists():
        console.print(f"[yellow]提示词目录不存在：{p_dir}[/yellow]")
        return
    md_files = sorted(p_dir.glob("*.md"))
    if not md_files:
        console.print("[yellow]未找到任何提示词文件（*.md）。[/yellow]")
        return
    table = Table("名称", "预览", show_header=True)
    for f in md_files:
        content = f.read_text(encoding="utf-8").strip()
        preview = content[:80].replace("\n", " ")
        if len(content) > 80:
            preview += "…"
        table.add_row(f.stem, preview)
    console.print(table)


@app.command()
def annotate(
    paths: list[str] = typer.Argument(..., help="音频文件或目录"),
    backend: str = typer.Option(
        DEFAULT_BACKEND,
        "--backend", "-b",
        help=f"ASR 后端：{', '.join(BACKENDS)} 或 ollama:<模型名>。",
    ),
    model: str = typer.Option(
        DEFAULT_MODEL_SIZE,
        "--model", "-m",
        help="ASR 模型大小/ID（Qwen3: 0.6B/1.7B，ollama 可传模型名）。",
    ),
    asr_prompt: str = typer.Option(
        None,
        "--asr-prompt",
        help="注入给 Ollama ASR 的提示词名称（来自提示词目录）或直接传入提示词内容。",
    ),
    llm_model: str = typer.Option(
        None,
        "--llm-model",
        help="LLM 标注模型（Ollama 模型名，如 qwen3.5:9b）。不传则跳过 LLM 标注。",
    ),
    llm_prompt: str = typer.Option(
        None,
        "--llm-prompt",
        help="LLM 标注使用的提示词名称（来自提示词目录）。",
    ),
    output: str = typer.Option(
        None,
        "--output", "-o",
        help="输出文件路径（默认 annotations.json/csv/jsonl）。",
    ),
    fmt: OutputFormat = typer.Option(
        OutputFormat.jsonl,
        "--format", "-f",
        help="输出格式：jsonl / csv。",
    ),
    prompts_dir: str = typer.Option(
        None,
        "--prompts-dir",
        help="提示词目录（默认：<工作目录>/prompts）。",
    ),
    llm_workers: int = typer.Option(
        2,
        "--llm-workers",
        help="LLM 并发 worker 数（默认 2）。",
    ),
    skip_check: bool = typer.Option(
        False,
        "--skip-check",
        help="跳过环境预检（不推荐）。",
    ),
) -> None:
    """批量标注音频文件：ASR 转写 + 可选 LLM 标注 → 导出结果。

    示例：

      # 仅 ASR
      veralabel annotate ./audio/

      # ASR + LLM 标注
      veralabel annotate ./audio/ --llm-model qwen3.5:9b --llm-prompt 纠错

      # Ollama ASR + 自定义提示词
      veralabel annotate ./audio/ -b ollama:qwen3-vl:8b --asr-prompt asr-correction
    """
    p_dir = Path(prompts_dir) if prompts_dir else Path.cwd() / "prompts"

    # ── 解析 ASR 提示词 ────────────────────────────────────
    asr_prompt_content: str | None = None
    if asr_prompt:
        prompt_file = p_dir / f"{asr_prompt}.md"
        if prompt_file.exists():
            asr_prompt_content = prompt_file.read_text(encoding="utf-8").strip()
        else:
            # 当作直接内容传入
            asr_prompt_content = asr_prompt

    # ── 解析 LLM 提示词 ────────────────────────────────────
    llm_config = None
    if llm_model:
        if not llm_prompt:
            console.print("[red]使用 --llm-model 时必须指定 --llm-prompt。[/red]")
            raise typer.Exit(1)
        prompt_file = p_dir / f"{llm_prompt}.md"
        if not prompt_file.exists():
            console.print(f"[red]提示词文件不存在：{prompt_file}[/red]")
            console.print(f"  提示：运行 [cyan]veralabel prompts[/cyan] 查看可用提示词")
            raise typer.Exit(1)
        llm_prompt_content = prompt_file.read_text(encoding="utf-8").strip()
        from audio_label.pipeline.scheduler import LLMConfig
        llm_config = LLMConfig(
            model=llm_model,
            prompt_name=llm_prompt,
            prompt_content=llm_prompt_content,
        )

    # ── 校验后端 ───────────────────────────────────────────
    is_ollama = backend.startswith("ollama:")
    if not is_ollama and backend not in BACKENDS:
        console.print(f"[red]未知后端 '{backend}'，可选：{', '.join(BACKENDS)} 或 ollama:<模型名>[/red]")
        raise typer.Exit(1)

    # ── 预检 ───────────────────────────────────────────────
    if not skip_check:
        code = run_preflight(strict=True)
        if code != 0:
            raise typer.Exit(code)

    # ── 扫描音频 ───────────────────────────────────────────
    from audio_label.pipeline.scanner import scan_audio_files

    audio_files = scan_audio_files(paths)
    if not audio_files:
        console.print("[yellow]未找到任何音频文件。[/yellow]")
        raise typer.Exit(0)

    console.print(f"\n找到 [bold]{len(audio_files)}[/bold] 个音频文件")
    console.print(f"ASR 后端：[cyan]{backend}[/cyan]  模型：[cyan]{model}[/cyan]")
    if llm_config:
        console.print(f"LLM 标注：[cyan]{llm_config.model}[/cyan]  提示词：[cyan]{llm_config.prompt_name}[/cyan]")
    console.print()

    # ── 初始化转写器 ───────────────────────────────────────
    from audio_label.transcribers import create_transcriber

    try:
        kw = {"model_size": model}
        if is_ollama:
            kw["model"] = backend.split(":", 1)[1]
            if asr_prompt_content:
                kw["prompt"] = asr_prompt_content
            transcriber = create_transcriber("ollama", **kw)
        else:
            transcriber = create_transcriber(backend, **kw)
    except RuntimeError as e:
        console.print(f"[red]{e}[/red]")
        raise typer.Exit(1)

    # ── 停止事件（Ctrl+C 优雅退出）────────────────────────
    stop_event = threading.Event()

    original_sigint = signal.getsignal(signal.SIGINT)

    def _handle_sigint(sig, frame):
        if stop_event.is_set():
            # 第二次 Ctrl+C：强制退出
            console.print("\n[red]强制退出。[/red]")
            raise KeyboardInterrupt
        console.print("\n[yellow]收到中断信号，等待当前文件完成后停止…[/yellow]")
        stop_event.set()

    signal.signal(signal.SIGINT, _handle_sigint)

    # ── 进度显示 ───────────────────────────────────────────
    from audio_label.pipeline.scheduler import AnnotationScheduler, LoadMonitor

    file_paths = [af.path for af in audio_files]
    records = []

    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TaskProgressColumn(),
        console=console,
    ) as progress:
        asr_task = progress.add_task("ASR 转写", total=len(file_paths))
        llm_task = progress.add_task(
            "LLM 标注" if llm_config else "（无 LLM）",
            total=len(file_paths) if llm_config else 1,
            visible=llm_config is not None,
        )
        asr_done = 0
        llm_done = 0

        def on_progress(ev: dict) -> None:
            nonlocal asr_done, llm_done
            event = ev.get("event", "")
            if event == "asr_start":
                progress.update(asr_task, description=f"ASR  {ev.get('file', '')}")
            elif event == "asr_done":
                asr_done += 1
                progress.update(asr_task, completed=asr_done,
                                description=f"ASR  {ev.get('file', '')}")
            elif event == "llm_start":
                progress.update(llm_task, description=f"LLM  {ev.get('file', '')}")
            elif event == "llm_done":
                llm_done += 1
                progress.update(llm_task, completed=llm_done,
                                description=f"LLM  {ev.get('file', '')}")
            elif event == "file_error":
                console.print(f"  [red]✗[/red] {ev.get('file', '')}：{ev.get('error', '')}")
            elif event == "llm_error":
                console.print(f"  [yellow]⚠ LLM[/yellow] {ev.get('file', '')}：{ev.get('error', '')}")
            elif event == "stopped":
                progress.update(asr_task, description="[yellow]已停止[/yellow]")
            elif event == "paused":
                progress.update(asr_task, description="[yellow]已暂停[/yellow]")
            elif event == "load_adjust":
                pass  # CLI 不显示负载调整详情

        scheduler = AnnotationScheduler(
            transcriber=transcriber,
            llm_config=llm_config,
            monitor=LoadMonitor(initial_workers=llm_workers),
            progress_fn=on_progress,
            stop_event=stop_event,
        )
        records = scheduler.run_sync(file_paths)

    # 恢复默认 SIGINT
    signal.signal(signal.SIGINT, original_sigint)

    if not records:
        console.print("[yellow]无结果输出。[/yellow]")
        raise typer.Exit(0)

    # ── 导出 ───────────────────────────────────────────────
    from audio_label.pipeline.exporter import export_csv, export_jsonl

    out_path = Path(output) if output else Path(f"annotations.{fmt.value}")

    if fmt == OutputFormat.csv:
        export_csv(records, out_path)
    else:
        export_jsonl(records, out_path)

    label_count = sum(1 for r in records if r.label is not None)
    console.print(
        f"\n[green]完成！[/green] 共 {len(records)}/{len(audio_files)} 条标注已写入 {out_path}"
    )
    if llm_config:
        console.print(f"  其中 LLM 标注成功：{label_count}/{len(records)}")


def main() -> None:
    app()


@app.command(hidden=True)
def serve(
    host: str = typer.Option("127.0.0.1", help="监听地址。"),
    port: int = typer.Option(0, help="监听端口（0 = 自动分配）。"),
) -> None:
    """启动 HTTP API 服务（供 GUI 调用）。"""
    try:
        from audio_label.server import start_server
    except ImportError:
        console.print("[red]server 依赖未安装，请执行：pip install 'veralabel[server]'[/red]")
        raise typer.Exit(1)
    start_server(host=host, port=port)


if __name__ == "__main__":
    main()
