import asyncio
import threading
from collections.abc import Awaitable, Callable
from typing import ClassVar

import grpc
import numpy as np
import numpy.typing as npt
import pytest
from mindlog.v1 import models_pb2, models_pb2_grpc
from model_service.capabilities import Fact, Span
from model_service.server import Backends, Limits, serve
from model_service.summarize import ExtractiveSummarizer


class FakeEmbedder:
    model_id = "fake-embed@1"

    def __init__(self, gate: threading.Event | None = None) -> None:
        self.gate = gate

    def embed(self, texts: list[str], kind: str) -> npt.NDArray[np.float32]:
        if self.gate is not None and texts != ["warm up"]:
            self.gate.wait(5)
        out = np.zeros((len(texts), 4), dtype=np.float32)
        for i, t in enumerate(texts):
            out[i, len(t) % 4] = 1.0
        return out


class FakeCrossEncoder:
    model_id = "fake-nli@1"
    labels: ClassVar[list[str]] = ["contradiction", "entailment", "neutral"]

    def score(self, pairs: list[tuple[str, str]]) -> npt.NDArray[np.float32]:
        rows = [[5.0, 0.0, 0.0] if "not" in h else [0.0, 5.0, 0.0] for _, h in pairs]
        return np.array(rows, dtype=np.float32)


class FakeReranker:
    model_id = "fake-rerank@1"
    labels: ClassVar[list[str]] = ["score"]

    def score(self, pairs: list[tuple[str, str]]) -> npt.NDArray[np.float32]:
        return np.array(
            [[float(len(set(q.split()) & set(d.split())))] for q, d in pairs], np.float32
        )


class FakeNer:
    model_id = "fake-ner@1"

    def recognize(self, text: str, labels: list[str], threshold: float) -> list[Span]:
        i = text.find("Ana")
        return [] if i < 0 else [Span(i, i + 3, "Ana", labels[0], 0.9)]


class FakeExtractor:
    model_id = "fake-extract@1"

    def extract(self, text: str) -> list[Fact]:
        return [Fact(text=text.strip(), kind="semantic")]


Call = Callable[[models_pb2_grpc.ModelsServiceStub], Awaitable[None]]


def run(backends: Backends, call: Call, limits: Limits | None = None) -> None:
    async def go() -> None:
        server, port = await serve(backends, "127.0.0.1", 0, limits or Limits())
        try:
            async with grpc.aio.insecure_channel(f"127.0.0.1:{port}") as channel:
                await call(models_pb2_grpc.ModelsServiceStub(channel))
        finally:
            await server.stop(None)

    asyncio.run(go())


def full() -> Backends:
    return Backends(
        embedder=FakeEmbedder(),
        nli=FakeCrossEncoder(),
        reranker=FakeReranker(),
        ner=FakeNer(),
        extractor=FakeExtractor(),
        summarizer=ExtractiveSummarizer(FakeEmbedder()),
    )


def test_embed_returns_float32_vectors_and_the_model_id() -> None:
    async def call(stub: models_pb2_grpc.ModelsServiceStub) -> None:
        reply = await stub.Embed(
            models_pb2.EmbedRequest(texts=["a", "bb"], kind=models_pb2.EMBED_KIND_QUERY)
        )
        assert reply.model_id == "fake-embed@1"
        assert reply.dims == 4
        vectors = [np.frombuffer(v, dtype="<f4").tolist() for v in reply.vectors]
        assert vectors == [[0, 1, 0, 0], [0, 0, 1, 0]]

    run(full(), call)


def test_nli_rerank_ner_and_extract() -> None:
    async def call(stub: models_pb2_grpc.ModelsServiceStub) -> None:
        nli = await stub.ClassifyNli(
            models_pb2.ClassifyNliRequest(
                pairs=[
                    models_pb2.NliPair(premise="x", hypothesis="it is not"),
                    models_pb2.NliPair(premise="x", hypothesis="it is"),
                ]
            )
        )
        assert [r.label for r in nli.results] == [
            models_pb2.NLI_LABEL_CONTRADICTION,
            models_pb2.NLI_LABEL_ENTAILMENT,
        ]
        assert nli.results[0].score > 0.9
        rerank = await stub.Rerank(
            models_pb2.RerankRequest(query="dark roast", documents=["roast", "tea", "dark roast"])
        )
        assert list(rerank.scores) == [1.0, 0.0, 2.0]
        ner = await stub.RecognizeEntities(
            models_pb2.RecognizeEntitiesRequest(texts=["My sister Ana", "none"], labels=["person"])
        )
        assert [[s.text for s in r.spans] for r in ner.results] == [["Ana"], []]
        facts = await stub.ExtractFacts(models_pb2.ExtractFactsRequest(text=" I like tea. "))
        assert [f.text for f in facts.facts] == ["I like tea."]

    run(full(), call)


def test_health_reports_each_capability() -> None:
    async def call(stub: models_pb2_grpc.ModelsServiceStub) -> None:
        health = await stub.Health(models_pb2.HealthRequest())
        assert health.ready
        assert {m.capability: m.model_id for m in health.models} == {
            "embed": "fake-embed@1",
            "ner": "fake-ner@1",
            "nli": "fake-nli@1",
            "rerank": "fake-rerank@1",
            "extract": "fake-extract@1",
            "summarize": "extractive-centroid@1+fake-embed@1",
        }

    run(full(), call)


def test_summarize_keeps_sentences_within_the_limit() -> None:
    async def call(stub: models_pb2_grpc.ModelsServiceStub) -> None:
        reply = await stub.Summarize(
            models_pb2.SummarizeRequest(
                texts=["Ana moved to Lisbon. She likes it.", "Ana works at Acme."],
                instruction="Summarize.",
                max_chars=60,
            )
        )
        assert reply.model_id == "extractive-centroid@1+fake-embed@1"
        assert 0 < len(reply.summary) <= 60

    run(full(), call)


def test_a_missing_model_is_unavailable() -> None:
    async def call(stub: models_pb2_grpc.ModelsServiceStub) -> None:
        for request in (
            stub.ClassifyNli(models_pb2.ClassifyNliRequest()),
            stub.Summarize(models_pb2.SummarizeRequest()),
        ):
            with pytest.raises(grpc.aio.AioRpcError) as missing:
                await request
            assert missing.value.code() == grpc.StatusCode.UNAVAILABLE
        health = await stub.Health(models_pb2.HealthRequest())
        assert [m.capability for m in health.models if not m.ready] == [
            "ner",
            "nli",
            "rerank",
            "extract",
            "summarize",
        ]

    run(Backends(embedder=FakeEmbedder()), call)


def test_a_full_queue_answers_resource_exhausted() -> None:
    gate = threading.Event()

    async def call(stub: models_pb2_grpc.ModelsServiceStub) -> None:
        busy = asyncio.ensure_future(stub.Embed(models_pb2.EmbedRequest(texts=["a"])))
        await asyncio.sleep(0.1)
        with pytest.raises(grpc.aio.AioRpcError) as full_queue:
            await stub.Embed(models_pb2.EmbedRequest(texts=["b"]))
        assert full_queue.value.code() == grpc.StatusCode.RESOURCE_EXHAUSTED
        gate.set()
        assert len((await busy).vectors) == 1

    run(Backends(embedder=FakeEmbedder(gate)), call, Limits(max_queue=1))
