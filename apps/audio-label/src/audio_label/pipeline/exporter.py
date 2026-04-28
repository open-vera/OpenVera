"""导出标注结果为 CSV 或 JSONL。"""

from __future__ import annotations

import csv
import json
import logging
from dataclasses import asdict
from pathlib import Path

from audio_label.pipeline.annotator import AnnotationRecord

logger = logging.getLogger(__name__)


def export_jsonl(records: list[AnnotationRecord], output: Path) -> None:
    """写出 JSONL 文件，每行一条记录（追加模式，支持增量写入）。"""
    with output.open("a", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(asdict(r), ensure_ascii=False) + "\n")


def export_csv(records: list[AnnotationRecord], output: Path) -> None:
    """写出 CSV 文件，segments/words/chunks 以 JSON 字符串列保存。"""
    fieldnames = ["file", "text", "language", "duration_sec", "sample_rate",
                  "segments", "words", "chunks", "label"]
    with output.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for r in records:
            writer.writerow(
                {
                    "file": r.file,
                    "text": r.text,
                    "language": r.language or "",
                    "duration_sec": r.duration_sec if r.duration_sec is not None else "",
                    "sample_rate": r.sample_rate if r.sample_rate is not None else "",
                    "segments": json.dumps(
                        [asdict(s) for s in r.segments], ensure_ascii=False
                    ) if r.segments else "",
                    "words": json.dumps(
                        [asdict(s) for s in r.words], ensure_ascii=False
                    ) if r.words else "",
                    "chunks": json.dumps(
                        [asdict(s) for s in r.chunks], ensure_ascii=False
                    ) if r.chunks else "",
                    "label": json.dumps(
                        asdict(r.label), ensure_ascii=False
                    ) if r.label else "",
                }
            )


def merge_export(result_dir: Path) -> Path:
    """将 result_dir 下的所有数据合并为单份 final.jsonl，并同步更新 annotations.json。

    数据来源（按优先级合并）：
    - records.jsonl          — ASR + LLM 转写/标注结果（含 label_confidence）
    - manual_annotations.json — 手动时间区段标注
    - corrections.jsonl      — 转写纠错记录（含 CER）
    - label_corrections.jsonl — AI 标签人工确认/纠错记录

    输出：
    - result_dir/final.jsonl     每行一条完整记录
    - result_dir/annotations.json 同内容的 JSON 数组（始终保持最新）

    Returns:
        final.jsonl 的绝对路径
    """
    records_file = result_dir / "records.jsonl"
    ann_file = result_dir / "manual_annotations.json"
    corr_file = result_dir / "corrections.jsonl"
    label_corr_file = result_dir / "label_corrections.jsonl"

    # ── 读取 ASR + LLM 记录 ──────────────────────────────
    records: dict[str, dict] = {}  # file -> record dict
    if records_file.exists():
        for line in records_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
                file_key = rec.get("file", "")
                if file_key:
                    records[file_key] = rec
            except json.JSONDecodeError as e:
                logger.warning(f"records.jsonl 行解析失败，跳过: {e}")

    # ── 读取手动区间标注 ──────────────────────────────────
    manual: dict[str, list] = {}
    if ann_file.exists():
        try:
            manual = json.loads(ann_file.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            pass

    # ── 读取转写纠错记录（按文件分组） ──────────────────────
    corrections: dict[str, list] = {}
    if corr_file.exists():
        for line in corr_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                corr = json.loads(line)
                fk = corr.get("file", "")
                if fk:
                    corrections.setdefault(fk, []).append({
                        "seg_start": corr.get("seg_start"),
                        "seg_end": corr.get("seg_end"),
                        "original": corr.get("original", ""),
                        "corrected": corr.get("corrected", ""),
                        "cer": corr.get("cer"),
                    })
            except json.JSONDecodeError as e:
                logger.warning(f"corrections.jsonl 行解析失败，跳过: {e}")

    # ── 读取 AI 标签人工确认/纠错记录 ────────────────────────
    label_corrections: dict[str, list] = {}
    if label_corr_file.exists():
        for line in label_corr_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                lc = json.loads(line)
                fk = lc.get("file", "")
                if fk:
                    label_corrections.setdefault(fk, []).append({
                        "prompt_name": lc.get("prompt_name", ""),
                        "model": lc.get("model", ""),
                        "status": lc.get("status", ""),
                        "ai_result": lc.get("ai_result", ""),
                        "human_result": lc.get("human_result", ""),
                        "ts": lc.get("ts", ""),
                    })
            except json.JSONDecodeError as e:
                logger.warning(f"label_corrections.jsonl 行解析失败，跳过: {e}")

    # ── 合并 ──────────────────────────────────────────────
    merged_list: list[dict] = []
    for file_key, rec in records.items():
        rec_corrs = corrections.get(file_key, [])
        cer_values = [c["cer"] for c in rec_corrs if c["cer"] is not None]
        cer_avg = round(sum(cer_values) / len(cer_values), 4) if cer_values else None

        merged = {
            **rec,
            "manual_annotations": manual.get(file_key, []),
            "corrections": rec_corrs,
            "cer_avg": cer_avg,
            "label_corrections": label_corrections.get(file_key, []),
        }
        merged_list.append(merged)

    # ── 写出 final.jsonl ──────────────────────────────────
    output = result_dir / "final.jsonl"
    with output.open("w", encoding="utf-8") as f:
        for merged in merged_list:
            f.write(json.dumps(merged, ensure_ascii=False) + "\n")

    # ── 同步写出 annotations.json（始终最新）────────────────
    ann_json = result_dir / "annotations.json"
    ann_json.write_text(
        json.dumps(merged_list, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    return output
