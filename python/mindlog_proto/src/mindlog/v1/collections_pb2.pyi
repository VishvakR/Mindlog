from mindlog.v1 import jobs_pb2 as _jobs_pb2
from mindlog.v1 import memory_pb2 as _memory_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf.internal import enum_type_wrapper as _enum_type_wrapper
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class RecordOpKind(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    RECORD_OP_KIND_UNSPECIFIED: _ClassVar[RecordOpKind]
    RECORD_OP_KIND_CREATE: _ClassVar[RecordOpKind]
    RECORD_OP_KIND_UPDATE: _ClassVar[RecordOpKind]
    RECORD_OP_KIND_DELETE: _ClassVar[RecordOpKind]
    RECORD_OP_KIND_UPSERT: _ClassVar[RecordOpKind]
RECORD_OP_KIND_UNSPECIFIED: RecordOpKind
RECORD_OP_KIND_CREATE: RecordOpKind
RECORD_OP_KIND_UPDATE: RecordOpKind
RECORD_OP_KIND_DELETE: RecordOpKind
RECORD_OP_KIND_UPSERT: RecordOpKind

class RecordOp(_message.Message):
    __slots__ = ("kind", "id", "data", "expect_version")
    KIND_FIELD_NUMBER: _ClassVar[int]
    ID_FIELD_NUMBER: _ClassVar[int]
    DATA_FIELD_NUMBER: _ClassVar[int]
    EXPECT_VERSION_FIELD_NUMBER: _ClassVar[int]
    kind: RecordOpKind
    id: str
    data: bytes
    expect_version: int
    def __init__(self, kind: _Optional[_Union[RecordOpKind, str]] = ..., id: _Optional[str] = ..., data: _Optional[bytes] = ..., expect_version: _Optional[int] = ...) -> None: ...

class RecordWrite(_message.Message):
    __slots__ = ("collection", "ops", "enqueue", "complete")
    COLLECTION_FIELD_NUMBER: _ClassVar[int]
    OPS_FIELD_NUMBER: _ClassVar[int]
    ENQUEUE_FIELD_NUMBER: _ClassVar[int]
    COMPLETE_FIELD_NUMBER: _ClassVar[int]
    collection: str
    ops: _containers.RepeatedCompositeFieldContainer[RecordOp]
    enqueue: _containers.RepeatedCompositeFieldContainer[_jobs_pb2.JobSpec]
    complete: _memory_pb2.JobRef
    def __init__(self, collection: _Optional[str] = ..., ops: _Optional[_Iterable[_Union[RecordOp, _Mapping]]] = ..., enqueue: _Optional[_Iterable[_Union[_jobs_pb2.JobSpec, _Mapping]]] = ..., complete: _Optional[_Union[_memory_pb2.JobRef, _Mapping]] = ...) -> None: ...

class SchemaChange(_message.Message):
    __slots__ = ("collection", "schema", "expect_version")
    COLLECTION_FIELD_NUMBER: _ClassVar[int]
    SCHEMA_FIELD_NUMBER: _ClassVar[int]
    EXPECT_VERSION_FIELD_NUMBER: _ClassVar[int]
    collection: str
    schema: bytes
    expect_version: int
    def __init__(self, collection: _Optional[str] = ..., schema: _Optional[bytes] = ..., expect_version: _Optional[int] = ...) -> None: ...

class StoredSchema(_message.Message):
    __slots__ = ("schema", "version")
    SCHEMA_FIELD_NUMBER: _ClassVar[int]
    VERSION_FIELD_NUMBER: _ClassVar[int]
    schema: bytes
    version: int
    def __init__(self, schema: _Optional[bytes] = ..., version: _Optional[int] = ...) -> None: ...

class StoredRecord(_message.Message):
    __slots__ = ("data", "created_ms", "updated_ms", "version")
    DATA_FIELD_NUMBER: _ClassVar[int]
    CREATED_MS_FIELD_NUMBER: _ClassVar[int]
    UPDATED_MS_FIELD_NUMBER: _ClassVar[int]
    VERSION_FIELD_NUMBER: _ClassVar[int]
    data: bytes
    created_ms: int
    updated_ms: int
    version: int
    def __init__(self, data: _Optional[bytes] = ..., created_ms: _Optional[int] = ..., updated_ms: _Optional[int] = ..., version: _Optional[int] = ...) -> None: ...

class RecordOutcome(_message.Message):
    __slots__ = ("ids", "versions")
    IDS_FIELD_NUMBER: _ClassVar[int]
    VERSIONS_FIELD_NUMBER: _ClassVar[int]
    ids: _containers.RepeatedScalarFieldContainer[str]
    versions: _containers.RepeatedScalarFieldContainer[int]
    def __init__(self, ids: _Optional[_Iterable[str]] = ..., versions: _Optional[_Iterable[int]] = ...) -> None: ...
