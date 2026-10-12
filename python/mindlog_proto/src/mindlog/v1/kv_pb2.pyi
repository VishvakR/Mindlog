from mindlog.v1 import common_pb2 as _common_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf.internal import enum_type_wrapper as _enum_type_wrapper
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class KvType(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    KV_TYPE_UNSPECIFIED: _ClassVar[KvType]
    KV_TYPE_STRING: _ClassVar[KvType]
    KV_TYPE_HASH: _ClassVar[KvType]
    KV_TYPE_LIST: _ClassVar[KvType]
    KV_TYPE_SET: _ClassVar[KvType]
    KV_TYPE_ZSET: _ClassVar[KvType]
    KV_TYPE_JSON: _ClassVar[KvType]
KV_TYPE_UNSPECIFIED: KvType
KV_TYPE_STRING: KvType
KV_TYPE_HASH: KvType
KV_TYPE_LIST: KvType
KV_TYPE_SET: KvType
KV_TYPE_ZSET: KvType
KV_TYPE_JSON: KvType

class KvWrite(_message.Message):
    __slots__ = ("argv",)
    ARGV_FIELD_NUMBER: _ClassVar[int]
    argv: _containers.RepeatedScalarFieldContainer[bytes]
    def __init__(self, argv: _Optional[_Iterable[bytes]] = ...) -> None: ...

class WatchedKey(_message.Message):
    __slots__ = ("key", "version")
    KEY_FIELD_NUMBER: _ClassVar[int]
    VERSION_FIELD_NUMBER: _ClassVar[int]
    key: bytes
    version: int
    def __init__(self, key: _Optional[bytes] = ..., version: _Optional[int] = ...) -> None: ...

class KvBatch(_message.Message):
    __slots__ = ("writes", "watches")
    WRITES_FIELD_NUMBER: _ClassVar[int]
    WATCHES_FIELD_NUMBER: _ClassVar[int]
    writes: _containers.RepeatedCompositeFieldContainer[KvWrite]
    watches: _containers.RepeatedCompositeFieldContainer[WatchedKey]
    def __init__(self, writes: _Optional[_Iterable[_Union[KvWrite, _Mapping]]] = ..., watches: _Optional[_Iterable[_Union[WatchedKey, _Mapping]]] = ...) -> None: ...

class Expire(_message.Message):
    __slots__ = ("keys",)
    KEYS_FIELD_NUMBER: _ClassVar[int]
    keys: _containers.RepeatedCompositeFieldContainer[ExpiringKey]
    def __init__(self, keys: _Optional[_Iterable[_Union[ExpiringKey, _Mapping]]] = ...) -> None: ...

class ExpiringKey(_message.Message):
    __slots__ = ("key", "expire_at_ms")
    KEY_FIELD_NUMBER: _ClassVar[int]
    EXPIRE_AT_MS_FIELD_NUMBER: _ClassVar[int]
    key: bytes
    expire_at_ms: int
    def __init__(self, key: _Optional[bytes] = ..., expire_at_ms: _Optional[int] = ...) -> None: ...

class KvHeader(_message.Message):
    __slots__ = ("type", "generation", "count", "expire_at_ms", "version", "list_head", "list_tail", "value")
    TYPE_FIELD_NUMBER: _ClassVar[int]
    GENERATION_FIELD_NUMBER: _ClassVar[int]
    COUNT_FIELD_NUMBER: _ClassVar[int]
    EXPIRE_AT_MS_FIELD_NUMBER: _ClassVar[int]
    VERSION_FIELD_NUMBER: _ClassVar[int]
    LIST_HEAD_FIELD_NUMBER: _ClassVar[int]
    LIST_TAIL_FIELD_NUMBER: _ClassVar[int]
    VALUE_FIELD_NUMBER: _ClassVar[int]
    type: KvType
    generation: int
    count: int
    expire_at_ms: int
    version: int
    list_head: int
    list_tail: int
    value: bytes
    def __init__(self, type: _Optional[_Union[KvType, str]] = ..., generation: _Optional[int] = ..., count: _Optional[int] = ..., expire_at_ms: _Optional[int] = ..., version: _Optional[int] = ..., list_head: _Optional[int] = ..., list_tail: _Optional[int] = ..., value: _Optional[bytes] = ...) -> None: ...

class KvReply(_message.Message):
    __slots__ = ("null", "integer", "bulk", "simple", "double", "boolean", "array", "set", "map", "error")
    NULL_FIELD_NUMBER: _ClassVar[int]
    INTEGER_FIELD_NUMBER: _ClassVar[int]
    BULK_FIELD_NUMBER: _ClassVar[int]
    SIMPLE_FIELD_NUMBER: _ClassVar[int]
    DOUBLE_FIELD_NUMBER: _ClassVar[int]
    BOOLEAN_FIELD_NUMBER: _ClassVar[int]
    ARRAY_FIELD_NUMBER: _ClassVar[int]
    SET_FIELD_NUMBER: _ClassVar[int]
    MAP_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    null: KvNull
    integer: int
    bulk: bytes
    simple: str
    double: float
    boolean: bool
    array: KvReplyList
    set: KvReplyList
    map: KvReplyMap
    error: _common_pb2.ErrorDetail
    def __init__(self, null: _Optional[_Union[KvNull, _Mapping]] = ..., integer: _Optional[int] = ..., bulk: _Optional[bytes] = ..., simple: _Optional[str] = ..., double: _Optional[float] = ..., boolean: _Optional[bool] = ..., array: _Optional[_Union[KvReplyList, _Mapping]] = ..., set: _Optional[_Union[KvReplyList, _Mapping]] = ..., map: _Optional[_Union[KvReplyMap, _Mapping]] = ..., error: _Optional[_Union[_common_pb2.ErrorDetail, _Mapping]] = ...) -> None: ...

class KvNull(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class KvReplyList(_message.Message):
    __slots__ = ("items", "pairs")
    ITEMS_FIELD_NUMBER: _ClassVar[int]
    PAIRS_FIELD_NUMBER: _ClassVar[int]
    items: _containers.RepeatedCompositeFieldContainer[KvReply]
    pairs: bool
    def __init__(self, items: _Optional[_Iterable[_Union[KvReply, _Mapping]]] = ..., pairs: _Optional[bool] = ...) -> None: ...

class KvReplyMap(_message.Message):
    __slots__ = ("entries",)
    ENTRIES_FIELD_NUMBER: _ClassVar[int]
    entries: _containers.RepeatedCompositeFieldContainer[KvReplyPair]
    def __init__(self, entries: _Optional[_Iterable[_Union[KvReplyPair, _Mapping]]] = ...) -> None: ...

class KvReplyPair(_message.Message):
    __slots__ = ("key", "value")
    KEY_FIELD_NUMBER: _ClassVar[int]
    VALUE_FIELD_NUMBER: _ClassVar[int]
    key: KvReply
    value: KvReply
    def __init__(self, key: _Optional[_Union[KvReply, _Mapping]] = ..., value: _Optional[_Union[KvReply, _Mapping]] = ...) -> None: ...
