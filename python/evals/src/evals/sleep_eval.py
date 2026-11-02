"""Phase 8: does sleep-time consolidation help LongMemEval retrieval or packing? (PLAN 24).

Turns are ingested per session, scored, consolidated with MEM.CONSOLIDATE
(sleep, dedup, themes, evolve, entities), and scored again. In both passes a
derived memory (an enrichment fact or a sleep-time summary) counts as a
source turn only if it carries one of that turn's sentences.
"""

from __future__ import annotations

import dataclasses
import math
import re
from collections.abc import Callable
from typing import Any

from . import suites
from .client import Mindlog
from .data import Haystack

PER_SLEEP = 200  # episodic memories one sleep run reads (packages/consolidation sleep-time.ts)
ONCE = ["dedup", "themes", "evolve", "entities"]
KINDS = tuple(f"consolidation.{w}" for w in ["sleep", *ONCE])


SENTENCE = re.compile(r"[^.!?\n]+[.!?]?")
MIN_SENTENCE = 20


def carries(derived: str, turn: str) -> bool:
    """Whether a derived memory kept one of a turn's sentences (not just its link)."""
    return any(
        len(s := m.group().strip()) >= MIN_SENTENCE and s in derived
        for m in SENTENCE.finditer(turn)
    )


def resolver(
    client: Mindlog, mappings: dict[str, dict[str, str]], turns: dict[tuple[str, str], str]
) -> suites.Resolve:
    """Corpus turns a memory stands for: its own turn, or the source turns whose text a
    derived memory (an enrichment fact, a sleep-time summary) actually carries."""
    cache: dict[tuple[str, str], list[str]] = {}

    def resolve(scope: str, memory_id: str) -> list[str]:
        if memory_id in mappings[scope]:
            return [mappings[scope][memory_id]]
        key = (scope, memory_id)
        if key not in cache:
            text, sources = client.derived_from(scope, memory_id)
            corpus = [mappings[scope][s] for s in sources if s in mappings[scope]]
            cache[key] = [c for c in corpus if carries(text, turns.get((scope, c), ""))]
        return cache[key]

    return resolve


def consolidate(
    client: Mindlog, haystacks: list[Haystack], say: Callable[[str], None]
) -> dict[str, Any]:
    """Runs the workers until sleep-time has read every turn of every scope."""
    scopes = [h.scope for h in haystacks]
    rounds = max(math.ceil(len(h.turns) / PER_SLEEP) for h in haystacks) + 1
    for r in range(rounds):
        for s in scopes:
            client.consolidate(s, ["sleep", *ONCE] if r == 0 else ["sleep"])
        client.drain(say, scopes, KINDS, timeout_s=7200, poll_s=5)
        say(f"consolidation round {r + 1}/{rounds} done")
    dead = sum(1 for s in scopes for j in client.jobs(s) if str(j["state"]) == "dead")
    return {"rounds": rounds, "dead_jobs": dead}


def evaluate(
    client: Mindlog,
    haystacks: list[Haystack],
    mappings: dict[str, dict[str, str]],
    recipes: tuple[str, ...],
    workers: int,
    say: Callable[[str], None],
) -> dict[str, Any]:
    # Both passes credit a derived memory (an enrichment fact, a sleep-time summary) to the
    # turns it came from, so only what consolidation adds differs between them.
    turns = {(h.scope, t.id): t.text for h in haystacks for t in h.turns}
    resolve = resolver(client, mappings, turns)
    say("scoring before consolidation")
    before = suites.score(client, haystacks, mappings, recipes, 1, resolve)
    packing_before = suites.packing_curve(client, haystacks, mappings, ("full",), workers, resolve)
    run = consolidate(client, haystacks, say)
    say("scoring after consolidation")
    after = suites.score(client, haystacks, mappings, recipes, 1, resolve)
    packing_after = suites.packing_curve(client, haystacks, mappings, ("full",), workers, resolve)
    return {
        "consolidation": run,
        "before": {r: dataclasses.asdict(s) for r, s in before.items()},
        "after": {r: dataclasses.asdict(s) for r, s in after.items()},
        "packing_before": packing_before,
        "packing_after": packing_after,
    }


def markdown(result: dict[str, Any]) -> str:
    lines = [
        "# Phase 8: sleep-time consolidation on LongMemEval",
        "",
        result["meta"]["note"],
        "",
        "## Retrieval (turn level)",
        "",
        "| recipe | recall_any@10 before | after | NDCG@10 before | after |",
        "|---|---|---|---|---|",
    ]
    for r, b in result["before"].items():
        a = result["after"][r]
        cells = [x["turn"].get(m, 0) for m in ("recall_any@10", "ndcg@10") for x in (b, a)]
        lines.append(f"| {r} | " + " | ".join(f"{c:.3f}" for c in cells) + " |")
    lines += [
        "",
        "## Packing (`full`): evidence packed and tokens used per budget",
        "",
        "| budget | evidence before | after | tokens before | after |",
        "|---|---|---|---|---|",
    ]
    for b, a in zip(result["packing_before"]["full"], result["packing_after"]["full"], strict=True):
        lines.append(
            f"| {b['budget']} | {b['evidence_packed']:.3f} | {a['evidence_packed']:.3f}"
            f" | {b['tokens_used']:.0f} | {a['tokens_used']:.0f} |"
        )
    c = result["consolidation"]
    lines += ["", f"Consolidation: {c['rounds']} rounds, {c['dead_jobs']} dead jobs.", ""]
    return "\n".join(lines)
