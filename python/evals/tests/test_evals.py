import json
from pathlib import Path

import pytest
from evals.cache_eval import sweep
from evals.metrics import at_level, dedupe, ndcg, recall_all, recall_any
from evals.report import markdown

from evals.data import Haystack, Question, Turn, locomo, longmemeval, session_of, stratified


def test_metrics_match_longmemeval_definitions() -> None:
    gold = frozenset({"b", "d"})
    ranked = ["a", "b", "c", "d"]
    assert recall_any(ranked, gold, 1) == 0.0
    assert recall_any(ranked, gold, 2) == 1.0
    assert recall_all(ranked, gold, 3) == 0.0
    assert recall_all(ranked, gold, 4) == 1.0
    # DCG = 1/log2(3) + 1/log2(5); ideal = 1 + 1/log2(3).
    assert ndcg(ranked, gold, 4) == pytest.approx((0.6309298 + 0.4306766) / 1.6309298, rel=1e-6)
    assert ndcg(["b", "d"], gold, 10) == 1.0
    assert ndcg([], gold, 10) == 0.0


def test_session_level_counts_distinct_sessions() -> None:
    # Three turns of one session, then the evidence session: top 2 sessions include it.
    ranked = ["s1_1", "s1_3", "s1_5", "answer_s2_2"]
    gold = frozenset({"answer_s2_4"})
    assert at_level(ranked, gold, 2)["recall_any@2"] == 0.0
    assert at_level(ranked, gold, 2, session_of)["recall_any@2"] == 1.0
    assert session_of("D3:12") == "D3"
    assert dedupe(["a", "b", "a"]) == ["a", "b"]


def test_longmemeval_uses_user_turns_and_has_answer_labels(tmp_path: Path) -> None:
    item = {
        "question_id": "q1",
        "question_type": "single-session-user",
        "question": "What car do I drive?",
        "haystack_session_ids": ["s0", "answer_s1"],
        "haystack_sessions": [
            [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "hello"}],
            [
                {"role": "user", "content": "I drive a Golf", "has_answer": True},
                {"role": "assistant", "content": "nice"},
                {"role": "user", "content": "bye", "has_answer": False},
            ],
        ],
    }
    path = tmp_path / "lme.json"
    path.write_text(json.dumps([item, {**item, "question_id": "q2_abs"}]))
    [h] = longmemeval(path)
    assert h.scope == "lme-q1"
    assert [t.id for t in h.turns] == ["s0_1", "answer_s1_1", "answer_s1_3"]
    assert h.questions[0].evidence == frozenset({"answer_s1_1"})


def test_locomo_parses_messy_evidence_and_skips_adversarial(tmp_path: Path) -> None:
    conv = {
        "sample_id": "c1",
        "conversation": {
            "speaker_a": "A",
            "session_1": [
                {"speaker": "A", "dia_id": "D1:1", "text": "hi"},
                {"speaker": "B", "dia_id": "D1:2", "text": "yo"},
            ],
            "session_1_date_time": "x",
            "session_2": [{"speaker": "A", "dia_id": "D2:1", "text": "later"}],
        },
        "qa": [
            {"question": "q?", "answer": "a", "evidence": ["D1:2; D:2:1", "D9:9"], "category": 1},
            {"question": "adv?", "answer": "a", "evidence": ["D1:1"], "category": 5},
            {"question": "none?", "answer": "a", "evidence": ["D"], "category": 2},
        ],
    }
    path = tmp_path / "locomo.json"
    path.write_text(json.dumps([conv]))
    [h] = locomo(path)
    assert [t.text for t in h.turns] == ["A: hi", "B: yo", "A: later"]
    assert [q.evidence for q in h.questions] == [frozenset({"D1:2", "D2:1"})]


def _hay(i: int, cat: str) -> Haystack:
    return Haystack(f"s{i}", (Turn("t", "x"),), (Question(f"q{i}", cat, "?", frozenset({"t"})),))


def test_stratified_sample_is_seeded_and_proportional() -> None:
    hs = [_hay(i, "a") for i in range(60)] + [_hay(60 + i, "b") for i in range(30)]
    hs += [_hay(90 + i, "c") for i in range(10)]
    one = stratified(hs, 10, seed=6)
    assert [h.scope for h in one] == [h.scope for h in stratified(hs, 10, seed=6)]
    cats = [h.questions[0].category for h in one]
    assert (cats.count("a"), cats.count("b"), cats.count("c")) == (6, 3, 1)
    assert stratified(hs, 7, seed=1) != stratified(hs, 7, seed=2)
    assert len(stratified(hs, 7, seed=1)) == 7
    assert len(stratified(hs, 500, seed=1)) == 100


def test_report_renders_every_section() -> None:
    score = {
        "turn": {"recall_any@5": 0.5, "recall_any@10": 0.75, "ndcg@10": 0.4},
        "session": {"recall_any@5": 0.6, "recall_any@10": 0.8},
        "by_category": {"temporal": {"recall_any@10": 0.7}},
        "p50_ms": 12.0,
        "p95_ms": 30.0,
    }
    data = {
        "longmemeval": {
            "meta": {"questions": 2, "scopes": 2, "memories": 10, "note": "n."},
            "recipes": {"vector": score},
            "packing": {"rag": [{"budget": 250, "evidence_packed": 0.5, "tokens_used": 200.0}]},
        },
        "cache": {
            "stored": 2,
            "positives": 6,
            "negatives": 2,
            "curve": [
                {
                    "threshold": 0.9,
                    "hit_rate": 1.0,
                    "false_positive_rate": 0.0,
                    "false_hits_on_different": 0.0,
                    "wrong_entry_on_repeats": 0.0,
                    "wrong_share_of_hits": 0.0,
                }
            ],
            "chosen": {"threshold": 0.9},
        },
    }
    md = markdown(data)
    assert "| Vector + scoring | 50.0 | 75.0 | 40.0 | 60.0 | 80.0 | 12 | 30 |" in md
    assert "| Plain RAG (vector, similarity only) | 50.0 (200) |" in md
    assert "Chosen threshold: 0.90" in md


def test_cache_false_positives_are_rated_over_their_own_lookups() -> None:
    results = [
        ("a1", "a1", 0.95),  # repeat, right entry
        ("a2", "a1", 0.95),  # repeat, another question's entry
        ("a3", "a3", 0.85),  # repeat, right entry below 0.90
        (None, "a1", 0.91),  # different question, false hit
        (None, "a2", 0.50),
        (None, None, 0.0),
        (None, "a3", 0.30),
    ]
    at_90 = next(c for c in sweep(results) if c["threshold"] == 0.90)
    assert at_90["hit_rate"] == pytest.approx(1 / 3)
    assert at_90["false_hits_on_different"] == pytest.approx(1 / 4)
    assert at_90["wrong_entry_on_repeats"] == pytest.approx(1 / 3)
    assert at_90["false_positive_rate"] == pytest.approx(1 / 3)
    assert at_90["wrong_share_of_hits"] == pytest.approx(2 / 3)
