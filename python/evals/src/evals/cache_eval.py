"""Semantic cache precision: hits on reworded repeats vs false hits on different questions."""

from __future__ import annotations

import random
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor

from .client import Mindlog

THRESHOLDS = (0.80, 0.85, 0.88, 0.90, 0.92, 0.94, 0.96, 0.98)
#: Gate (PLAN 24, phase 6): false positives below 2% at the chosen threshold.
MAX_FALSE_POSITIVE_RATE = 0.02

# Rewordings an agent's repeat of a question typically shows; true paraphrases need an
# LLM, so this measures the cache on near repeats (recorded as a limit in the report).
TEMPLATES: tuple[Callable[[str], str], ...] = (
    lambda q: f"Can you remind me: {q}",
    lambda q: f"{q.rstrip('?. ')}, please?",
    lambda q: f"Quick question. {q}",
)


def evaluate(
    client: Mindlog, questions: list[str], seed: int, workers: int, say: Callable[[str], None]
) -> dict[str, object]:
    """Stores half of the questions, then looks up rewordings of them (positives) and the
    other half (negatives, all different questions). Every lookup asks for the best entry
    at threshold 0, so one pass scores every threshold."""
    distinct = sorted({q.strip() for q in questions if q.strip()})
    random.Random(seed).shuffle(distinct)
    half = len(distinct) // 2
    stored, held_out = distinct[:half], distinct[half:]
    scope = f"cache-eval-{seed}"
    answer_of = {q: f"answer-{i}" for i, q in enumerate(stored)}
    if not client.mapping(scope)[1]:
        with ThreadPoolExecutor(workers) as pool:
            list(pool.map(lambda q: client.cache_set(scope, q, answer_of[q]), stored))
        client.record(scope, [], "stored", 1)
    say(f"cache: {len(stored)} entries stored, {len(held_out)} held out")

    lookups: list[tuple[str, str | None]] = [
        (t(q), answer_of[q]) for q in stored for t in TEMPLATES
    ]
    lookups += [(q, None) for q in held_out]

    def best(job: tuple[str, str | None]) -> tuple[str | None, str | None, float]:
        prompt, expected = job
        hit = client.cache_get(scope, prompt, 0.0)
        return expected, *(hit if hit else (None, 0.0))

    with ThreadPoolExecutor(workers) as pool:
        results = list(pool.map(best, lookups))
    curve = sweep(results)
    ok = [c for c in curve if c["false_positive_rate"] < MAX_FALSE_POSITIVE_RATE]
    chosen = max(ok, key=lambda c: (c["hit_rate"], -c["threshold"])) if ok else None
    positives = sum(1 for e, _, _ in results if e is not None)
    return {
        "stored": len(stored),
        "lookups": len(results),
        "positives": positives,
        "negatives": len(results) - positives,
        "curve": curve,
        "chosen": chosen,
    }


Result = tuple[str | None, str | None, float]


def sweep(results: list[Result]) -> list[dict[str, float]]:
    """Per threshold, from (expected answer or None, best answer, similarity) per lookup.

    `false_positive_rate` is the larger of two wrong-answer rates, each over its own
    lookups: different questions that hit anything, and repeats that hit another entry.
    """
    positives = [(e, a, s) for e, a, s in results if e is not None]
    negatives = [(a, s) for e, a, s in results if e is None]
    curve = []
    for t in THRESHOLDS:
        right = sum(1 for e, a, s in positives if s >= t and a == e)
        wrong_repeat = sum(1 for e, a, s in positives if s >= t and a is not None and a != e)
        wrong_other = sum(1 for a, s in negatives if s >= t and a is not None)
        hits = right + wrong_repeat + wrong_other
        on_negatives = wrong_other / len(negatives) if negatives else 0.0
        on_repeats = wrong_repeat / len(positives) if positives else 0.0
        curve.append(
            {
                "threshold": t,
                "hit_rate": right / len(positives) if positives else 0.0,
                "false_positive_rate": max(on_negatives, on_repeats),
                "false_hits_on_different": on_negatives,
                "wrong_entry_on_repeats": on_repeats,
                "wrong_share_of_hits": (wrong_repeat + wrong_other) / hits if hits else 0.0,
            }
        )
    return curve
