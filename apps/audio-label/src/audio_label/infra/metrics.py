"""质量评估指标：CER (字错误率) 和 Cohen's Kappa 系数。"""

from __future__ import annotations


def calculate_cer(hypothesis: str, reference: str) -> float:
    """计算字错误率 (Character Error Rate)。

    使用编辑距离 (Levenshtein Distance) 按字符计算：
    CER = (插入 + 删除 + 替换) / 参考文本字数

    Args:
        hypothesis: ASR 转写文本（待评估）
        reference: 人工修正后的参考文本

    Returns:
        CER 值，0.0 表示完全一致，1.0 表示完全不同（可能 > 1）
    """
    if not reference:
        return 0.0 if not hypothesis else 1.0

    h = list(hypothesis)
    r = list(reference)
    n, m = len(h), len(r)

    # 动态规划计算编辑距离
    dp = list(range(m + 1))
    for i in range(1, n + 1):
        prev = dp[0]
        dp[0] = i
        for j in range(1, m + 1):
            temp = dp[j]
            if h[i - 1] == r[j - 1]:
                dp[j] = prev
            else:
                dp[j] = 1 + min(prev, dp[j], dp[j - 1])
            prev = temp

    return dp[m] / m


def cohens_kappa(labels_a: list[str], labels_b: list[str]) -> float:
    """计算 Cohen's Kappa 系数，衡量两个标注序列的一致性。

    κ = (Po - Pe) / (1 - Pe)
    - Po: 实际一致率
    - Pe: 随机一致的期望概率

    解读：
    - κ > 0.8: 高度一致
    - κ > 0.6: 中度一致（可接受）
    - κ < 0.4: 一致性差，需改进标注规范或 Prompt

    Args:
        labels_a: 第一组标注序列（如 LLM 标注）
        labels_b: 第二组标注序列（如 人工标注）

    Returns:
        Kappa 系数，范围 (-1, 1]
    """
    if len(labels_a) != len(labels_b):
        raise ValueError("两个标注序列长度必须相同")

    n = len(labels_a)
    if n == 0:
        return 1.0

    categories = set(labels_a) | set(labels_b)
    po = sum(1 for a, b in zip(labels_a, labels_b) if a == b) / n

    pe = 0.0
    for cat in categories:
        p_a = labels_a.count(cat) / n
        p_b = labels_b.count(cat) / n
        pe += p_a * p_b

    if pe >= 1.0:
        return 1.0
    return (po - pe) / (1 - pe)
