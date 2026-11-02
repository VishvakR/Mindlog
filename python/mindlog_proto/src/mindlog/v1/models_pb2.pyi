from google.protobuf.internal import containers as _containers
from google.protobuf.internal import enum_type_wrapper as _enum_type_wrapper
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class EmbedKind(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    EMBED_KIND_UNSPECIFIED: _ClassVar[EmbedKind]
    EMBED_KIND_QUERY: _ClassVar[EmbedKind]
    EMBED_KIND_PASSAGE: _ClassVar[EmbedKind]

class NliLabel(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    NLI_LABEL_UNSPECIFIED: _ClassVar[NliLabel]
    NLI_LABEL_ENTAILMENT: _ClassVar[NliLabel]
    NLI_LABEL_NEUTRAL: _ClassVar[NliLabel]
    NLI_LABEL_CONTRADICTION: _ClassVar[NliLabel]
EMBED_KIND_UNSPECIFIED: EmbedKind
EMBED_KIND_QUERY: EmbedKind
EMBED_KIND_PASSAGE: EmbedKind
NLI_LABEL_UNSPECIFIED: NliLabel
NLI_LABEL_ENTAILMENT: NliLabel
NLI_LABEL_NEUTRAL: NliLabel
NLI_LABEL_CONTRADICTION: NliLabel

class EmbedRequest(_message.Message):
    __slots__ = ("texts", "kind")
    TEXTS_FIELD_NUMBER: _ClassVar[int]
    KIND_FIELD_NUMBER: _ClassVar[int]
    texts: _containers.RepeatedScalarFieldContainer[str]
    kind: EmbedKind
    def __init__(self, texts: _Optional[_Iterable[str]] = ..., kind: _Optional[_Union[EmbedKind, str]] = ...) -> None: ...

class EmbedResponse(_message.Message):
    __slots__ = ("vectors", "dims", "model_id")
    VECTORS_FIELD_NUMBER: _ClassVar[int]
    DIMS_FIELD_NUMBER: _ClassVar[int]
    MODEL_ID_FIELD_NUMBER: _ClassVar[int]
    vectors: _containers.RepeatedScalarFieldContainer[bytes]
    dims: int
    model_id: str
    def __init__(self, vectors: _Optional[_Iterable[bytes]] = ..., dims: _Optional[int] = ..., model_id: _Optional[str] = ...) -> None: ...

class RecognizeEntitiesRequest(_message.Message):
    __slots__ = ("texts", "labels", "threshold")
    TEXTS_FIELD_NUMBER: _ClassVar[int]
    LABELS_FIELD_NUMBER: _ClassVar[int]
    THRESHOLD_FIELD_NUMBER: _ClassVar[int]
    texts: _containers.RepeatedScalarFieldContainer[str]
    labels: _containers.RepeatedScalarFieldContainer[str]
    threshold: float
    def __init__(self, texts: _Optional[_Iterable[str]] = ..., labels: _Optional[_Iterable[str]] = ..., threshold: _Optional[float] = ...) -> None: ...

class EntitySpan(_message.Message):
    __slots__ = ("start", "end", "text", "label", "score")
    START_FIELD_NUMBER: _ClassVar[int]
    END_FIELD_NUMBER: _ClassVar[int]
    TEXT_FIELD_NUMBER: _ClassVar[int]
    LABEL_FIELD_NUMBER: _ClassVar[int]
    SCORE_FIELD_NUMBER: _ClassVar[int]
    start: int
    end: int
    text: str
    label: str
    score: float
    def __init__(self, start: _Optional[int] = ..., end: _Optional[int] = ..., text: _Optional[str] = ..., label: _Optional[str] = ..., score: _Optional[float] = ...) -> None: ...

class EntitySpans(_message.Message):
    __slots__ = ("spans",)
    SPANS_FIELD_NUMBER: _ClassVar[int]
    spans: _containers.RepeatedCompositeFieldContainer[EntitySpan]
    def __init__(self, spans: _Optional[_Iterable[_Union[EntitySpan, _Mapping]]] = ...) -> None: ...

class RecognizeEntitiesResponse(_message.Message):
    __slots__ = ("results", "model_id")
    RESULTS_FIELD_NUMBER: _ClassVar[int]
    MODEL_ID_FIELD_NUMBER: _ClassVar[int]
    results: _containers.RepeatedCompositeFieldContainer[EntitySpans]
    model_id: str
    def __init__(self, results: _Optional[_Iterable[_Union[EntitySpans, _Mapping]]] = ..., model_id: _Optional[str] = ...) -> None: ...

class NliPair(_message.Message):
    __slots__ = ("premise", "hypothesis")
    PREMISE_FIELD_NUMBER: _ClassVar[int]
    HYPOTHESIS_FIELD_NUMBER: _ClassVar[int]
    premise: str
    hypothesis: str
    def __init__(self, premise: _Optional[str] = ..., hypothesis: _Optional[str] = ...) -> None: ...

class NliResult(_message.Message):
    __slots__ = ("label", "score")
    LABEL_FIELD_NUMBER: _ClassVar[int]
    SCORE_FIELD_NUMBER: _ClassVar[int]
    label: NliLabel
    score: float
    def __init__(self, label: _Optional[_Union[NliLabel, str]] = ..., score: _Optional[float] = ...) -> None: ...

class ClassifyNliRequest(_message.Message):
    __slots__ = ("pairs",)
    PAIRS_FIELD_NUMBER: _ClassVar[int]
    pairs: _containers.RepeatedCompositeFieldContainer[NliPair]
    def __init__(self, pairs: _Optional[_Iterable[_Union[NliPair, _Mapping]]] = ...) -> None: ...

class ClassifyNliResponse(_message.Message):
    __slots__ = ("results", "model_id")
    RESULTS_FIELD_NUMBER: _ClassVar[int]
    MODEL_ID_FIELD_NUMBER: _ClassVar[int]
    results: _containers.RepeatedCompositeFieldContainer[NliResult]
    model_id: str
    def __init__(self, results: _Optional[_Iterable[_Union[NliResult, _Mapping]]] = ..., model_id: _Optional[str] = ...) -> None: ...

class RerankRequest(_message.Message):
    __slots__ = ("query", "documents")
    QUERY_FIELD_NUMBER: _ClassVar[int]
    DOCUMENTS_FIELD_NUMBER: _ClassVar[int]
    query: str
    documents: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, query: _Optional[str] = ..., documents: _Optional[_Iterable[str]] = ...) -> None: ...

class RerankResponse(_message.Message):
    __slots__ = ("scores", "model_id")
    SCORES_FIELD_NUMBER: _ClassVar[int]
    MODEL_ID_FIELD_NUMBER: _ClassVar[int]
    scores: _containers.RepeatedScalarFieldContainer[float]
    model_id: str
    def __init__(self, scores: _Optional[_Iterable[float]] = ..., model_id: _Optional[str] = ...) -> None: ...

class ExtractFactsRequest(_message.Message):
    __slots__ = ("text",)
    TEXT_FIELD_NUMBER: _ClassVar[int]
    text: str
    def __init__(self, text: _Optional[str] = ...) -> None: ...

class FactRelation(_message.Message):
    __slots__ = ("subject", "relation", "object")
    SUBJECT_FIELD_NUMBER: _ClassVar[int]
    RELATION_FIELD_NUMBER: _ClassVar[int]
    OBJECT_FIELD_NUMBER: _ClassVar[int]
    subject: str
    relation: str
    object: str
    def __init__(self, subject: _Optional[str] = ..., relation: _Optional[str] = ..., object: _Optional[str] = ...) -> None: ...

class ExtractedFact(_message.Message):
    __slots__ = ("text", "kind", "relations")
    TEXT_FIELD_NUMBER: _ClassVar[int]
    KIND_FIELD_NUMBER: _ClassVar[int]
    RELATIONS_FIELD_NUMBER: _ClassVar[int]
    text: str
    kind: str
    relations: _containers.RepeatedCompositeFieldContainer[FactRelation]
    def __init__(self, text: _Optional[str] = ..., kind: _Optional[str] = ..., relations: _Optional[_Iterable[_Union[FactRelation, _Mapping]]] = ...) -> None: ...

class ExtractFactsResponse(_message.Message):
    __slots__ = ("facts", "model_id")
    FACTS_FIELD_NUMBER: _ClassVar[int]
    MODEL_ID_FIELD_NUMBER: _ClassVar[int]
    facts: _containers.RepeatedCompositeFieldContainer[ExtractedFact]
    model_id: str
    def __init__(self, facts: _Optional[_Iterable[_Union[ExtractedFact, _Mapping]]] = ..., model_id: _Optional[str] = ...) -> None: ...

class SummarizeRequest(_message.Message):
    __slots__ = ("texts", "instruction", "max_chars")
    TEXTS_FIELD_NUMBER: _ClassVar[int]
    INSTRUCTION_FIELD_NUMBER: _ClassVar[int]
    MAX_CHARS_FIELD_NUMBER: _ClassVar[int]
    texts: _containers.RepeatedScalarFieldContainer[str]
    instruction: str
    max_chars: int
    def __init__(self, texts: _Optional[_Iterable[str]] = ..., instruction: _Optional[str] = ..., max_chars: _Optional[int] = ...) -> None: ...

class SummarizeResponse(_message.Message):
    __slots__ = ("summary", "model_id")
    SUMMARY_FIELD_NUMBER: _ClassVar[int]
    MODEL_ID_FIELD_NUMBER: _ClassVar[int]
    summary: str
    model_id: str
    def __init__(self, summary: _Optional[str] = ..., model_id: _Optional[str] = ...) -> None: ...

class HealthRequest(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class ModelStatus(_message.Message):
    __slots__ = ("capability", "model_id", "ready", "queue_depth")
    CAPABILITY_FIELD_NUMBER: _ClassVar[int]
    MODEL_ID_FIELD_NUMBER: _ClassVar[int]
    READY_FIELD_NUMBER: _ClassVar[int]
    QUEUE_DEPTH_FIELD_NUMBER: _ClassVar[int]
    capability: str
    model_id: str
    ready: bool
    queue_depth: int
    def __init__(self, capability: _Optional[str] = ..., model_id: _Optional[str] = ..., ready: _Optional[bool] = ..., queue_depth: _Optional[int] = ...) -> None: ...

class HealthResponse(_message.Message):
    __slots__ = ("ready", "models")
    READY_FIELD_NUMBER: _ClassVar[int]
    MODELS_FIELD_NUMBER: _ClassVar[int]
    ready: bool
    models: _containers.RepeatedCompositeFieldContainer[ModelStatus]
    def __init__(self, ready: _Optional[bool] = ..., models: _Optional[_Iterable[_Union[ModelStatus, _Mapping]]] = ...) -> None: ...
