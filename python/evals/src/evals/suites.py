"""Ingest haystacks into Mindlog and score the recall recipes on them."""

from __future__ import annotations

import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

from .client import Mindlog
from .data import Haystack, Question, session_of
from .metrics import at_level, dedupe, mean

RECIPES = ("rag", "vector", "hybrid", "hybrid_ppr", "full")
KS = (5, 10)
SEARCH_K = 50
BUDGETS = (250, 500, 1000, 2000, 4000)

Job = tuple[Haystack, Question]


def ingest(
    client: Mindlog, haystacks: list[Haystack], workers: int, say: Callable[[str], None]
) -> dict[str, dict[str, str]]:
    """Stores every turn (resuming where a previous run stopped); returns memory → corpus ids."""

    def one(h: Haystack) -> tuple[str, dict[str, str]]:
        mapping, start = client.mapping(h.scope)
        for i in range(start, len(h.turns)):
            turn = h.turns[i]
            ids = client.add(h.scope, turn.text) if turn.text.strip() else []
            client.record(h.scope, ids, turn.id, i + 1)
            mapping.update(dict.fromkeys(ids, turn.id))
        return h.scope, mapping

    started = time.monotonic()
    out: dict[str, dict[str, str]] = {}
    with ThreadPoolExecutor(workers) as pool:
        for n, (scope, mapping) in enumerate(pool.map(one, haystacks), 1):
            out[scope] = mapping
            if n % 10 == 0 or n == len(haystacks):
                say(f"ingested {n}/{len(haystacks)} scopes ({time.monotonic() - started:.0f} s)")
    return out


@dataclass
class RecipeScore:
    turn: dict[str, float] = field(default_factory=dict)
    session: dict[str, float] = field(default_factory=dict)
    by_category: dict[str, dict[str, float]] = field(default_factory=dict)
    p50_ms: float = 0.0
    p95_ms: float = 0.0


def _percentile(xs: list[float], p: float) -> float:
    s = sorted(xs)
    return s[min(len(s) - 1, int(p / 100 * len(s)))] if s else 0.0


def score(
    client: Mindlog,
    haystacks: list[Haystack],
    mappings: dict[str, dict[str, str]],
    recipes: tuple[str, ...],
    workers: int,
) -> dict[str, RecipeScore]:
    """recall_any / recall_all / NDCG at 5 and 10, on turns and sessions, per recipe."""
    jobs: list[Job] = [(h, q) for h in haystacks for q in h.questions]
    out: dict[str, RecipeScore] = {}
    for recipe in recipes:

        def one(
            job: Job, recipe: str = recipe
        ) -> tuple[str, dict[str, float], dict[str, float], float]:
            h, q = job
            started = time.monotonic()
            ids = client.search(h.scope, q.text, SEARCH_K, recipe)
            ms = (time.monotonic() - started) * 1000
            ranked = dedupe([mappings[h.scope][i] for i in ids if i in mappings[h.scope]])
            turn: dict[str, float] = {}
            session: dict[str, float] = {}
            for k in KS:
                turn |= at_level(ranked, q.evidence, k)
                session |= at_level(ranked, q.evidence, k, session_of)
            return q.category, turn, session, ms

        with ThreadPoolExecutor(workers) as pool:
            rows = list(pool.map(one, jobs))
        cats: dict[str, list[dict[str, float]]] = {}
        for cat, turn, _, _ in rows:
            cats.setdefault(cat, []).append(turn)
        times = [r[3] for r in rows]
        out[recipe] = RecipeScore(
            turn=mean([r[1] for r in rows]),
            session=mean([r[2] for r in rows]),
            by_category={c: mean(v) for c, v in sorted(cats.items())},
            p50_ms=_percentile(times, 50),
            p95_ms=_percentile(times, 95),
        )
    return out


def packing_curve(
    client: Mindlog,
    haystacks: list[Haystack],
    mappings: dict[str, dict[str, str]],
    recipes: tuple[str, ...],
    workers: int,
) -> dict[str, list[dict[str, float]]]:
    """Per budget: share of questions with an evidence turn packed, and the tokens used."""
    jobs: list[Job] = [(h, q) for h in haystacks for q in h.questions]
    out: dict[str, list[dict[str, float]]] = {}
    for recipe in recipes:
        points = []
        for budget in BUDGETS:

            def one(job: Job, budget: int = budget, recipe: str = recipe) -> tuple[float, int]:
                h, q = job
                ids, tokens = client.pack(h.scope, q.text, budget, recipe)
                packed = {mappings[h.scope].get(i) for i in ids}
                return float(bool(packed & q.evidence)), tokens

            with ThreadPoolExecutor(workers) as pool:
                rows = list(pool.map(one, jobs))
            points.append(
                {
                    "budget": budget,
                    "evidence_packed": sum(r[0] for r in rows) / len(rows),
                    "tokens_used": sum(r[1] for r in rows) / len(rows),
                }
            )
        out[recipe] = points
    return out
