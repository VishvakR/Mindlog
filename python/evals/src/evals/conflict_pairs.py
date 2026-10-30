"""A labelled set of personal-fact pairs for conflict detection (PLAN 13.2, phase 7).

Hand-written, LoCoMo-style: each attribute below is one fact about a person, a
fact that contradicts it, and a paraphrase that it entails. Pairs are built
deterministically from them and twelve names:

- ``contradict``: the fact and its contradiction (a conflict should be raised);
- ``entail``: the fact and its paraphrase (a duplicate, no conflict);
- ``neutral``: two different facts about the same person (the hard negatives:
  same entity, similar wording, no contradiction);
- ``change``: a contradiction with validity windows, the old fact open-ended and
  the new one starting later (Graphiti's rule: history, so no conflict).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

Label = Literal["contradict", "entail", "neutral", "change"]

# (fact, contradiction, paraphrase); `{n}` is the person's name.
ATTRIBUTES: list[tuple[str, str, str]] = [
    ("{n} is vegetarian.", "{n} eats steak every weekend.", "{n} does not eat meat."),
    ("{n} lives in Lisbon.", "{n} lives in Berlin.", "{n}'s home is in Lisbon."),
    ("{n} works as a nurse.", "{n} works as a software engineer.", "{n} is a nurse by profession."),
    ("{n} has two cats.", "{n} has no pets.", "{n} owns a pair of cats."),
    (
        "{n} is allergic to peanuts.",
        "{n} eats peanut butter every morning without any problem.",
        "Peanuts give {n} an allergic reaction.",
    ),
    ("{n} is married.", "{n} has never been married.", "{n} has a spouse."),
    ("{n} hates coffee.", "{n} loves coffee and drinks three cups a day.", "{n} dislikes coffee."),
    (
        "{n} plays the guitar.",
        "{n} has never played any musical instrument.",
        "{n} plays guitar.",
    ),
    (
        "{n} is afraid of flying.",
        "{n} loves flying and takes a plane every month.",
        "{n} has a fear of flying.",
    ),
    (
        "{n} speaks fluent Japanese.",
        "{n} does not speak any Japanese.",
        "{n} is fluent in Japanese.",
    ),
    ("{n} runs every morning.", "{n} never exercises.", "{n} goes for a run each morning."),
    ("{n} has a daughter.", "{n} has no children.", "{n} is the parent of a girl."),
    (
        "{n} prefers tea over coffee.",
        "{n} prefers coffee over tea.",
        "{n} likes tea more than coffee.",
    ),
    ("{n} drives an electric car.", "{n} does not own a car.", "{n}'s car is electric."),
    ("{n} is an early riser.", "{n} always sleeps until noon.", "{n} wakes up early."),
    ("{n} grew up in Canada.", "{n} grew up in Brazil.", "{n} was raised in Canada."),
    ("{n} is left-handed.", "{n} is right-handed.", "{n} writes with the left hand."),
    ("{n} quit smoking.", "{n} smokes a pack of cigarettes a day.", "{n} no longer smokes."),
    ("{n} studied law at university.", "{n} never went to university.", "{n} has a law degree."),
    (
        "{n} enjoys hiking in the mountains.",
        "{n} dislikes hiking and avoids the outdoors.",
        "{n} likes mountain hikes.",
    ),
    ("{n}'s birthday is in March.", "{n}'s birthday is in October.", "{n} was born in March."),
    ("{n} works from home.", "{n} commutes to an office every day.", "{n} works remotely."),
    (
        "{n} is lactose intolerant.",
        "{n} drinks a glass of milk every day with no problems.",
        "Dairy makes {n} sick.",
    ),
    ("{n} has a sister.", "{n} is an only child.", "{n} has a female sibling."),
    (
        "{n} is colour blind.",
        "{n} has perfect colour vision.",
        "{n} cannot tell some colours apart.",
    ),
    ("{n} supports Benfica.", "{n} supports Porto and dislikes Benfica.", "{n} is a Benfica fan."),
]

# Attributes that change over time, for the `change` pairs (indexes into ATTRIBUTES).
CHANGEABLE = [1, 2, 3, 13, 21]

NAMES = [
    "Ana",
    "Bruno",
    "Chen",
    "Dana",
    "Emeka",
    "Farah",
    "Gita",
    "Hugo",
    "Ines",
    "Jonas",
    "Kai",
    "Lena",
]

# World times (ms) of the `change` pairs: the old fact from 2020, the new one from 2024.
OLD_FROM = 1_577_836_800_000
NEW_FROM = 1_704_067_200_000


@dataclass(frozen=True)
class Pair:
    a: str
    b: str
    label: Label
    # Validity start (ms) of a and b; 0 when unknown.
    a_from: int = 0
    b_from: int = 0


def pairs(per_label: int = 100, changes: int = 20) -> list[Pair]:
    """`per_label` pairs of each of contradict, entail and neutral, plus `changes` change pairs."""
    out: list[Pair] = []
    k = len(ATTRIBUTES)
    for i in range(per_label):
        attr = ATTRIBUTES[i % k]
        name = NAMES[(5 * i + i // k) % len(NAMES)]
        fact, contra, para = (t.format(n=name) for t in attr)
        out.append(Pair(fact, contra, "contradict"))
        out.append(Pair(fact, para, "entail"))
        # Another attribute of the same person, a few steps away so pairs vary.
        other = ATTRIBUTES[(i + 1 + i // k) % k][0].format(n=name)
        out.append(Pair(fact, other, "neutral"))
    for i in range(changes):
        attr = ATTRIBUTES[CHANGEABLE[i % len(CHANGEABLE)]]
        name = NAMES[(7 * i + 3) % len(NAMES)]
        out.append(
            Pair(
                attr[0].format(n=name),
                attr[1].format(n=name),
                "change",
                OLD_FROM,
                NEW_FROM,
            )
        )
    return out
