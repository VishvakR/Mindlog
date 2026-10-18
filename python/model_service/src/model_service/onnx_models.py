"""Transformer encoders on ONNX Runtime with `tokenizers` (no torch; ADR-0020)."""

import json
from pathlib import Path

import numpy as np
import numpy.typing as npt


def _session_and_tokenizer(directory: Path, max_length: int) -> tuple[object, object, set[str]]:
    import onnxruntime as ort
    from tokenizers import Tokenizer

    tokenizer = Tokenizer.from_file(str(directory / "tokenizer.json"))
    tokenizer.enable_truncation(max_length)
    pad = tokenizer.token_to_id("[PAD]")
    tokenizer.enable_padding(pad_id=pad if pad is not None else 0, pad_token="[PAD]")
    options = ort.SessionOptions()
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    session = ort.InferenceSession(str(directory / "model.onnx"), sess_options=options)
    return session, tokenizer, {i.name for i in session.get_inputs()}


def _feed(encodings: list[object], names: set[str]) -> dict[str, npt.NDArray[np.int64]]:
    feed = {
        "input_ids": np.array([e.ids for e in encodings], dtype=np.int64),  # type: ignore[attr-defined]
        "attention_mask": np.array([e.attention_mask for e in encodings], dtype=np.int64),  # type: ignore[attr-defined]
        "token_type_ids": np.array([e.type_ids for e in encodings], dtype=np.int64),  # type: ignore[attr-defined]
    }
    return {k: v for k, v in feed.items() if k in names}


class OnnxEmbedder:
    """Sentence embeddings: mean pooling over the last hidden state, then L2 normalisation."""

    def __init__(self, directory: Path, model_id: str, max_length: int = 256) -> None:
        self.model_id = model_id
        self._session, self._tokenizer, self._names = _session_and_tokenizer(directory, max_length)

    def embed(self, texts: list[str], kind: str) -> npt.NDArray[np.float32]:
        # MiniLM uses no query/passage prefixes; `kind` matters for models that do.
        encodings = self._tokenizer.encode_batch(texts)  # type: ignore[attr-defined]
        feed = _feed(encodings, self._names)
        hidden = np.asarray(self._session.run(None, feed)[0], dtype=np.float32)  # type: ignore[attr-defined]
        mask = feed["attention_mask"][..., None].astype(np.float32)
        pooled = (hidden * mask).sum(axis=1) / np.maximum(mask.sum(axis=1), 1e-9)
        norms = np.linalg.norm(pooled, axis=1, keepdims=True)
        return np.asarray(pooled / np.maximum(norms, 1e-12), dtype=np.float32)


class OnnxCrossEncoder:
    """Scores (a, b) pairs: one logit for rerankers, one per NLI class (named in config.json)."""

    def __init__(self, directory: Path, model_id: str, max_length: int = 512) -> None:
        self.model_id = model_id
        self._session, self._tokenizer, self._names = _session_and_tokenizer(directory, max_length)
        config = json.loads((directory / "config.json").read_text())
        id2label: dict[str, str] = config.get("id2label") or {}
        self._labels = (
            [id2label[k].lower() for k in sorted(id2label, key=int)]
            if len(id2label) > 1
            else ["score"]
        )

    @property
    def labels(self) -> list[str]:
        return self._labels

    def score(self, pairs: list[tuple[str, str]]) -> npt.NDArray[np.float32]:
        encodings = self._tokenizer.encode_batch(pairs)  # type: ignore[attr-defined]
        logits = self._session.run(None, _feed(encodings, self._names))[0]  # type: ignore[attr-defined]
        return np.asarray(logits, dtype=np.float32).reshape(len(pairs), -1)
