"""音频预处理模块：DeepFilterNet 降噪。

DeepFilterNet 是 Fraunhofer 开源的高质量实时降噪库，全程本地运行。
安装：pip install deepfilternet

降噪后的文件为临时文件，与 AudioPreprocessor 生命周期绑定。
推荐通过 with 语句使用以确保临时文件被清理。
"""

from __future__ import annotations

import logging
import tempfile
from pathlib import Path

logger = logging.getLogger(__name__)


def is_available() -> bool:
    """检查 deepfilternet 是否已安装。"""
    from importlib.util import find_spec
    return find_spec("df") is not None


class AudioPreprocessor:
    """音频预处理器，可选 DeepFilterNet 降噪。

    Args:
        denoise: 是否启用降噪（默认 False，直接返回原路径）
    """

    def __init__(self, denoise: bool = False) -> None:
        self.denoise = denoise
        self._tmp_files: list[Path] = []
        self._model_cache: tuple | None = None  # (model, df_state)

    def process(self, audio_path: Path) -> Path:
        """预处理单个音频文件。

        Args:
            audio_path: 原始音频文件路径

        Returns:
            处理后的路径（降噪后的临时文件，或原始路径）
        """
        if not self.denoise:
            return audio_path
        return self._apply_deepfilter(audio_path)

    def _load_model(self):
        if self._model_cache is not None:
            return self._model_cache
        try:
            from df.enhance import init_df
        except ImportError:
            raise ImportError(
                "deepfilternet 未安装。请执行：\n"
                "  pip install deepfilternet"
            )
        logger.info("[Preprocessor] 加载 DeepFilterNet 模型…")
        model, df_state, _ = init_df()
        self._model_cache = (model, df_state)
        logger.info("[Preprocessor] 模型加载完成")
        return self._model_cache

    def _apply_deepfilter(self, audio_path: Path) -> Path:
        """DeepFilterNet 降噪，结果写入临时文件。"""
        try:
            from df.enhance import enhance, load_audio, save_audio
        except ImportError:
            logger.warning("[Preprocessor] deepfilternet 未安装，跳过降噪，使用原始音频")
            return audio_path

        model, df_state = self._load_model()

        logger.info(f"[Preprocessor] 降噪处理：{audio_path.name}")
        audio, _ = load_audio(str(audio_path), sr=df_state.sr())
        enhanced = enhance(model, df_state, audio)

        # 临时文件与原文件同后缀（保持格式兼容性）
        suffix = audio_path.suffix or ".wav"
        fd, tmp_str = tempfile.mkstemp(suffix=f"_denoised{suffix}")
        import os
        os.close(fd)
        tmp = Path(tmp_str)

        save_audio(str(tmp), enhanced, df_state.sr())
        self._tmp_files.append(tmp)
        logger.info(f"[Preprocessor] 降噪完成 → {tmp.name}")
        return tmp

    def cleanup(self) -> None:
        """清理所有临时文件，释放模型内存。"""
        for f in self._tmp_files:
            try:
                f.unlink(missing_ok=True)
            except Exception:
                pass
        self._tmp_files.clear()
        self._model_cache = None

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.cleanup()
