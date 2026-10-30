"""Conflict detection quality (PLAN 13.2, ADR-0015) on the hand-written pair set.

Two parts:
1. A sweep straight against the model service: NLI in both directions and the
   embedding cosine of each pair, scored at many thresholds, aggregations and
   similarity gates, to choose the defaults.
2. End to end through Mindlog: each pair in its own scope, the second fact
   remembered after the first, and whether a conflict was raised (or, for the
   `change` pairs, the old fact superseded instead).
"""

from __future__ import annotations

import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import grpc
import numpy as np
from mindlog.v1 import models_pb2, models_pb2_grpc

from .client import Mindlog
from .conflict_pairs import Pair

THRESHOLDS = [round(0.5 + 0.05 * i, 2) for i in range(10)]
GATES = [0.0, 0.3, 0.4, 0.5]
BATCH = 32


def prf(tp: int, fp: int, fn: int) -> dict[str, float]:
    p = tp / (tp + fp) if tp + fp else 0.0
    r = tp / (tp + fn) if tp + fn else 0.0
    f = 2 * p * r / (p + r) if p + r else 0.0
    return {"precision": round(p, 3), "recall": round(r, 3), "f1": round(f, 3)}


def _nli(stub: Any, pairs: list[tuple[str, str]]) -> list[float]:
    """Contradiction probability of each pair (0 when another label wins)."""
    out: list[float] = []
    for i in range(0, len(pairs), BATCH):
        req = models_pb2.ClassifyNliRequest(
            pairs=[models_pb2.NliPair(premise=p, hypothesis=h) for p, h in pairs[i : i + BATCH]]
        )
        for r in stub.ClassifyNli(req, timeout=120).results:
            out.append(r.score if r.label == models_pb2.NLI_LABEL_CONTRADICTION else 0.0)
    return out


def _cosines(stub: Any, pairs: list[Pair]) -> list[float]:
    texts = sorted({t for p in pairs for t in (p.a, p.b)})
    vec: dict[str, np.ndarray] = {}
    for i in range(0, len(texts), BATCH):
        chunk = texts[i : i + BATCH]
        reply = stub.Embed(
            models_pb2.EmbedRequest(texts=chunk, kind=models_pb2.EMBED_KIND_PASSAGE), timeout=120
        )
        for t, raw in zip(chunk, reply.vectors, strict=True):
            vec[t] = np.frombuffer(raw, dtype="<f4")
    return [float(vec[p.a] @ vec[p.b]) for p in pairs]


def sweep(models: str, pairs: list[Pair]) -> dict[str, Any]:
    """P/R/F1 of 'contradict' against everything else, without the temporal pairs."""
    scored = [p for p in pairs if p.label != "change"]
    with grpc.insecure_channel(models) as channel:
        stub = models_pb2_grpc.ModelsServiceStub(channel)
        ab = _nli(stub, [(p.a, p.b) for p in scored])
        ba = _nli(stub, [(p.b, p.a) for p in scored])
        cos = _cosines(stub, scored)

    def score(idx: list[int]) -> list[dict[str, Any]]:
        rows = []
        for agg, combine in (("max", max), ("min", min)):
            for gate in GATES:
                for theta in THRESHOLDS:
                    tp = fp = fn = 0
                    for i in idx:
                        hit = cos[i] >= gate and combine(ab[i], ba[i]) >= theta
                        want = scored[i].label == "contradict"
                        tp += hit and want
                        fp += hit and not want
                        fn += want and not hit
                    rows.append({"agg": agg, "gate": gate, "theta": theta, **prf(tp, fp, fn)})
        return rows

    def top(rows: list[dict[str, Any]]) -> dict[str, Any]:
        return max(rows, key=lambda r: (r["f1"], r["precision"]))

    rows = score(list(range(len(scored))))
    # Choose on even pairs, report on odd ones: how much of the tuning carries over.
    picked = top(score(list(range(0, len(scored), 2))))
    on_odd = score(list(range(1, len(scored), 2)))
    held_out = next(
        r
        for r in on_odd
        if (r["agg"], r["gate"], r["theta"]) == (picked["agg"], picked["gate"], picked["theta"])
    )
    best = top(rows)
    by_label: dict[str, dict[str, float]] = {}
    for label in ("contradict", "entail", "neutral"):
        xs = [max(x, y) for p, x, y in zip(scored, ab, ba, strict=True) if p.label == label]
        cs = [c for p, c in zip(scored, cos, strict=True) if p.label == label]
        by_label[label] = {
            "pairs": len(xs),
            "mean_max_contradiction": round(float(np.mean(xs)), 3),
            "mean_cosine": round(float(np.mean(cs)), 3),
        }
    return {"rows": rows, "best": best, "held_out": held_out, "by_label": by_label}


def end_to_end(
    client_for: Callable[[], Mindlog], pairs: list[Pair], workers: int, say: Callable[[str], None]
) -> dict[str, Any]:
    """Each pair in a fresh scope: remember a, then b; was a conflict raised?"""
    run = time.strftime("%H%M%S")

    def one(i: int, p: Pair) -> tuple[Pair, bool, bool]:
        c = client_for()
        scope = f"cf-{run}-{i}"
        a = c.add_fact(scope, p.a, p.a_from)
        c.add_fact(scope, p.b, p.b_from)
        raised = len(c.conflicts(scope)) > 0
        superseded = p.label == "change" and c.valid_to(scope, a) == p.b_from
        return p, raised, superseded

    with ThreadPoolExecutor(workers) as pool:
        results = list(pool.map(lambda x: one(*x), enumerate(pairs)))
    say(f"conflicts: {len(results)} pairs remembered")
    tp = sum(r and p.label == "contradict" for p, r, _ in results)
    fp = sum(r and p.label != "contradict" for p, r, _ in results)
    fn = sum(not r and p.label == "contradict" for p, r, _ in results)
    raised = {
        label: round(
            sum(r for p, r, _ in results if p.label == label)
            / max(1, sum(p.label == label for p, _, _ in results)),
            3,
        )
        for label in ("contradict", "entail", "neutral", "change")
    }
    changes = [s for p, _, s in results if p.label == "change"]
    return {
        **prf(tp, fp, fn),
        "raised_rate": raised,
        "superseded_rate": round(sum(changes) / max(1, len(changes)), 3),
        "pairs": len(results),
    }


def markdown(result: dict[str, Any], config: dict[str, Any]) -> str:
    s = result["sweep"]
    e = result["end_to_end"]
    lines = [
        "# Phase 7 evals: conflict detection",
        "",
        f"- Pairs: {e['pairs']} (`python/evals/src/evals/conflict_pairs.py`, hand-written "
        "profiles: contradict, entail, neutral same-person facts, and dated changes).",
        f"- Node config: {config}.",
        "",
        "## End to end (each pair in its own scope)",
        "",
        "| precision | recall | F1 | raised: contradict | entail | neutral | change | "
        "change superseded |",
        "|---|---|---|---|---|---|---|---|",
        f"| {e['precision']} | {e['recall']} | **{e['f1']}** | "
        f"{e['raised_rate']['contradict']} | {e['raised_rate']['entail']} | "
        f"{e['raised_rate']['neutral']} | {e['raised_rate']['change']} | "
        f"{e['superseded_rate']} |",
        "",
        "## NLI sweep (model service directly, without the temporal pairs)",
        "",
        "Best on all pairs: " + ", ".join(f"{k} {v}" for k, v in s["best"].items()),
        "",
        "Held out (chosen on even pairs, scored on odd ones): "
        + ", ".join(f"{k} {v}" for k, v in s["held_out"].items()),
        "",
        "| label | pairs | mean max contradiction | mean cosine |",
        "|---|---|---|---|",
    ]
    for label, v in s["by_label"].items():
        lines.append(
            f"| {label} | {v['pairs']} | {v['mean_max_contradiction']} | {v['mean_cosine']} |"
        )
    lines += ["", "| agg | gate | θ | precision | recall | F1 |", "|---|---|---|---|---|---|"]
    for r in s["rows"]:
        if r["theta"] in (0.5, 0.7, 0.8, 0.9):
            lines.append(
                f"| {r['agg']} | {r['gate']} | {r['theta']} | {r['precision']} | "
                f"{r['recall']} | {r['f1']} |"
            )
    return "\n".join(lines) + "\n"
