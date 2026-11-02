"""Summaries for consolidation (PLAN 12.6, 14.3).

`ExtractiveSummarizer` needs no generative model: it keeps the sentences closest to
the centroid of all sentences (or the lead sentences without an embedder). With a
GGUF model configured, `LlamaExtractor.summarize` writes an abstractive summary.
"""

import re

import numpy as np

from model_service.capabilities import Embedder

SENTENCE = re.compile(r"[^.!?\n]+[.!?]*")
DEFAULT_MAX_CHARS = 600


def sentences(texts: list[str]) -> list[str]:
    """Distinct sentences of the texts, in order."""
    seen: dict[str, None] = {}
    for text in texts:
        for match in SENTENCE.finditer(text):
            s = match.group().strip()
            if s and s.lower() not in (k.lower() for k in seen):
                seen[s] = None
    return list(seen)


def fit(chosen: list[str], max_chars: int) -> str:
    """Joins sentences in order while they fit; a lone long sentence is cut."""
    out = ""
    for s in chosen:
        nxt = f"{out} {s}".strip()
        if len(nxt) > max_chars:
            break
        out = nxt
    if not out and chosen:
        out = chosen[0][:max_chars]
    return out


class ExtractiveSummarizer:
    """Centroid sentence selection (instruction-free: it never follows the texts)."""

    def __init__(self, embedder: Embedder | None) -> None:
        self._embedder = embedder
        self.model_id = (
            f"extractive-centroid@1+{embedder.model_id}" if embedder else "lead-sentences@1"
        )

    def summarize(self, texts: list[str], instruction: str, max_chars: int) -> str:
        del instruction  # extractive: the choice depends only on the texts
        limit = max_chars or DEFAULT_MAX_CHARS
        found = sentences(texts)
        if len(found) <= 1 or self._embedder is None:
            return fit(found, limit)
        vectors = self._embedder.embed(found, "passage")
        centroid = vectors.mean(axis=0)
        centroid /= max(float(np.linalg.norm(centroid)), 1e-12)
        order = np.argsort(-(vectors @ centroid), kind="stable")
        picked: list[int] = []
        size = 0
        for i in order:
            length = len(found[int(i)]) + 1
            if size + length > limit and picked:
                continue
            picked.append(int(i))
            size += length
        return fit([found[i] for i in sorted(picked)], limit)
