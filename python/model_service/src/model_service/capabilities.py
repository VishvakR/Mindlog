"""What each model backend offers: plain classes that the server batches and guards."""

from dataclasses import dataclass, field
from typing import Protocol

import numpy as np
import numpy.typing as npt


@dataclass(frozen=True)
class Span:
    start: int
    end: int
    text: str
    label: str
    score: float


@dataclass(frozen=True)
class Relation:
    subject: str
    relation: str
    object: str


@dataclass(frozen=True)
class Fact:
    text: str
    kind: str
    relations: list[Relation] = field(default_factory=list)


class Embedder(Protocol):
    model_id: str

    def embed(self, texts: list[str], kind: str) -> npt.NDArray[np.float32]:
        """L2-normalised vectors, one row per text."""
        ...


class CrossEncoder(Protocol):
    model_id: str

    def score(self, pairs: list[tuple[str, str]]) -> npt.NDArray[np.float32]:
        """Raw logits, one row per pair."""
        ...

    @property
    def labels(self) -> list[str]:
        """Names of the logit columns (from the model config), or ['score']."""
        ...


class EntityRecognizer(Protocol):
    model_id: str

    def recognize(self, text: str, labels: list[str], threshold: float) -> list[Span]: ...


class Extractor(Protocol):
    model_id: str

    def extract(self, text: str) -> list[Fact]: ...
