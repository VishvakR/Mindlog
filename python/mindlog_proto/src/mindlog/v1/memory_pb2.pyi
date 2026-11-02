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
    __slots__ = ("id", "user", "agent", "session", "kind", "text", "entities", "links", "source", "trust", "importance", "strength", "created_at", "expired_at", "tags", "version", "embedding_model", "log_index", "branch", "valid_from", "valid_to", "recall_count", "last_recalled_at", "meta_json", "forget_reason", "terms", "term_length", "tier", "pinned", "cold_segment", "cold_sha256")
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
    TIER_FIELD_NUMBER: _ClassVar[int]
    PINNED_FIELD_NUMBER: _ClassVar[int]
    COLD_SEGMENT_FIELD_NUMBER: _ClassVar[int]
    COLD_SHA256_FIELD_NUMBER: _ClassVar[int]
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
    tier: str
    pinned: bool
    cold_segment: str
    cold_sha256: str
    def __init__(self, id: _Optional[str] = ..., user: _Optional[str] = ..., agent: _Optional[str] = ..., session: _Optional[str] = ..., kind: _Optional[str] = ..., text: _Optional[str] = ..., entities: _Optional[_Iterable[str]] = ..., links: _Optional[_Iterable[_Union[MemoryLink, _Mapping]]] = ..., source: _Optional[_Union[MemorySource, _Mapping]] = ..., trust: _Optional[str] = ..., importance: _Optional[float] = ..., strength: _Optional[float] = ..., created_at: _Optional[int] = ..., expired_at: _Optional[int] = ..., tags: _Optional[_Iterable[str]] = ..., version: _Optional[int] = ..., embedding_model: _Optional[str] = ..., log_index: _Optional[int] = ..., branch: _Optional[str] = ..., valid_from: _Optional[int] = ..., valid_to: _Optional[int] = ..., recall_count: _Optional[int] = ..., last_recalled_at: _Optional[int] = ..., meta_json: _Optional[str] = ..., forget_reason: _Optional[str] = ..., terms: _Optional[_Iterable[_Union[TermCount, _Mapping]]] = ..., term_length: _Optional[int] = ..., tier: _Optional[str] = ..., pinned: _Optional[bool] = ..., cold_segment: _Optional[str] = ..., cold_sha256: _Optional[str] = ...) -> None: ...

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
    __slots__ = ("user", "memories", "edges", "enqueue", "complete", "conflicts", "supersede", "tick", "reembed")
    USER_FIELD_NUMBER: _ClassVar[int]
    MEMORIES_FIELD_NUMBER: _ClassVar[int]
    EDGES_FIELD_NUMBER: _ClassVar[int]
    ENQUEUE_FIELD_NUMBER: _ClassVar[int]
    COMPLETE_FIELD_NUMBER: _ClassVar[int]
    CONFLICTS_FIELD_NUMBER: _ClassVar[int]
    SUPERSEDE_FIELD_NUMBER: _ClassVar[int]
    TICK_FIELD_NUMBER: _ClassVar[int]
    REEMBED_FIELD_NUMBER: _ClassVar[int]
    user: str
    memories: _containers.RepeatedCompositeFieldContainer[NewMemory]
    edges: _containers.RepeatedCompositeFieldContainer[EntityEdge]
    enqueue: _containers.RepeatedCompositeFieldContainer[_jobs_pb2.JobSpec]
    complete: JobRef
    conflicts: _containers.RepeatedCompositeFieldContainer[MemoryConflict]
    supersede: _containers.RepeatedCompositeFieldContainer[Supersede]
    tick: _jobs_pb2.JobSpec
    reembed: bool
    def __init__(self, user: _Optional[str] = ..., memories: _Optional[_Iterable[_Union[NewMemory, _Mapping]]] = ..., edges: _Optional[_Iterable[_Union[EntityEdge, _Mapping]]] = ..., enqueue: _Optional[_Iterable[_Union[_jobs_pb2.JobSpec, _Mapping]]] = ..., complete: _Optional[_Union[JobRef, _Mapping]] = ..., conflicts: _Optional[_Iterable[_Union[MemoryConflict, _Mapping]]] = ..., supersede: _Optional[_Iterable[_Union[Supersede, _Mapping]]] = ..., tick: _Optional[_Union[_jobs_pb2.JobSpec, _Mapping]] = ..., reembed: _Optional[bool] = ...) -> None: ...

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
    __slots__ = ("user", "ids", "reason", "source_ref", "cascade_limit")
    USER_FIELD_NUMBER: _ClassVar[int]
    IDS_FIELD_NUMBER: _ClassVar[int]
    REASON_FIELD_NUMBER: _ClassVar[int]
    SOURCE_REF_FIELD_NUMBER: _ClassVar[int]
    CASCADE_LIMIT_FIELD_NUMBER: _ClassVar[int]
    user: str
    ids: _containers.RepeatedScalarFieldContainer[str]
    reason: str
    source_ref: str
    cascade_limit: int
    def __init__(self, user: _Optional[str] = ..., ids: _Optional[_Iterable[str]] = ..., reason: _Optional[str] = ..., source_ref: _Optional[str] = ..., cascade_limit: _Optional[int] = ...) -> None: ...

class MemoryEntity(_message.Message):
    __slots__ = ("name", "type", "mention_count", "created_at", "summary", "summary_mentions")
    NAME_FIELD_NUMBER: _ClassVar[int]
    TYPE_FIELD_NUMBER: _ClassVar[int]
    MENTION_COUNT_FIELD_NUMBER: _ClassVar[int]
    CREATED_AT_FIELD_NUMBER: _ClassVar[int]
    SUMMARY_FIELD_NUMBER: _ClassVar[int]
    SUMMARY_MENTIONS_FIELD_NUMBER: _ClassVar[int]
    name: str
    type: str
    mention_count: int
    created_at: int
    summary: str
    summary_mentions: int
    def __init__(self, name: _Optional[str] = ..., type: _Optional[str] = ..., mention_count: _Optional[int] = ..., created_at: _Optional[int] = ..., summary: _Optional[str] = ..., summary_mentions: _Optional[int] = ...) -> None: ...

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

class MemoryBranch(_message.Message):
    __slots__ = ("name", "fork_index", "fork_version", "created_by", "status", "closed_at", "writes", "max_writes")
    NAME_FIELD_NUMBER: _ClassVar[int]
    FORK_INDEX_FIELD_NUMBER: _ClassVar[int]
    FORK_VERSION_FIELD_NUMBER: _ClassVar[int]
    CREATED_BY_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    CLOSED_AT_FIELD_NUMBER: _ClassVar[int]
    WRITES_FIELD_NUMBER: _ClassVar[int]
    MAX_WRITES_FIELD_NUMBER: _ClassVar[int]
    name: str
    fork_index: int
    fork_version: int
    created_by: str
    status: str
    closed_at: int
    writes: int
    max_writes: int
    def __init__(self, name: _Optional[str] = ..., fork_index: _Optional[int] = ..., fork_version: _Optional[int] = ..., created_by: _Optional[str] = ..., status: _Optional[str] = ..., closed_at: _Optional[int] = ..., writes: _Optional[int] = ..., max_writes: _Optional[int] = ...) -> None: ...

class BranchCreate(_message.Message):
    __slots__ = ("user", "name", "max_writes")
    USER_FIELD_NUMBER: _ClassVar[int]
    NAME_FIELD_NUMBER: _ClassVar[int]
    MAX_WRITES_FIELD_NUMBER: _ClassVar[int]
    user: str
    name: str
    max_writes: int
    def __init__(self, user: _Optional[str] = ..., name: _Optional[str] = ..., max_writes: _Optional[int] = ...) -> None: ...

class BranchAdd(_message.Message):
    __slots__ = ("id", "quarantine")
    ID_FIELD_NUMBER: _ClassVar[int]
    QUARANTINE_FIELD_NUMBER: _ClassVar[int]
    id: str
    quarantine: bool
    def __init__(self, id: _Optional[str] = ..., quarantine: _Optional[bool] = ...) -> None: ...

class RecordFields(_message.Message):
    __slots__ = ("id", "expired", "trust", "valid_to")
    ID_FIELD_NUMBER: _ClassVar[int]
    EXPIRED_FIELD_NUMBER: _ClassVar[int]
    TRUST_FIELD_NUMBER: _ClassVar[int]
    VALID_TO_FIELD_NUMBER: _ClassVar[int]
    id: str
    expired: bool
    trust: str
    valid_to: int
    def __init__(self, id: _Optional[str] = ..., expired: _Optional[bool] = ..., trust: _Optional[str] = ..., valid_to: _Optional[int] = ...) -> None: ...

class EdgeWeight(_message.Message):
    __slots__ = ("src", "relation", "dst", "weight", "memories")
    SRC_FIELD_NUMBER: _ClassVar[int]
    RELATION_FIELD_NUMBER: _ClassVar[int]
    DST_FIELD_NUMBER: _ClassVar[int]
    WEIGHT_FIELD_NUMBER: _ClassVar[int]
    MEMORIES_FIELD_NUMBER: _ClassVar[int]
    src: str
    relation: str
    dst: str
    weight: float
    memories: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, src: _Optional[str] = ..., relation: _Optional[str] = ..., dst: _Optional[str] = ..., weight: _Optional[float] = ..., memories: _Optional[_Iterable[str]] = ...) -> None: ...

class BranchMerge(_message.Message):
    __slots__ = ("user", "name", "policy", "main_generation", "adds", "records", "edges", "conflicts", "supersede", "rejected", "branch_generation")
    USER_FIELD_NUMBER: _ClassVar[int]
    NAME_FIELD_NUMBER: _ClassVar[int]
    POLICY_FIELD_NUMBER: _ClassVar[int]
    MAIN_GENERATION_FIELD_NUMBER: _ClassVar[int]
    ADDS_FIELD_NUMBER: _ClassVar[int]
    RECORDS_FIELD_NUMBER: _ClassVar[int]
    EDGES_FIELD_NUMBER: _ClassVar[int]
    CONFLICTS_FIELD_NUMBER: _ClassVar[int]
    SUPERSEDE_FIELD_NUMBER: _ClassVar[int]
    REJECTED_FIELD_NUMBER: _ClassVar[int]
    BRANCH_GENERATION_FIELD_NUMBER: _ClassVar[int]
    user: str
    name: str
    policy: str
    main_generation: int
    adds: _containers.RepeatedCompositeFieldContainer[BranchAdd]
    records: _containers.RepeatedCompositeFieldContainer[RecordFields]
    edges: _containers.RepeatedCompositeFieldContainer[EdgeWeight]
    conflicts: _containers.RepeatedCompositeFieldContainer[MemoryConflict]
    supersede: _containers.RepeatedCompositeFieldContainer[Supersede]
    rejected: _containers.RepeatedScalarFieldContainer[str]
    branch_generation: int
    def __init__(self, user: _Optional[str] = ..., name: _Optional[str] = ..., policy: _Optional[str] = ..., main_generation: _Optional[int] = ..., adds: _Optional[_Iterable[_Union[BranchAdd, _Mapping]]] = ..., records: _Optional[_Iterable[_Union[RecordFields, _Mapping]]] = ..., edges: _Optional[_Iterable[_Union[EdgeWeight, _Mapping]]] = ..., conflicts: _Optional[_Iterable[_Union[MemoryConflict, _Mapping]]] = ..., supersede: _Optional[_Iterable[_Union[Supersede, _Mapping]]] = ..., rejected: _Optional[_Iterable[str]] = ..., branch_generation: _Optional[int] = ...) -> None: ...

class BranchDrop(_message.Message):
    __slots__ = ("user", "name")
    USER_FIELD_NUMBER: _ClassVar[int]
    NAME_FIELD_NUMBER: _ClassVar[int]
    user: str
    name: str
    def __init__(self, user: _Optional[str] = ..., name: _Optional[str] = ...) -> None: ...

class ScopeLifecycle(_message.Message):
    __slots__ = ("last_write_ms", "writes_since_sleep", "graph_size", "graph_size_at_theme", "embed_model", "reembed", "last_run_ms", "checkpoints", "tick_at_ms", "hot", "cold", "writes_since_evolve")
    class LastRunMsEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: int
        def __init__(self, key: _Optional[str] = ..., value: _Optional[int] = ...) -> None: ...
    class CheckpointsEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: str
        def __init__(self, key: _Optional[str] = ..., value: _Optional[str] = ...) -> None: ...
    LAST_WRITE_MS_FIELD_NUMBER: _ClassVar[int]
    WRITES_SINCE_SLEEP_FIELD_NUMBER: _ClassVar[int]
    GRAPH_SIZE_FIELD_NUMBER: _ClassVar[int]
    GRAPH_SIZE_AT_THEME_FIELD_NUMBER: _ClassVar[int]
    EMBED_MODEL_FIELD_NUMBER: _ClassVar[int]
    REEMBED_FIELD_NUMBER: _ClassVar[int]
    LAST_RUN_MS_FIELD_NUMBER: _ClassVar[int]
    CHECKPOINTS_FIELD_NUMBER: _ClassVar[int]
    TICK_AT_MS_FIELD_NUMBER: _ClassVar[int]
    HOT_FIELD_NUMBER: _ClassVar[int]
    COLD_FIELD_NUMBER: _ClassVar[int]
    WRITES_SINCE_EVOLVE_FIELD_NUMBER: _ClassVar[int]
    last_write_ms: int
    writes_since_sleep: int
    graph_size: int
    graph_size_at_theme: int
    embed_model: str
    reembed: bool
    last_run_ms: _containers.ScalarMap[str, int]
    checkpoints: _containers.ScalarMap[str, str]
    tick_at_ms: int
    hot: int
    cold: int
    writes_since_evolve: int
    def __init__(self, last_write_ms: _Optional[int] = ..., writes_since_sleep: _Optional[int] = ..., graph_size: _Optional[int] = ..., graph_size_at_theme: _Optional[int] = ..., embed_model: _Optional[str] = ..., reembed: _Optional[bool] = ..., last_run_ms: _Optional[_Mapping[str, int]] = ..., checkpoints: _Optional[_Mapping[str, str]] = ..., tick_at_ms: _Optional[int] = ..., hot: _Optional[int] = ..., cold: _Optional[int] = ..., writes_since_evolve: _Optional[int] = ...) -> None: ...

class MemoryEvolve(_message.Message):
    __slots__ = ("id", "tags", "set_tags", "meta_json", "importance", "set_importance", "add_links")
    ID_FIELD_NUMBER: _ClassVar[int]
    TAGS_FIELD_NUMBER: _ClassVar[int]
    SET_TAGS_FIELD_NUMBER: _ClassVar[int]
    META_JSON_FIELD_NUMBER: _ClassVar[int]
    IMPORTANCE_FIELD_NUMBER: _ClassVar[int]
    SET_IMPORTANCE_FIELD_NUMBER: _ClassVar[int]
    ADD_LINKS_FIELD_NUMBER: _ClassVar[int]
    id: str
    tags: _containers.RepeatedScalarFieldContainer[str]
    set_tags: bool
    meta_json: str
    importance: float
    set_importance: bool
    add_links: _containers.RepeatedCompositeFieldContainer[MemoryLink]
    def __init__(self, id: _Optional[str] = ..., tags: _Optional[_Iterable[str]] = ..., set_tags: _Optional[bool] = ..., meta_json: _Optional[str] = ..., importance: _Optional[float] = ..., set_importance: _Optional[bool] = ..., add_links: _Optional[_Iterable[_Union[MemoryLink, _Mapping]]] = ...) -> None: ...

class TierMove(_message.Message):
    __slots__ = ("id", "tier", "segment", "sha256", "text", "vector", "model_id")
    ID_FIELD_NUMBER: _ClassVar[int]
    TIER_FIELD_NUMBER: _ClassVar[int]
    SEGMENT_FIELD_NUMBER: _ClassVar[int]
    SHA256_FIELD_NUMBER: _ClassVar[int]
    TEXT_FIELD_NUMBER: _ClassVar[int]
    VECTOR_FIELD_NUMBER: _ClassVar[int]
    MODEL_ID_FIELD_NUMBER: _ClassVar[int]
    id: str
    tier: str
    segment: str
    sha256: str
    text: str
    vector: bytes
    model_id: str
    def __init__(self, id: _Optional[str] = ..., tier: _Optional[str] = ..., segment: _Optional[str] = ..., sha256: _Optional[str] = ..., text: _Optional[str] = ..., vector: _Optional[bytes] = ..., model_id: _Optional[str] = ...) -> None: ...

class EntitySummary(_message.Message):
    __slots__ = ("entity_id", "summary")
    ENTITY_ID_FIELD_NUMBER: _ClassVar[int]
    SUMMARY_FIELD_NUMBER: _ClassVar[int]
    entity_id: str
    summary: str
    def __init__(self, entity_id: _Optional[str] = ..., summary: _Optional[str] = ...) -> None: ...

class Reembedded(_message.Message):
    __slots__ = ("id", "vector")
    ID_FIELD_NUMBER: _ClassVar[int]
    VECTOR_FIELD_NUMBER: _ClassVar[int]
    id: str
    vector: bytes
    def __init__(self, id: _Optional[str] = ..., vector: _Optional[bytes] = ...) -> None: ...

class PinChange(_message.Message):
    __slots__ = ("id", "pinned")
    ID_FIELD_NUMBER: _ClassVar[int]
    PINNED_FIELD_NUMBER: _ClassVar[int]
    id: str
    pinned: bool
    def __init__(self, id: _Optional[str] = ..., pinned: _Optional[bool] = ...) -> None: ...

class MemoryMaintain(_message.Message):
    __slots__ = ("user", "evolve", "tier", "entities", "reembed", "reembed_model", "reembed_done", "pin", "enqueue", "complete", "checkpoint_worker", "checkpoint", "next_tick", "tick")
    USER_FIELD_NUMBER: _ClassVar[int]
    EVOLVE_FIELD_NUMBER: _ClassVar[int]
    TIER_FIELD_NUMBER: _ClassVar[int]
    ENTITIES_FIELD_NUMBER: _ClassVar[int]
    REEMBED_FIELD_NUMBER: _ClassVar[int]
    REEMBED_MODEL_FIELD_NUMBER: _ClassVar[int]
    REEMBED_DONE_FIELD_NUMBER: _ClassVar[int]
    PIN_FIELD_NUMBER: _ClassVar[int]
    ENQUEUE_FIELD_NUMBER: _ClassVar[int]
    COMPLETE_FIELD_NUMBER: _ClassVar[int]
    CHECKPOINT_WORKER_FIELD_NUMBER: _ClassVar[int]
    CHECKPOINT_FIELD_NUMBER: _ClassVar[int]
    NEXT_TICK_FIELD_NUMBER: _ClassVar[int]
    TICK_FIELD_NUMBER: _ClassVar[int]
    user: str
    evolve: _containers.RepeatedCompositeFieldContainer[MemoryEvolve]
    tier: _containers.RepeatedCompositeFieldContainer[TierMove]
    entities: _containers.RepeatedCompositeFieldContainer[EntitySummary]
    reembed: _containers.RepeatedCompositeFieldContainer[Reembedded]
    reembed_model: str
    reembed_done: bool
    pin: _containers.RepeatedCompositeFieldContainer[PinChange]
    enqueue: _containers.RepeatedCompositeFieldContainer[_jobs_pb2.JobSpec]
    complete: JobRef
    checkpoint_worker: str
    checkpoint: str
    next_tick: _jobs_pb2.JobSpec
    tick: bool
    def __init__(self, user: _Optional[str] = ..., evolve: _Optional[_Iterable[_Union[MemoryEvolve, _Mapping]]] = ..., tier: _Optional[_Iterable[_Union[TierMove, _Mapping]]] = ..., entities: _Optional[_Iterable[_Union[EntitySummary, _Mapping]]] = ..., reembed: _Optional[_Iterable[_Union[Reembedded, _Mapping]]] = ..., reembed_model: _Optional[str] = ..., reembed_done: _Optional[bool] = ..., pin: _Optional[_Iterable[_Union[PinChange, _Mapping]]] = ..., enqueue: _Optional[_Iterable[_Union[_jobs_pb2.JobSpec, _Mapping]]] = ..., complete: _Optional[_Union[JobRef, _Mapping]] = ..., checkpoint_worker: _Optional[str] = ..., checkpoint: _Optional[str] = ..., next_tick: _Optional[_Union[_jobs_pb2.JobSpec, _Mapping]] = ..., tick: _Optional[bool] = ...) -> None: ...

class MemoryRecallStats(_message.Message):
    __slots__ = ("user", "ids")
    USER_FIELD_NUMBER: _ClassVar[int]
    IDS_FIELD_NUMBER: _ClassVar[int]
    user: str
    ids: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, user: _Optional[str] = ..., ids: _Optional[_Iterable[str]] = ...) -> None: ...
