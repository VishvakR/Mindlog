"""Retrieval metrics as LongMemEval reports them (src/retrieval/eval_utils.py)."""

from __future__ import annotations

import math
from collections.abc import Callable, Sequence


def dedupe(ids: Sequence[str]) -> list[str]:
    seen: set[str] = set()
    out = []
    for i in ids:
        if i not in seen:
            seen.add(i)
            out.append(i)
    return out


def recall_any(ranked: Sequence[str], gold: frozenset[str], k: int) -> float:
    return float(any(r in gold for r in ranked[:k]))


def recall_all(ranked: Sequence[str], gold: frozenset[str], k: int) -> float:
    return float(gold <= set(ranked[:k]))


def ndcg(ranked: Sequence[str], gold: frozenset[str], k: int) -> float:
    """Binary-relevance NDCG@k; the ideal ranks every gold id first."""
    dcg = sum(1 / math.log2(i + 2) for i, r in enumerate(ranked[:k]) if r in gold)
    ideal = sum(1 / math.log2(i + 2) for i in range(min(k, len(gold))))
    return dcg / ideal if ideal else 0.0


def at_level(
    ranked: Sequence[str], gold: frozenset[str], k: int, to: Callable[[str], str] | None = None
) -> dict[str, float]:
    """recall_any, recall_all and NDCG at k, on turns or (with `to`) on sessions."""
    if to is not None:
        ranked = dedupe([to(r) for r in ranked])
        gold = frozenset(to(g) for g in gold)
    return {
        f"recall_any@{k}": recall_any(ranked, gold, k),
        f"recall_all@{k}": recall_all(ranked, gold, k),
        f"ndcg@{k}": ndcg(ranked, gold, k),
    }


def mean(rows: Sequence[dict[str, float]]) -> dict[str, float]:
    if not rows:
        return {}
    return {key: sum(r[key] for r in rows) / len(rows) for key in rows[0]}
