#!/usr/bin/env python3
"""
性能基准测试：全流程 ASR + LLM（含提示词、中文分词等完整逻辑）。

用法：
  python bench/run_bench.py                         # 默认配置
  python bench/run_bench.py --asr-model qwen3-vl:8b --llm-model qwen3.5:9b
  python bench/run_bench.py --asr-model qwen3-vl:8b --no-llm
  python bench/run_bench.py --audio-dir /path/to/wav --limit 5

产物写入 bench/reports/<timestamp>/
  results.jsonl     — 完整标注结果（与主流程相同格式）
  bench.json        — 机器可读的计时汇总
  bench.md          — 人类可读的报告
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from dataclasses import asdict
from datetime import datetime
from pathlib import Path

# 把 src 加到路径，使脚本可在项目根目录直接运行
_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(_ROOT / "src"))

from audio_label.pipeline.scanner import scan_audio_files
from audio_label.pipeline.scheduler import AnnotationScheduler, LLMConfig, LoadMonitor
from audio_label.transcribers import create_transcriber

# ── 默认值 ────────────────────────────────────────────────
DEFAULT_ASR_MODEL = "qwen3-vl:8b"
DEFAULT_LLM_MODEL = "qwen3.5:9b"
DEFAULT_AUDIO_DIR = Path(__file__).parent / "audio"
PROMPTS_DIR = _ROOT / "prompts"


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="audio-label 全流程性能基准测试")
    p.add_argument("--audio-dir", default=str(DEFAULT_AUDIO_DIR),
                   help=f"音频目录（默认 {DEFAULT_AUDIO_DIR}）")
    p.add_argument("--limit", type=int, default=0,
                   help="最多处理 N 个文件（0 = 全部）")
    p.add_argument("--asr-model", default=DEFAULT_ASR_MODEL,
                   help=f"Ollama ASR 模型（默认 {DEFAULT_ASR_MODEL}）")
    p.add_argument("--asr-prompt", default="default",
                   help="ASR 提示词文件名（prompts/ 下的 .md，默认 default）")
    p.add_argument("--llm-model", default=DEFAULT_LLM_MODEL,
                   help=f"LLM 标注模型（默认 {DEFAULT_LLM_MODEL}）")
    p.add_argument("--llm-prompt", default="asr-correction",
                   help="LLM 标注提示词文件名（默认 asr-correction）")
    p.add_argument("--no-llm", action="store_true",
                   help="跳过 LLM 阶段，仅测试 ASR")
    p.add_argument("--llm-workers", type=int, default=2,
                   help="LLM 并发 worker 数（默认 2）")
    p.add_argument("--output-dir", default=str(Path(__file__).parent / "reports"),
                   help="报告根目录（默认 bench/reports）")
    return p.parse_args()


def load_prompt(name: str) -> str:
    f = PROMPTS_DIR / f"{name}.md"
    if not f.exists():
        print(f"[WARN] 提示词文件不存在：{f}，使用空提示词")
        return ""
    return f.read_text(encoding="utf-8").strip()


def hr(seconds: float) -> str:
    """秒 → 人类可读字符串"""
    if seconds < 60:
        return f"{seconds:.1f}s"
    m, s = divmod(seconds, 60)
    return f"{int(m)}m{s:.0f}s"


def rtf(proc_sec: float, audio_sec: float) -> str:
    """实时率：处理时间 / 音频时长，越小越快"""
    if audio_sec <= 0:
        return "N/A"
    return f"{proc_sec / audio_sec:.3f}x"


def main() -> None:
    args = parse_args()

    # ── 扫描音频 ────────────────────────────────────────────
    audio_files = scan_audio_files([args.audio_dir])
    if not audio_files:
        print(f"[ERROR] 未找到音频文件：{args.audio_dir}")
        sys.exit(1)
    if args.limit > 0:
        audio_files = audio_files[: args.limit]

    total_audio_sec = sum(
        af.duration_sec for af in audio_files if af.duration_sec
    )
    print(f"\n{'='*60}")
    print(f"  audio-label 性能基准测试")
    print(f"{'='*60}")
    print(f"  文件数：{len(audio_files)}")
    print(f"  总音频时长：{hr(total_audio_sec)}")
    print(f"  ASR 模型：ollama:{args.asr_model}")
    if not args.no_llm:
        print(f"  LLM 模型：{args.llm_model}  提示词：{args.llm_prompt}")
    print(f"{'='*60}\n")

    # ── 初始化输出目录 ──────────────────────────────────────
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    report_dir = Path(args.output_dir) / ts
    report_dir.mkdir(parents=True, exist_ok=True)
    results_file = report_dir / "results.jsonl"

    # ── 加载提示词 ──────────────────────────────────────────
    asr_prompt_content = load_prompt(args.asr_prompt)
    llm_config: LLMConfig | None = None
    if not args.no_llm:
        llm_prompt_content = load_prompt(args.llm_prompt)
        llm_config = LLMConfig(
            model=args.llm_model,
            prompt_name=args.llm_prompt,
            prompt_content=llm_prompt_content,
        )

    # ── 初始化转写器 ────────────────────────────────────────
    print("初始化 ASR 转写器…")
    transcriber = create_transcriber(
        "ollama",
        model=args.asr_model,
        prompt=asr_prompt_content or None,
    )

    # ── 收集每文件计时 ──────────────────────────────────────
    file_timings: list[dict] = []   # {file, audio_sec, asr_sec, llm_sec, total_sec}
    current: dict = {}

    def on_progress(ev: dict) -> None:
        event = ev.get("event", "")
        fname = ev.get("file", "")

        if event == "asr_start":
            current[fname] = {"asr_start": time.time()}
            print(f"  [ASR] {fname}")

        elif event == "asr_done":
            if fname in current:
                current[fname]["asr_elapsed"] = ev.get("elapsed", 0.0)

        elif event == "llm_start":
            if fname in current:
                current[fname]["llm_start"] = time.time()
            print(f"  [LLM] {fname}  prompt={ev.get('step','')}")

        elif event == "llm_done":
            if fname in current:
                current[fname]["llm_elapsed"] = ev.get("elapsed", 0.0)

        elif event == "file_done":
            result = ev.get("result", {})
            audio_dur = result.get("duration_sec") or 0.0
            asr_s = current.get(fname, {}).get("asr_elapsed", 0.0)
            llm_s = current.get(fname, {}).get("llm_elapsed", 0.0)
            total_s = asr_s + llm_s
            file_timings.append({
                "file": fname,
                "audio_sec": round(audio_dur, 2),
                "asr_sec": round(asr_s, 2),
                "llm_sec": round(llm_s, 2),
                "total_sec": round(total_s, 2),
                "rtf_asr": round(asr_s / audio_dur, 3) if audio_dur > 0 else None,
                "rtf_total": round(total_s / audio_dur, 3) if audio_dur > 0 else None,
            })
            # 逐条写结果
            with results_file.open("a", encoding="utf-8") as f:
                f.write(json.dumps(result, ensure_ascii=False) + "\n")
            print(
                f"  [DONE] {fname:40s}  "
                f"音频={hr(audio_dur)}  ASR={hr(asr_s)}  "
                + (f"LLM={hr(llm_s)}  " if llm_config else "")
                + f"RTF={rtf(total_s, audio_dur)}"
            )

        elif event == "file_error":
            print(f"  [ERR]  {fname}: {ev.get('error','')}")

        elif event == "load_adjust":
            print(f"  [LOAD] llm_workers→{ev.get('llm_workers')}  "
                  f"cpu={ev.get('cpu_percent')}%  mem={ev.get('memory_percent')}%  "
                  f"reason={ev.get('reason')}")

    # ── 运行调度器 ──────────────────────────────────────────
    scheduler = AnnotationScheduler(
        transcriber=transcriber,
        llm_config=llm_config,
        monitor=LoadMonitor(initial_workers=args.llm_workers),
        progress_fn=on_progress,
    )

    wall_start = time.time()
    records = scheduler.run_sync([af.path for af in audio_files])
    wall_elapsed = time.time() - wall_start

    # ── 汇总统计 ────────────────────────────────────────────
    processed = len(file_timings)
    actual_audio_sec = sum(t["audio_sec"] for t in file_timings)
    total_asr_sec = sum(t["asr_sec"] for t in file_timings)
    total_llm_sec = sum(t["llm_sec"] for t in file_timings)
    rtf_values = [t["rtf_total"] for t in file_timings if t["rtf_total"] is not None]
    avg_rtf = sum(rtf_values) / len(rtf_values) if rtf_values else None
    throughput = actual_audio_sec / wall_elapsed if wall_elapsed > 0 else 0

    summary = {
        "timestamp": ts,
        "config": {
            "asr_model": f"ollama:{args.asr_model}",
            "asr_prompt": args.asr_prompt,
            "llm_model": args.llm_model if not args.no_llm else None,
            "llm_prompt": args.llm_prompt if not args.no_llm else None,
            "llm_workers": args.llm_workers,
        },
        "totals": {
            "files": processed,
            "audio_sec": round(actual_audio_sec, 2),
            "wall_sec": round(wall_elapsed, 2),
            "asr_sec_sum": round(total_asr_sec, 2),
            "llm_sec_sum": round(total_llm_sec, 2),
            "avg_rtf": round(avg_rtf, 3) if avg_rtf else None,
            "throughput_x": round(throughput, 2),
        },
        "per_file": file_timings,
    }

    # ── 写 bench.json ───────────────────────────────────────
    bench_json = report_dir / "bench.json"
    bench_json.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")

    # ── 写 bench.md ────────────────────────────────────────
    md_lines = [
        f"# audio-label 性能基准报告",
        f"",
        f"**测试时间**：{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        f"",
        f"## 配置",
        f"",
        f"| 项目 | 值 |",
        f"|------|-----|",
        f"| ASR 模型 | `ollama:{args.asr_model}` |",
        f"| ASR 提示词 | `{args.asr_prompt}` |",
    ]
    if not args.no_llm:
        md_lines += [
            f"| LLM 模型 | `{args.llm_model}` |",
            f"| LLM 提示词 | `{args.llm_prompt}` |",
            f"| LLM workers | `{args.llm_workers}` |",
        ]
    md_lines += [
        f"",
        f"## 汇总",
        f"",
        f"| 指标 | 值 |",
        f"|------|-----|",
        f"| 处理文件数 | {processed} |",
        f"| 总音频时长 | {hr(actual_audio_sec)} |",
        f"| 墙钟时间 | {hr(wall_elapsed)} |",
        f"| ASR 累计 | {hr(total_asr_sec)} |",
    ]
    if not args.no_llm:
        md_lines.append(f"| LLM 累计 | {hr(total_llm_sec)} |")
    md_lines += [
        f"| 平均 RTF | {f'{avg_rtf:.3f}x' if avg_rtf else 'N/A'} |",
        f"| 吞吐率 | {throughput:.2f}x 实时（每秒处理 {throughput:.2f}s 音频）|",
        f"",
        f"## 逐文件明细",
        f"",
        f"| 文件 | 音频时长 | ASR | LLM | 合计 | RTF |",
        f"|------|---------|-----|-----|------|-----|",
    ]
    for t in sorted(file_timings, key=lambda x: x["total_sec"], reverse=True):
        rtf_str = f"{t['rtf_total']:.3f}x" if t['rtf_total'] else 'N/A'
        md_lines.append(
            f"| `{t['file']}` "
            f"| {hr(t['audio_sec'])} "
            f"| {hr(t['asr_sec'])} "
            f"| {hr(t['llm_sec'])} "
            f"| {hr(t['total_sec'])} "
            f"| {rtf_str} |"
        )

    bench_md = report_dir / "bench.md"
    bench_md.write_text("\n".join(md_lines), encoding="utf-8")

    # ── 打印摘要 ────────────────────────────────────────────
    print(f"\n{'='*60}")
    print(f"  基准测试完成")
    print(f"{'='*60}")
    print(f"  文件数：{processed}  音频总时长：{hr(actual_audio_sec)}")
    print(f"  墙钟时间：{hr(wall_elapsed)}")
    print(f"  ASR 累计：{hr(total_asr_sec)}")
    if not args.no_llm:
        print(f"  LLM 累计：{hr(total_llm_sec)}")
    print(f"  平均 RTF：{f'{avg_rtf:.3f}x' if avg_rtf else 'N/A'}")
    print(f"  吞吐率：{throughput:.2f}x 实时")
    print(f"\n  报告目录：{report_dir}")
    print(f"    results.jsonl  — 完整标注产物")
    print(f"    bench.json     — 机器可读汇总")
    print(f"    bench.md       — 人类可读报告")
    print(f"{'='*60}\n")


if __name__ == "__main__":
    main()
