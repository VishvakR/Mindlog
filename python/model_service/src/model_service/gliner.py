"""GLiNER zero-shot NER on ONNX Runtime without the torch-based library (references: gliner.md).

The pre- and post-processing follow the `markerV0` span mode of gliner_small-v2.1:
a prompt of `<<ENT>> label` pairs and `<<SEP>>` before the text words, a word mask
marking each text word's first subtoken, every span up to `max_width` words, and
flat (non-overlapping) greedy decoding of sigmoid scores.
"""

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

import numpy as np
import numpy.typing as npt

from model_service.capabilities import Span

WORD = re.compile(r"\w+(?:[-_]\w+)*|\S")
ENT_TOKEN = "<<ENT>>"
SEP_TOKEN = "<<SEP>>"


@dataclass(frozen=True)
class Word:
    text: str
    start: int
    end: int


class Encoding(Protocol):
    @property
    def ids(self) -> list[int]: ...
    @property
    def word_ids(self) -> list[int | None]: ...


class WordTokenizer(Protocol):
    def encode(
        self,
        sequence: Any,
        pair: Any = ...,
        is_pretokenized: bool = ...,
        add_special_tokens: bool = ...,
    ) -> Encoding: ...


def split_words(text: str) -> list[Word]:
    return [Word(m.group(), m.start(), m.end()) for m in WORD.finditer(text)]


def build_inputs(
    tokenizer: WordTokenizer, words: list[Word], labels: list[str], max_width: int
) -> dict[str, npt.NDArray[np.generic]]:
    """The model's inputs for one text (batch of 1)."""
    prompt: list[str] = []
    for label in labels:
        prompt += [ENT_TOKEN, label]
    prompt.append(SEP_TOKEN)
    encoding = tokenizer.encode(prompt + [w.text for w in words], is_pretokenized=True)
    words_mask: list[int] = []
    seen: set[int] = set()
    for w in encoding.word_ids:
        if w is None or w < len(prompt) or w in seen:
            words_mask.append(0)
        else:
            seen.add(w)
            words_mask.append(w - len(prompt) + 1)
    n = len(words)
    spans = [(i, i + w) for i in range(n) for w in range(max_width)]
    return {
        "input_ids": np.array([encoding.ids], dtype=np.int64),
        "attention_mask": np.ones((1, len(encoding.ids)), dtype=np.int64),
        "words_mask": np.array([words_mask], dtype=np.int64),
        "text_lengths": np.array([[n]], dtype=np.int64),
        "span_idx": np.array([spans], dtype=np.int64).reshape(1, len(spans), 2),
        "span_mask": np.array([[end < n for _, end in spans]], dtype=np.bool_),
    }


def decode_spans(
    logits: npt.NDArray[np.float32],
    words: list[Word],
    text: str,
    labels: list[str],
    threshold: float,
) -> list[Span]:
    """Spans above `threshold`, best first, minus any overlapping a kept one; sorted by start."""
    probs = 1 / (1 + np.exp(-logits[: len(words)]))
    found = np.argwhere(probs > threshold)
    candidates = sorted(
        (
            (float(probs[i, w, c]), int(i), int(i + w), int(c))
            for i, w, c in found
            if i + w < len(words)
        ),
        reverse=True,
    )
    kept: list[tuple[float, int, int, int]] = []
    for score, start, end, label in candidates:
        if all(end < s or start > e for _, s, e, _ in kept):
            kept.append((score, start, end, label))
    kept.sort(key=lambda k: k[1])
    return [
        Span(
            start=words[s].start,
            end=words[e].end,
            text=text[words[s].start : words[e].end],
            label=labels[c],
            score=score,
        )
        for score, s, e, c in kept
    ]


class GlinerOnnx:
    """Zero-shot NER over an exported GLiNER graph and its tokenizer and config files."""

    def __init__(self, directory: Path, model_id: str) -> None:
        import onnxruntime as ort
        from tokenizers import Tokenizer

        config = json.loads((directory / "gliner_config.json").read_text())
        self.model_id = model_id
        self._max_width = int(config["max_width"])
        self._max_len = int(config["max_len"])
        self._tokenizer = Tokenizer.from_file(str(directory / "tokenizer.json"))
        self._session = ort.InferenceSession(str(directory / "model.onnx"))
        self._inputs = {i.name for i in self._session.get_inputs()}

    def recognize(self, text: str, labels: list[str], threshold: float) -> list[Span]:
        words = split_words(text)[: self._max_len]
        if not words or not labels:
            return []
        inputs = build_inputs(self._tokenizer, words, labels, self._max_width)
        (logits,) = self._session.run(None, {k: v for k, v in inputs.items() if k in self._inputs})[
            :1
        ]
        return decode_spans(np.asarray(logits)[0], words, text, labels, threshold)
