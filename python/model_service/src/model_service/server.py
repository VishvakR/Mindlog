"""The `ModelsService` gRPC server (PLAN 14.3-14.4): batching, admission control, health."""

import asyncio
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast

import grpc
import numpy as np
import numpy.typing as npt
from mindlog.v1 import models_pb2, models_pb2_grpc

from model_service.batcher import MicroBatcher, Overloaded
from model_service.capabilities import (
    CrossEncoder,
    Embedder,
    EntityRecognizer,
    Extractor,
    Fact,
    Span,
    Summarizer,
)

DEFAULT_NER_THRESHOLD = 0.5
KINDS = {models_pb2.EMBED_KIND_QUERY: "query", models_pb2.EMBED_KIND_PASSAGE: "passage"}
NLI_LABELS = {
    "entailment": models_pb2.NLI_LABEL_ENTAILMENT,
    "neutral": models_pb2.NLI_LABEL_NEUTRAL,
    "contradiction": models_pb2.NLI_LABEL_CONTRADICTION,
}


@dataclass(frozen=True)
class Backends:
    """The loaded models; a capability without a model answers UNAVAILABLE (the server degrades)."""

    embedder: Embedder | None = None
    ner: EntityRecognizer | None = None
    nli: CrossEncoder | None = None
    reranker: CrossEncoder | None = None
    extractor: Extractor | None = None
    summarizer: Summarizer | None = None


@dataclass(frozen=True)
class Limits:
    max_batch: int = 32
    max_wait_ms: float = 5.0
    max_queue: int = 256


def _softmax(x: npt.NDArray[np.float32]) -> npt.NDArray[np.float32]:
    e = np.exp(x - x.max(axis=1, keepdims=True))
    return np.asarray(e / e.sum(axis=1, keepdims=True), dtype=np.float32)


class ModelsServicer(models_pb2_grpc.ModelsServiceServicer):  # type: ignore[misc]
    def __init__(self, backends: Backends, limits: Limits) -> None:
        self._b = backends
        common: dict[str, Any] = {
            "max_batch": limits.max_batch,
            "max_wait_ms": limits.max_wait_ms,
            "max_queue": limits.max_queue,
        }
        self._embed = self._batcher(backends.embedder, self._run_embed, common)
        self._ner = self._batcher(backends.ner, self._run_ner, common)
        self._nli = self._batcher(backends.nli, self._run_cross(backends.nli), common)
        self._rerank = self._batcher(backends.reranker, self._run_cross(backends.reranker), common)
        # Generation is slow; its own thread keeps it from blocking the other models.
        self._extract = self._batcher(
            backends.extractor,
            self._run_extract,
            {**common, "max_batch": 1, "max_wait_ms": 0, "executor": ThreadPoolExecutor(1)},
        )
        self._summarize = self._batcher(
            backends.summarizer,
            self._run_summarize,
            {**common, "max_batch": 1, "max_wait_ms": 0, "executor": ThreadPoolExecutor(1)},
        )

    @staticmethod
    def _batcher[T, R](
        backend: object | None, run: Callable[[list[T]], list[R]], options: dict[str, Any]
    ) -> MicroBatcher[T, R] | None:
        return None if backend is None else MicroBatcher(run, **options)

    def _run_embed(self, items: list[tuple[str, str]]) -> list[bytes]:
        assert self._b.embedder is not None
        kind = items[0][0]
        vectors = self._b.embedder.embed([t for _, t in items], kind)
        return [row.astype("<f4").tobytes() for row in vectors]

    def _run_ner(self, items: list[tuple[str, tuple[str, ...], float]]) -> list[list[Span]]:
        assert self._b.ner is not None
        return [self._b.ner.recognize(t, list(labels), th) for t, labels, th in items]

    @staticmethod
    def _run_cross(
        model: CrossEncoder | None,
    ) -> Callable[[list[tuple[str, str]]], list[npt.NDArray[np.float32]]]:
        def run(pairs: list[tuple[str, str]]) -> list[npt.NDArray[np.float32]]:
            assert model is not None
            return list(model.score(pairs))

        return run

    def _run_extract(self, texts: list[str]) -> list[list[Fact]]:
        assert self._b.extractor is not None
        return [self._b.extractor.extract(t) for t in texts]

    def _run_summarize(self, items: list[tuple[tuple[str, ...], str, int]]) -> list[str]:
        assert self._b.summarizer is not None
        return [self._b.summarizer.summarize(list(t), i, n) for t, i, n in items]

    async def _submit[T, R](
        self,
        batcher: MicroBatcher[T, R] | None,
        items: list[T],
        context: grpc.aio.ServicerContext[Any, Any],
    ) -> list[R]:
        if batcher is None:
            await context.abort(grpc.StatusCode.UNAVAILABLE, "model not loaded")
            raise AssertionError("unreachable")
        try:
            return await batcher.submit(items)
        except Overloaded as error:
            await context.abort(grpc.StatusCode.RESOURCE_EXHAUSTED, str(error))
            raise AssertionError("unreachable") from error

    async def Embed(
        self, request: models_pb2.EmbedRequest, context: grpc.aio.ServicerContext[Any, Any]
    ) -> models_pb2.EmbedResponse:
        kind = KINDS.get(request.kind, "passage")
        if not request.texts:
            return models_pb2.EmbedResponse(model_id=self._id(self._b.embedder))
        vectors = await self._submit(self._embed, [(kind, t) for t in request.texts], context)
        return models_pb2.EmbedResponse(
            vectors=vectors, dims=len(vectors[0]) // 4, model_id=self._id(self._b.embedder)
        )

    async def RecognizeEntities(
        self,
        request: models_pb2.RecognizeEntitiesRequest,
        context: grpc.aio.ServicerContext[Any, Any],
    ) -> models_pb2.RecognizeEntitiesResponse:
        threshold = request.threshold or DEFAULT_NER_THRESHOLD
        labels = tuple(request.labels)
        found = await self._submit(
            self._ner, [(t, labels, threshold) for t in request.texts], context
        )
        return models_pb2.RecognizeEntitiesResponse(
            results=[
                models_pb2.EntitySpans(
                    spans=[
                        models_pb2.EntitySpan(
                            start=s.start, end=s.end, text=s.text, label=s.label, score=s.score
                        )
                        for s in spans
                    ]
                )
                for spans in found
            ],
            model_id=self._id(self._b.ner),
        )

    async def ClassifyNli(
        self, request: models_pb2.ClassifyNliRequest, context: grpc.aio.ServicerContext[Any, Any]
    ) -> models_pb2.ClassifyNliResponse:
        pairs = [(p.premise, p.hypothesis) for p in request.pairs]
        logits = await self._submit(self._nli, pairs, context)
        assert self._b.nli is not None
        names = self._b.nli.labels
        results = []
        if logits:
            for row in _softmax(np.stack(logits)):
                best = int(row.argmax())
                label = NLI_LABELS.get(names[best], models_pb2.NLI_LABEL_UNSPECIFIED)
                results.append(models_pb2.NliResult(label=label, score=float(row[best])))
        return models_pb2.ClassifyNliResponse(results=results, model_id=self._id(self._b.nli))

    async def Rerank(
        self, request: models_pb2.RerankRequest, context: grpc.aio.ServicerContext[Any, Any]
    ) -> models_pb2.RerankResponse:
        pairs = [(request.query, d) for d in request.documents]
        logits = await self._submit(self._rerank, pairs, context)
        return models_pb2.RerankResponse(
            scores=[float(row[0]) for row in logits], model_id=self._id(self._b.reranker)
        )

    async def ExtractFacts(
        self, request: models_pb2.ExtractFactsRequest, context: grpc.aio.ServicerContext[Any, Any]
    ) -> models_pb2.ExtractFactsResponse:
        (facts,) = await self._submit(self._extract, [request.text], context)
        return models_pb2.ExtractFactsResponse(
            facts=[
                models_pb2.ExtractedFact(
                    text=f.text,
                    kind=f.kind,
                    relations=[
                        models_pb2.FactRelation(
                            subject=r.subject, relation=r.relation, object=r.object
                        )
                        for r in f.relations
                    ],
                )
                for f in facts
            ],
            model_id=self._id(self._b.extractor),
        )

    async def Summarize(
        self, request: models_pb2.SummarizeRequest, context: grpc.aio.ServicerContext[Any, Any]
    ) -> models_pb2.SummarizeResponse:
        item = (tuple(request.texts), request.instruction, request.max_chars)
        (summary,) = await self._submit(self._summarize, [item], context)
        return models_pb2.SummarizeResponse(summary=summary, model_id=self._id(self._b.summarizer))

    async def Health(
        self, request: models_pb2.HealthRequest, context: grpc.aio.ServicerContext[Any, Any]
    ) -> models_pb2.HealthResponse:
        entries: list[tuple[str, object | None, MicroBatcher[Any, Any] | None]] = [
            ("embed", self._b.embedder, self._embed),
            ("ner", self._b.ner, self._ner),
            ("nli", self._b.nli, self._nli),
            ("rerank", self._b.reranker, self._rerank),
            ("extract", self._b.extractor, self._extract),
            ("summarize", self._b.summarizer, self._summarize),
        ]
        return models_pb2.HealthResponse(
            ready=True,
            models=[
                models_pb2.ModelStatus(
                    capability=name,
                    model_id=self._id(backend),
                    ready=backend is not None,
                    queue_depth=batcher.depth if batcher else 0,
                )
                for name, backend, batcher in entries
            ],
        )

    @staticmethod
    def _id(backend: object | None) -> str:
        return str(getattr(backend, "model_id", ""))


def warm_up(backends: Backends) -> None:
    """One call per model so the first request does not pay for lazy initialisation."""
    if backends.embedder:
        backends.embedder.embed(["warm up"], "passage")
    if backends.reranker:
        backends.reranker.score([("warm", "up")])
    if backends.nli:
        backends.nli.score([("warm", "up")])
    if backends.ner:
        backends.ner.recognize("Warm up", ["person"], DEFAULT_NER_THRESHOLD)


def tls_credentials(ca: str, cert: str, key: str) -> grpc.ServerCredentials:
    """Mutual TLS that picks up rotated files on new connections (PLAN 18.4)."""

    def stamp() -> tuple[float, ...]:
        return tuple(Path(p).stat().st_mtime for p in (ca, cert, key))

    def load() -> grpc.ServerCertificateConfiguration:
        return grpc.ssl_server_certificate_configuration(
            [(Path(key).read_bytes(), Path(cert).read_bytes())],
            root_certificates=Path(ca).read_bytes(),
        )

    seen = stamp()

    def fetch() -> grpc.ServerCertificateConfiguration | None:
        nonlocal seen
        current = stamp()
        if current == seen:
            return None
        seen = current
        return load()

    # The stubs omit it, but grpc documents None as "keep the current certificates".
    fetcher = cast(Callable[[], grpc.ServerCertificateConfiguration], fetch)
    return grpc.dynamic_ssl_server_credentials(load(), fetcher, require_client_authentication=True)


async def serve(
    backends: Backends,
    host: str,
    port: int,
    limits: Limits,
    tls: tuple[str, str, str] | None = None,
) -> tuple[grpc.aio.Server, int]:
    """Warms the models up, then starts the server; returns it and the bound port."""
    await asyncio.get_running_loop().run_in_executor(None, warm_up, backends)
    server = grpc.aio.server()
    models_pb2_grpc.add_ModelsServiceServicer_to_server(ModelsServicer(backends, limits), server)
    address = f"{host}:{port}"
    bound = (
        server.add_secure_port(address, tls_credentials(*tls))
        if tls
        else server.add_insecure_port(address)
    )
    await server.start()
    return server, bound
