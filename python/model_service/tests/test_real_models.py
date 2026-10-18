"""Real ONNX models, once downloaded (scripts/download_models.py); pytest -m integration."""

import numpy as np
import pytest
from model_service.config import load_backends, settings_from_env
from model_service.server import Backends

pytestmark = pytest.mark.integration


@pytest.fixture(scope="module")
def backends() -> Backends:
    loaded = load_backends(settings_from_env())
    if (
        loaded.embedder is None
        or loaded.ner is None
        or loaded.nli is None
        or loaded.reranker is None
    ):
        pytest.skip("models not downloaded")
    return loaded


def test_embeddings_are_normalised_and_semantic(backends: Backends) -> None:
    assert backends.embedder is not None
    v = backends.embedder.embed(
        ["I prefer dark roast coffee", "My favourite coffee is a dark roast", "The train was late"],
        "passage",
    )
    assert v.shape == (3, 384)
    assert np.allclose(np.linalg.norm(v, axis=1), 1, atol=1e-4)
    assert float(v[0] @ v[1]) > float(v[0] @ v[2]) + 0.2


def test_gliner_finds_people_and_organizations(backends: Backends) -> None:
    assert backends.ner is not None
    spans = backends.ner.recognize(
        "Ana Silva joined Acme Corp in Lisbon.", ["person", "organization", "place"], 0.5
    )
    found = {(s.text, s.label) for s in spans}
    assert ("Ana Silva", "person") in found
    assert ("Acme Corp", "organization") in found


def test_nli_and_rerank(backends: Backends) -> None:
    assert backends.nli is not None and backends.reranker is not None
    labels = backends.nli.labels
    logits = backends.nli.score(
        [
            ("I live in Lisbon.", "I do not live in Lisbon."),
            ("I live in Lisbon.", "I live in Portugal."),
        ]
    )
    assert labels[int(logits[0].argmax())] == "contradiction"
    assert labels[int(logits[1].argmax())] == "entailment"
    scores = backends.reranker.score(
        [
            ("what coffee do I like", "I prefer dark roast coffee"),
            ("what coffee do I like", "The train was late"),
        ]
    )
    assert scores[0, 0] > scores[1, 0]
