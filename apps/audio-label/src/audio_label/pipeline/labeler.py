"""LLM 标注服务：将 ASR 转写结果送 Ollama LLM 做二次标注。"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass

from audio_label.infra.ollama import ollama_chat


@dataclass
class LabelResult:
    """单次 LLM 标注的结果。"""
    prompt_name: str
    model: str
    result: str
    segment_labels: list[dict] | None = None
    label_confidence: dict | None = None
    sections: dict[str, str] | None = None  # 按 ## 标题拆分的各 section
    chunked: bool = False                   # 是否经过分块处理


# 单块最大字符数（~3000 tokens，安全适配 8K 模型）
_CHUNK_CHAR_LIMIT = 2000


def _format_segments(segments: list[dict]) -> str:
    """将 segments 格式化为带时间戳的文本，供 LLM 处理。

    格式：[M:SS - M:SS] 文本内容
    """
    lines = []
    for seg in segments:
        start = seg.get("start", 0.0)
        end = seg.get("end", 0.0)
        text = seg.get("text", "")
        s_min, s_sec = divmod(start, 60)
        e_min, e_sec = divmod(end, 60)
        lines.append(f"[{int(s_min)}:{s_sec:04.1f} - {int(e_min)}:{e_sec:04.1f}] {text}")
    return "\n".join(lines)


def _chunk_segments(segments: list[dict], limit: int = _CHUNK_CHAR_LIMIT) -> list[list[dict]]:
    """按字符数将 segments 分组为 chunks，在 segment 边界切分。

    相邻 chunk 保留最后一个 segment 作为上下文衔接，避免说话人/语义断裂。
    """
    if not segments:
        return [segments]

    chunks: list[list[dict]] = []
    current: list[dict] = []
    current_len = 0

    for seg in segments:
        seg_len = len(seg.get("text", ""))
        if current and current_len + seg_len > limit:
            chunks.append(current)
            current = [current[-1]]
            current_len = len(current[0].get("text", ""))
        current.append(seg)
        current_len += seg_len

    if current:
        chunks.append(current)

    return chunks


_SYSTEM_PROMPT = (
    "你是一个专业的音频标注助手。用户会提供一段语音转写文本，"
    "并要求你完成一项或多项标注任务。\n\n"
    "重要规则：\n"
    "1. 仔细阅读所有任务要求，确保每一项都完成\n"
    "2. 对每项任务的输出用明确的标题分隔（如 ## 纠错、## 说话人分离）\n"
    "3. 完成所有任务后，在末尾用「---」分隔，附上自查清单，"
    "逐项确认是否已完成，格式：[x] 任务名 或 [ ] 任务名（未完成则说明原因）\n"
    "4. 在自查清单之后，另起一行输出置信度 JSON 块（格式严格如下，不要省略）：\n"
    "<CONFIDENCE>\n"
    "{\"overall\": 0.85, \"labels\": {\"标注维度名\": 0.9}}\n"
    "</CONFIDENCE>\n"
    "   - overall: 对本次整体标注结果的综合置信度 (0.0-1.0)\n"
    "   - labels: 各判断维度的置信度，key 为维度名称（如 intent/emotion/scene 等），"
    "只列出实际做了判断的维度"
)

_CONFIDENCE_RE = re.compile(r"<CONFIDENCE>\s*(\{.*?\})\s*</CONFIDENCE>", re.DOTALL)
_SECTION_RE = re.compile(r"^##\s+(.+)$", re.MULTILINE)


def _parse_sections(text: str) -> dict[str, str]:
    """按 ## 标题将 LLM 输出拆分为各 section 字典。"""
    parts = _SECTION_RE.split(text)
    sections: dict[str, str] = {}
    it = iter(parts[1:])
    for title, content in zip(it, it):
        sections[title.strip()] = content.strip()
    return sections


def _extract_confidence(text: str) -> tuple[str, dict | None]:
    """从 LLM 输出中提取并移除 <CONFIDENCE>...</CONFIDENCE> 块。

    Returns:
        (cleaned_text, confidence_dict) — 若未找到则 confidence_dict 为 None
    """
    m = _CONFIDENCE_RE.search(text)
    if not m:
        return text, None
    try:
        conf = json.loads(m.group(1))
    except json.JSONDecodeError:
        return text, None
    cleaned = text[: m.start()].rstrip() + text[m.end():]
    return cleaned.rstrip(), conf


def _call_llm(formatted: str, prompt_content: str, model: str, prompt_name: str) -> LabelResult:
    """单次 LLM 调用的核心逻辑（不含分块）。"""
    if "{asr_text}" in prompt_content:
        # 占位符类 prompt（纠错/质检）直接用纯文本，避免时间戳格式干扰
        user_content = prompt_content.replace("{asr_text}", formatted)
    else:
        user_content = prompt_content + "\n\n转写文本：\n" + formatted

    messages = [
        {"role": "system", "content": _SYSTEM_PROMPT},
        {"role": "user", "content": user_content},
    ]

    result_text = ollama_chat(model, messages)
    cleaned_text, label_confidence = _extract_confidence(result_text.strip())
    sections = _parse_sections(cleaned_text) or None

    return LabelResult(
        prompt_name=prompt_name,
        model=model,
        result=cleaned_text,
        label_confidence=label_confidence,
        sections=sections,
    )


def label_transcript(
    text: str,
    segments: list[dict],
    prompt_content: str,
    model: str,
    prompt_name: str = "",
) -> LabelResult:
    """对转写结果进行 LLM 标注。

    含 {asr_text} 占位符的 prompt（纠错/质检）使用纯文本，不带时间戳；
    不含占位符的 prompt（标签/分析）使用带时间戳的分段格式。
    短文本（≤ 2000 字）直接单次调用；长文本自动分块后合并。
    """
    use_plain = "{asr_text}" in prompt_content
    formatted = text if use_plain else (_format_segments(segments) if segments else text)

    if len(formatted) <= _CHUNK_CHAR_LIMIT:
        return _call_llm(formatted, prompt_content, model, prompt_name)

    # ── 分块处理 ──────────────────────────────────────────
    if use_plain:
        # 纯文本按字符切块
        chunks_plain: list[str] = []
        for i in range(0, len(text), _CHUNK_CHAR_LIMIT - 200):  # 200 字重叠保上下文
            chunks_plain.append(text[i: i + _CHUNK_CHAR_LIMIT])
        n = len(chunks_plain)
        results: list[LabelResult] = []
        for i, chunk_text in enumerate(chunks_plain):
            tag = f"{prompt_name} [片段{i + 1}/{n}]"
            results.append(_call_llm(chunk_text, prompt_content, model, tag))
    else:
        chunks = _chunk_segments(segments) if segments else [{"text": formatted}]
        n = len(chunks)
        results: list[LabelResult] = []

        for i, chunk_segs in enumerate(chunks):
            chunk_fmt = _format_segments(chunk_segs) if isinstance(chunk_segs[0], dict) else chunk_segs[0]
            tag = f"{prompt_name} [片段{i + 1}/{n}]"
            results.append(_call_llm(chunk_fmt, prompt_content, model, tag))

    # 合并：各片段结果顺序拼接
    merged_result = "\n\n".join(
        f"<!-- 片段 {i + 1}/{n} -->\n{r.result}"
        for i, r in enumerate(results)
    )

    # 合并 sections：同名 section 内容按片段顺序拼接
    merged_sections: dict[str, str] = {}
    for r in results:
        if r.sections:
            for key, val in r.sections.items():
                if key in merged_sections:
                    merged_sections[key] += "\n" + val
                else:
                    merged_sections[key] = val

    return LabelResult(
        prompt_name=prompt_name,
        model=model,
        result=merged_result,
        label_confidence=results[-1].label_confidence,
        sections=merged_sections or None,
        chunked=True,
    )
