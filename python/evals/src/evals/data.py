"""Datasets: download, load and sample LongMemEval_s and LoCoMo into one shape."""

from __future__ import annotations

import json
import random
import re
import urllib.request
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parents[2] / "data"

SOURCES = {
    "longmemeval_s_cleaned.json": (
        "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/"
        "longmemeval_s_cleaned.json"
    ),
    "locomo10.json": "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json",
}


@dataclass(frozen=True)
class Turn:
    """One stored unit: its corpus id (turn granularity) and its text."""

    id: str
    text: str


@dataclass(frozen=True)
class Question:
    id: str
    category: str
    text: str
    #: Corpus ids of the evidence turns.
    evidence: frozenset[str]


@dataclass(frozen=True)
class Haystack:
    """What one scope holds and the questions asked of it."""

    scope: str
    turns: tuple[Turn, ...]
    questions: tuple[Question, ...]


def download(data_dir: Path = DATA_DIR) -> list[Path]:
    """Fetches the datasets once (the only network step); existing files are kept."""
    data_dir.mkdir(parents=True, exist_ok=True)
    out = []
    for name, url in SOURCES.items():
        path = data_dir / name
        if not path.exists():
            tmp = path.with_suffix(".part")
            urllib.request.urlretrieve(url, tmp)
            tmp.rename(path)
        out.append(path)
    return out


def session_of(turn_id: str) -> str:
    """The session of a turn id (`<session>_<n>` or `D<s>:<n>`)."""
    if ":" in turn_id:
        return turn_id.split(":", 1)[0]
    return turn_id.rsplit("_", 1)[0]


def longmemeval(path: Path) -> list[Haystack]:
    """One haystack per non-abstention question; user turns only (the paper's turn granularity)."""
    out = []
    for q in json.loads(path.read_text()):
        qid = str(q["question_id"])
        if qid.endswith("_abs"):
            continue
        turns: list[Turn] = []
        evidence: set[str] = set()
        for sid, session in zip(q["haystack_session_ids"], q["haystack_sessions"], strict=True):
            for i, turn in enumerate(session):
                if turn["role"] != "user":
                    continue
                tid = f"{sid}_{i + 1}"
                turns.append(Turn(tid, str(turn["content"])))
                if turn.get("has_answer"):
                    evidence.add(tid)
        if not evidence:
            continue
        question = Question(qid, str(q["question_type"]), str(q["question"]), frozenset(evidence))
        out.append(Haystack(f"lme-{qid}", tuple(turns), (question,)))
    return out


_DIA = re.compile(r"D:?(\d+):(\d+)")


def locomo(path: Path) -> list[Haystack]:
    """One haystack per conversation; adversarial questions (category 5) are skipped."""
    out = []
    for conv in json.loads(path.read_text()):
        c = conv["conversation"]
        turns = [
            Turn(t["dia_id"], f"{t['speaker']}: {t['text']}")
            for key in sorted(
                (k for k in c if re.fullmatch(r"session_\d+", k)), key=lambda k: int(k[8:])
            )
            for t in c[key]
        ]
        known = {t.id for t in turns}
        questions = []
        for i, qa in enumerate(conv["qa"]):
            if qa["category"] == 5:
                continue
            ids = {f"D{s}:{n}" for e in qa.get("evidence", []) for s, n in _DIA.findall(e)}
            ids &= known
            if ids:
                questions.append(
                    Question(
                        f"{conv['sample_id']}-{i}",
                        str(qa["category"]),
                        qa["question"],
                        frozenset(ids),
                    )
                )
        out.append(Haystack(f"locomo-{conv['sample_id']}", tuple(turns), tuple(questions)))
    return out


def stratified(haystacks: list[Haystack], n: int, seed: int) -> list[Haystack]:
    """A seeded sample of `n` single-question haystacks, proportional per category."""
    if n >= len(haystacks):
        return list(haystacks)
    by: dict[str, list[Haystack]] = defaultdict(list)
    for h in haystacks:
        by[h.questions[0].category].append(h)
    rng = random.Random(seed)
    total = len(haystacks)
    # Largest remainders, so the quotas add up to n.
    exact = {c: n * len(hs) / total for c, hs in by.items()}
    quota = {c: int(x) for c, x in exact.items()}
    for c in sorted(by, key=lambda c: (quota[c] - exact[c], c))[: n - sum(quota.values())]:
        quota[c] += 1
    out = []
    for c in sorted(by):
        out.extend(rng.sample(sorted(by[c], key=lambda h: h.scope), quota[c]))
    return out
