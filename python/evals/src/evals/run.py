"""`uv run python -m evals.run --suite longmemeval|locomo|cache|all|conflicts` against a node."""

from __future__ import annotations

import argparse
import dataclasses
import json
import sys
import time
from pathlib import Path
from typing import Any

from . import cache_eval, conflict_eval, conflict_pairs, data, report, suites
from .client import Mindlog

ROOT = Path(__file__).resolve().parents[4]
OUT = ROOT / "docs" / "evals" / "phase-6"
CONFLICTS_OUT = ROOT / "docs" / "evals" / "phase-7"


def say(line: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {line}", file=sys.stderr, flush=True)


def run_suite(
    client: Mindlog, name: str, haystacks: list[data.Haystack], args: argparse.Namespace, note: str
) -> dict[str, Any]:
    say(f"{name}: {len(haystacks)} scopes, {sum(len(h.turns) for h in haystacks)} turns")
    mappings, degraded = suites.ingest(client, haystacks, args.workers, say)
    # One query at a time, so the latency columns are per query, not queueing at the models.
    scores = suites.score(client, haystacks, mappings, tuple(args.recipes), 1)
    result: dict[str, Any] = {
        "meta": {
            "scopes": len(haystacks),
            "questions": sum(len(h.questions) for h in haystacks),
            "memories": sum(len(m) for m in mappings.values()),
            "degraded_writes": degraded,
            "note": note,
        },
        "recipes": {r: dataclasses.asdict(s) for r, s in scores.items()},
    }
    if args.packing:
        result["packing"] = suites.packing_curve(
            client, haystacks, mappings, ("rag", "full"), args.workers
        )
    return result


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument(
        "--suite", choices=["longmemeval", "locomo", "cache", "all", "conflicts"], default="all"
    )
    p.add_argument("--models", default="127.0.0.1:50051", help="model service, for the NLI sweep")
    p.add_argument("--n", type=int, default=100, help="LongMemEval questions (stratified sample)")
    p.add_argument("--full", action="store_true", help="all 500 LongMemEval questions")
    p.add_argument("--seed", type=int, default=6)
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=6390)
    p.add_argument("--http-port", type=int, default=8099, help="the node's HTTP port (metrics)")
    p.add_argument("--workers", type=int, default=16)
    p.add_argument("--recipes", nargs="+", default=list(suites.RECIPES))
    p.add_argument("--no-packing", dest="packing", action="store_false")
    p.add_argument("--out", type=Path, default=OUT, help="results path without extension")
    args = p.parse_args(argv)

    client = Mindlog(args.host, args.port, http_port=args.http_port)
    if args.suite == "conflicts":
        run_conflicts(args)
        return
    lme_path, locomo_path = data.download()
    json_path, md_path = args.out.with_suffix(".json"), args.out.with_suffix(".md")
    merged: dict[str, Any] = {}
    if args.suite in ("longmemeval", "all"):
        all_lme = data.longmemeval(lme_path)
        n = len(all_lme) if args.full else args.n
        sample = data.stratified(all_lme, n, args.seed)
        note = (
            f"stratified sample of {len(sample)} (seed {args.seed}), abstention questions excluded."
        )
        merged = report.merge(
            json_path, "longmemeval", run_suite(client, "longmemeval", sample, args, note)
        )
    if args.suite in ("locomo", "all"):
        conv = data.locomo(locomo_path)
        note = "all 10 conversations, adversarial (category 5) questions excluded."
        merged = report.merge(json_path, "locomo", run_suite(client, "locomo", conv, args, note))
    if args.suite in ("cache", "all"):
        questions = [h.questions[0].text for h in data.longmemeval(lme_path)]
        merged = report.merge(
            json_path, "cache", cache_eval.evaluate(client, questions, args.seed, args.workers, say)
        )
    md_path.write_text(report.markdown(merged))
    say(f"wrote {json_path} and {md_path}")


def run_conflicts(args: argparse.Namespace) -> None:
    """Phase 7: conflict detection on the hand-written pairs (its own report)."""
    pairs = conflict_pairs.pairs()
    say(f"conflicts: {len(pairs)} pairs; NLI sweep against {args.models}")
    result = {
        "sweep": conflict_eval.sweep(args.models, pairs),
        "end_to_end": conflict_eval.end_to_end(
            lambda: Mindlog(args.host, args.port, http_port=args.http_port),
            pairs,
            args.workers,
            say,
        ),
    }
    config = {"threshold": 0.95, "minSimilarity": 0.5, "policy": "quarantine_new"}
    out = CONFLICTS_OUT
    out.with_suffix(".json").write_text(json.dumps(result, indent=2) + "\n")
    out.with_suffix(".md").write_text(conflict_eval.markdown(result, config))
    say(f"wrote {out}.json and .md; end-to-end F1 {result['end_to_end']['f1']}")


if __name__ == "__main__":
    main()
