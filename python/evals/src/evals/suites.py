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
# Corpus ids a returned memory stands for: its own turn, or a summary's source turns.
Resolve = Callable[[str, str], list[str]]


def by_mapping(mappings: dict[str, dict[str, str]]) -> Resolve:
    return lambda scope, i: [mappings[scope][i]] if i in mappings[scope] else []


def ingest(
    client: Mindlog,
    haystacks: list[Haystack],
    workers: int,
    say: Callable[[str], None],
    sessions: bool = False,
) -> tuple[dict[str, dict[str, str]], int]:
    """Stores every turn (resuming where a previous run stopped) and waits for enrichment.

    With `sessions`, each turn goes into `<scope>/lme/<session>`, so sleep-time
    consolidation sees the sessions; recall at `<scope>` still covers them all.
    Returns memory → corpus ids per scope and how many writes came back degraded.
    """

    def one(h: Haystack) -> tuple[str, dict[str, str], int]:
        mapping, start = client.mapping(h.scope)
        degraded = 0
        for i in range(start, len(h.turns)):
            turn = h.turns[i]
            at = f"{h.scope}/lme/{session_of(turn.id)}" if sessions else h.scope
            ids, raw = client.add(at, turn.text) if turn.text.strip() else ([], False)
            degraded += raw
            client.record(h.scope, ids, turn.id, i + 1)
            mapping.update(dict.fromkeys(ids, turn.id))
        return h.scope, mapping, degraded

    started = time.monotonic()
    out: dict[str, dict[str, str]] = {}
    degraded = 0
    with ThreadPoolExecutor(workers) as pool:
        for n, (scope, mapping, d) in enumerate(pool.map(one, haystacks), 1):
            out[scope] = mapping
            degraded += d
            if n % 10 == 0 or n == len(haystacks):
                say(f"ingested {n}/{len(haystacks)} scopes ({time.monotonic() - started:.0f} s)")
    if degraded:
        say(f"{degraded} writes were degraded under load")
    # Degraded writes have no vectors until their enrichment jobs run; score only after.
    client.drain(say, [h.scope for h in haystacks])
    return out, degraded


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
    resolve: Resolve | None = None,
) -> dict[str, RecipeScore]:
    """recall_any / recall_all / NDCG at 5 and 10, on turns and sessions, per recipe."""
    jobs: list[Job] = [(h, q) for h in haystacks for q in h.questions]
    out: dict[str, RecipeScore] = {}
    corpus = resolve or by_mapping(mappings)
    for recipe in recipes:

        def one(
            job: Job, recipe: str = recipe
        ) -> tuple[str, dict[str, float], dict[str, float], float]:
            h, q = job
            started = time.monotonic()
            ids = client.search(h.scope, q.text, SEARCH_K, recipe)
            ms = (time.monotonic() - started) * 1000
            ranked = dedupe([c for i in ids for c in corpus(h.scope, i)])
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
    resolve: Resolve | None = None,
) -> dict[str, list[dict[str, float]]]:
    """Per budget: share of questions with an evidence turn packed, and the tokens used."""
    jobs: list[Job] = [(h, q) for h in haystacks for q in h.questions]
    out: dict[str, list[dict[str, float]]] = {}
    corpus = resolve or by_mapping(mappings)
    for recipe in recipes:
        points = []
        for budget in BUDGETS:

            def one(job: Job, budget: int = budget, recipe: str = recipe) -> tuple[float, int]:
                h, q = job
                ids, tokens = client.pack(h.scope, q.text, budget, recipe)
                packed = {c for i in ids for c in corpus(h.scope, i)}
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
