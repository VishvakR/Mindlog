from mindlog.v1 import jobs_pb2 as _jobs_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class MemoryLink(_message.Message):
    __slots__ = ("to", "relation", "weight")
    TO_FIELD_NUMBER: _ClassVar[int]
    RELATION_FIELD_NUMBER: _ClassVar[int]
    WEIGHT_FIELD_NUMBER: _ClassVar[int]
    to: str
    relation: str
    weight: float
    def __init__(self, to: _Optional[str] = ..., relation: _Optional[str] = ..., weight: _Optional[float] = ...) -> None: ...

class MemorySource(_message.Message):
    __slots__ = ("type", "ref", "principal")
    TYPE_FIELD_NUMBER: _ClassVar[int]
    REF_FIELD_NUMBER: _ClassVar[int]
    PRINCIPAL_FIELD_NUMBER: _ClassVar[int]
    type: str
    ref: str
    principal: str
    def __init__(self, type: _Optional[str] = ..., ref: _Optional[str] = ..., principal: _Optional[str] = ...) -> None: ...

class MemoryRecord(_message.Message):
    __slots__ = ("id", "user", "agent", "session", "kind", "text", "entities", "links", "source", "trust", "importance", "strength", "created_at", "expired_at", "tags", "version", "embedding_model", "log_index", "branch", "valid_from", "valid_to", "recall_count", "last_recalled_at", "meta_json", "forget_reason", "terms", "term_length")
    ID_FIELD_NUMBER: _ClassVar[int]
    USER_FIELD_NUMBER: _ClassVar[int]
    AGENT_FIELD_NUMBER: _ClassVar[int]
    SESSION_FIELD_NUMBER: _ClassVar[int]
    KIND_FIELD_NUMBER: _ClassVar[int]
    TEXT_FIELD_NUMBER: _ClassVar[int]
    ENTITIES_FIELD_NUMBER: _ClassVar[int]
    LINKS_FIELD_NUMBER: _ClassVar[int]
    SOURCE_FIELD_NUMBER: _ClassVar[int]
    TRUST_FIELD_NUMBER: _ClassVar[int]
    IMPORTANCE_FIELD_NUMBER: _ClassVar[int]
    STRENGTH_FIELD_NUMBER: _ClassVar[int]
    CREATED_AT_FIELD_NUMBER: _ClassVar[int]
    EXPIRED_AT_FIELD_NUMBER: _ClassVar[int]
    TAGS_FIELD_NUMBER: _ClassVar[int]
    VERSION_FIELD_NUMBER: _ClassVar[int]
    EMBEDDING_MODEL_FIELD_NUMBER: _ClassVar[int]
    LOG_INDEX_FIELD_NUMBER: _ClassVar[int]
    BRANCH_FIELD_NUMBER: _ClassVar[int]
    VALID_FROM_FIELD_NUMBER: _ClassVar[int]
    VALID_TO_FIELD_NUMBER: _ClassVar[int]
    RECALL_COUNT_FIELD_NUMBER: _ClassVar[int]
    LAST_RECALLED_AT_FIELD_NUMBER: _ClassVar[int]
    META_JSON_FIELD_NUMBER: _ClassVar[int]
    FORGET_REASON_FIELD_NUMBER: _ClassVar[int]
    TERMS_FIELD_NUMBER: _ClassVar[int]
    TERM_LENGTH_FIELD_NUMBER: _ClassVar[int]
    id: str
    user: str
    agent: str
    session: str
    kind: str
    text: str
    entities: _containers.RepeatedScalarFieldContainer[str]
    links: _containers.RepeatedCompositeFieldContainer[MemoryLink]
    source: MemorySource
    trust: str
    importance: float
    strength: float
    created_at: int
    expired_at: int
    tags: _containers.RepeatedScalarFieldContainer[str]
    version: int
    embedding_model: str
    log_index: int
    branch: str
    valid_from: int
    valid_to: int
    recall_count: int
    last_recalled_at: int
    meta_json: str
    forget_reason: str
    terms: _containers.RepeatedCompositeFieldContainer[TermCount]
    term_length: int
    def __init__(self, id: _Optional[str] = ..., user: _Optional[str] = ..., agent: _Optional[str] = ..., session: _Optional[str] = ..., kind: _Optional[str] = ..., text: _Optional[str] = ..., entities: _Optional[_Iterable[str]] = ..., links: _Optional[_Iterable[_Union[MemoryLink, _Mapping]]] = ..., source: _Optional[_Union[MemorySource, _Mapping]] = ..., trust: _Optional[str] = ..., importance: _Optional[float] = ..., strength: _Optional[float] = ..., created_at: _Optional[int] = ..., expired_at: _Optional[int] = ..., tags: _Optional[_Iterable[str]] = ..., version: _Optional[int] = ..., embedding_model: _Optional[str] = ..., log_index: _Optional[int] = ..., branch: _Optional[str] = ..., valid_from: _Optional[int] = ..., valid_to: _Optional[int] = ..., recall_count: _Optional[int] = ..., last_recalled_at: _Optional[int] = ..., meta_json: _Optional[str] = ..., forget_reason: _Optional[str] = ..., terms: _Optional[_Iterable[_Union[TermCount, _Mapping]]] = ..., term_length: _Optional[int] = ...) -> None: ...

class MemoryVector(_message.Message):
    __slots__ = ("model_id", "vector", "kind", "trust", "agent", "session")
    MODEL_ID_FIELD_NUMBER: _ClassVar[int]
    VECTOR_FIELD_NUMBER: _ClassVar[int]
    KIND_FIELD_NUMBER: _ClassVar[int]
    TRUST_FIELD_NUMBER: _ClassVar[int]
    AGENT_FIELD_NUMBER: _ClassVar[int]
    SESSION_FIELD_NUMBER: _ClassVar[int]
    model_id: str
    vector: bytes
    kind: str
    trust: str
    agent: str
    session: str
    def __init__(self, model_id: _Optional[str] = ..., vector: _Optional[bytes] = ..., kind: _Optional[str] = ..., trust: _Optional[str] = ..., agent: _Optional[str] = ..., session: _Optional[str] = ...) -> None: ...

class TermCount(_message.Message):
    __slots__ = ("term", "count")
    TERM_FIELD_NUMBER: _ClassVar[int]
    COUNT_FIELD_NUMBER: _ClassVar[int]
    term: str
    count: int
    def __init__(self, term: _Optional[str] = ..., count: _Optional[int] = ...) -> None: ...

class EntityMention(_message.Message):
    __slots__ = ("name", "type")
    NAME_FIELD_NUMBER: _ClassVar[int]
    TYPE_FIELD_NUMBER: _ClassVar[int]
    name: str
    type: str
    def __init__(self, name: _Optional[str] = ..., type: _Optional[str] = ...) -> None: ...

class NewMemory(_message.Message):
    __slots__ = ("record", "vector", "mentions")
    RECORD_FIELD_NUMBER: _ClassVar[int]
    VECTOR_FIELD_NUMBER: _ClassVar[int]
    MENTIONS_FIELD_NUMBER: _ClassVar[int]
    record: MemoryRecord
    vector: bytes
    mentions: _containers.RepeatedCompositeFieldContainer[EntityMention]
    def __init__(self, record: _Optional[_Union[MemoryRecord, _Mapping]] = ..., vector: _Optional[bytes] = ..., mentions: _Optional[_Iterable[_Union[EntityMention, _Mapping]]] = ...) -> None: ...

class EntityEdge(_message.Message):
    __slots__ = ("src_name", "src_type", "relation", "dst_name", "dst_type", "weight", "memory_id")
    SRC_NAME_FIELD_NUMBER: _ClassVar[int]
    SRC_TYPE_FIELD_NUMBER: _ClassVar[int]
    RELATION_FIELD_NUMBER: _ClassVar[int]
    DST_NAME_FIELD_NUMBER: _ClassVar[int]
    DST_TYPE_FIELD_NUMBER: _ClassVar[int]
    WEIGHT_FIELD_NUMBER: _ClassVar[int]
    MEMORY_ID_FIELD_NUMBER: _ClassVar[int]
    src_name: str
    src_type: str
    relation: str
    dst_name: str
    dst_type: str
    weight: float
    memory_id: str
    def __init__(self, src_name: _Optional[str] = ..., src_type: _Optional[str] = ..., relation: _Optional[str] = ..., dst_name: _Optional[str] = ..., dst_type: _Optional[str] = ..., weight: _Optional[float] = ..., memory_id: _Optional[str] = ...) -> None: ...

class JobRef(_message.Message):
    __slots__ = ("id", "attempt")
    ID_FIELD_NUMBER: _ClassVar[int]
    ATTEMPT_FIELD_NUMBER: _ClassVar[int]
    id: str
    attempt: int
    def __init__(self, id: _Optional[str] = ..., attempt: _Optional[int] = ...) -> None: ...

class MemoryCommit(_message.Message):
    __slots__ = ("user", "memories", "edges", "enqueue", "complete", "conflicts", "supersede")
    USER_FIELD_NUMBER: _ClassVar[int]
    MEMORIES_FIELD_NUMBER: _ClassVar[int]
    EDGES_FIELD_NUMBER: _ClassVar[int]
    ENQUEUE_FIELD_NUMBER: _ClassVar[int]
    COMPLETE_FIELD_NUMBER: _ClassVar[int]
    CONFLICTS_FIELD_NUMBER: _ClassVar[int]
    SUPERSEDE_FIELD_NUMBER: _ClassVar[int]
    user: str
    memories: _containers.RepeatedCompositeFieldContainer[NewMemory]
    edges: _containers.RepeatedCompositeFieldContainer[EntityEdge]
    enqueue: _containers.RepeatedCompositeFieldContainer[_jobs_pb2.JobSpec]
    complete: JobRef
    conflicts: _containers.RepeatedCompositeFieldContainer[MemoryConflict]
    supersede: _containers.RepeatedCompositeFieldContainer[Supersede]
    def __init__(self, user: _Optional[str] = ..., memories: _Optional[_Iterable[_Union[NewMemory, _Mapping]]] = ..., edges: _Optional[_Iterable[_Union[EntityEdge, _Mapping]]] = ..., enqueue: _Optional[_Iterable[_Union[_jobs_pb2.JobSpec, _Mapping]]] = ..., complete: _Optional[_Union[JobRef, _Mapping]] = ..., conflicts: _Optional[_Iterable[_Union[MemoryConflict, _Mapping]]] = ..., supersede: _Optional[_Iterable[_Union[Supersede, _Mapping]]] = ...) -> None: ...

class MemoryConflict(_message.Message):
    __slots__ = ("id", "a", "b", "score_ab", "score_ba", "detected_at", "status", "policy", "origin", "model_id", "keep", "resolved_by", "resolved_at")
    ID_FIELD_NUMBER: _ClassVar[int]
    A_FIELD_NUMBER: _ClassVar[int]
    B_FIELD_NUMBER: _ClassVar[int]
    SCORE_AB_FIELD_NUMBER: _ClassVar[int]
    SCORE_BA_FIELD_NUMBER: _ClassVar[int]
    DETECTED_AT_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    POLICY_FIELD_NUMBER: _ClassVar[int]
    ORIGIN_FIELD_NUMBER: _ClassVar[int]
    MODEL_ID_FIELD_NUMBER: _ClassVar[int]
    KEEP_FIELD_NUMBER: _ClassVar[int]
    RESOLVED_BY_FIELD_NUMBER: _ClassVar[int]
    RESOLVED_AT_FIELD_NUMBER: _ClassVar[int]
    id: str
    a: str
    b: str
    score_ab: float
    score_ba: float
    detected_at: int
    status: str
    policy: str
    origin: str
    model_id: str
    keep: str
    resolved_by: str
    resolved_at: int
    def __init__(self, id: _Optional[str] = ..., a: _Optional[str] = ..., b: _Optional[str] = ..., score_ab: _Optional[float] = ..., score_ba: _Optional[float] = ..., detected_at: _Optional[int] = ..., status: _Optional[str] = ..., policy: _Optional[str] = ..., origin: _Optional[str] = ..., model_id: _Optional[str] = ..., keep: _Optional[str] = ..., resolved_by: _Optional[str] = ..., resolved_at: _Optional[int] = ...) -> None: ...

class Supersede(_message.Message):
    __slots__ = ("id", "valid_to")
    ID_FIELD_NUMBER: _ClassVar[int]
    VALID_TO_FIELD_NUMBER: _ClassVar[int]
    id: str
    valid_to: int
    def __init__(self, id: _Optional[str] = ..., valid_to: _Optional[int] = ...) -> None: ...

class ConflictResolve(_message.Message):
    __slots__ = ("user", "id", "keep", "valid_from", "now_ms")
    USER_FIELD_NUMBER: _ClassVar[int]
    ID_FIELD_NUMBER: _ClassVar[int]
    KEEP_FIELD_NUMBER: _ClassVar[int]
    VALID_FROM_FIELD_NUMBER: _ClassVar[int]
    NOW_MS_FIELD_NUMBER: _ClassVar[int]
    user: str
    id: str
    keep: str
    valid_from: int
    now_ms: int
    def __init__(self, user: _Optional[str] = ..., id: _Optional[str] = ..., keep: _Optional[str] = ..., valid_from: _Optional[int] = ..., now_ms: _Optional[int] = ...) -> None: ...

class MemoryTrust(_message.Message):
    __slots__ = ("user", "ids", "trust", "reason")
    USER_FIELD_NUMBER: _ClassVar[int]
    IDS_FIELD_NUMBER: _ClassVar[int]
    TRUST_FIELD_NUMBER: _ClassVar[int]
    REASON_FIELD_NUMBER: _ClassVar[int]
    user: str
    ids: _containers.RepeatedScalarFieldContainer[str]
    trust: str
    reason: str
    def __init__(self, user: _Optional[str] = ..., ids: _Optional[_Iterable[str]] = ..., trust: _Optional[str] = ..., reason: _Optional[str] = ...) -> None: ...

class MemoryForget(_message.Message):
    __slots__ = ("user", "ids", "reason")
    USER_FIELD_NUMBER: _ClassVar[int]
    IDS_FIELD_NUMBER: _ClassVar[int]
    REASON_FIELD_NUMBER: _ClassVar[int]
    user: str
    ids: _containers.RepeatedScalarFieldContainer[str]
    reason: str
    def __init__(self, user: _Optional[str] = ..., ids: _Optional[_Iterable[str]] = ..., reason: _Optional[str] = ...) -> None: ...

class MemoryEntity(_message.Message):
    __slots__ = ("name", "type", "mention_count", "created_at")
    NAME_FIELD_NUMBER: _ClassVar[int]
    TYPE_FIELD_NUMBER: _ClassVar[int]
    MENTION_COUNT_FIELD_NUMBER: _ClassVar[int]
    CREATED_AT_FIELD_NUMBER: _ClassVar[int]
    name: str
    type: str
    mention_count: int
    created_at: int
    def __init__(self, name: _Optional[str] = ..., type: _Optional[str] = ..., mention_count: _Optional[int] = ..., created_at: _Optional[int] = ...) -> None: ...

class MemoryEdge(_message.Message):
    __slots__ = ("weight", "memories", "created_at")
    WEIGHT_FIELD_NUMBER: _ClassVar[int]
    MEMORIES_FIELD_NUMBER: _ClassVar[int]
    CREATED_AT_FIELD_NUMBER: _ClassVar[int]
    weight: float
    memories: _containers.RepeatedScalarFieldContainer[str]
    created_at: int
    def __init__(self, weight: _Optional[float] = ..., memories: _Optional[_Iterable[str]] = ..., created_at: _Optional[int] = ...) -> None: ...

class MemoryOutcome(_message.Message):
    __slots__ = ("ids", "count")
    IDS_FIELD_NUMBER: _ClassVar[int]
    COUNT_FIELD_NUMBER: _ClassVar[int]
    ids: _containers.RepeatedScalarFieldContainer[str]
    count: int
    def __init__(self, ids: _Optional[_Iterable[str]] = ..., count: _Optional[int] = ...) -> None: ...
