from google.protobuf.internal import containers as _containers
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class CacheEntry(_message.Message):
    __slots__ = ("id", "prompt", "vector", "embedding_model", "answer", "memory_deps", "created_at", "expires_at_ms", "model_hint")
    ID_FIELD_NUMBER: _ClassVar[int]
    PROMPT_FIELD_NUMBER: _ClassVar[int]
    VECTOR_FIELD_NUMBER: _ClassVar[int]
    EMBEDDING_MODEL_FIELD_NUMBER: _ClassVar[int]
    ANSWER_FIELD_NUMBER: _ClassVar[int]
    MEMORY_DEPS_FIELD_NUMBER: _ClassVar[int]
    CREATED_AT_FIELD_NUMBER: _ClassVar[int]
    EXPIRES_AT_MS_FIELD_NUMBER: _ClassVar[int]
    MODEL_HINT_FIELD_NUMBER: _ClassVar[int]
    id: str
    prompt: str
    vector: bytes
    embedding_model: str
    answer: str
    memory_deps: _containers.RepeatedScalarFieldContainer[str]
    created_at: int
    expires_at_ms: int
    model_hint: str
    def __init__(self, id: _Optional[str] = ..., prompt: _Optional[str] = ..., vector: _Optional[bytes] = ..., embedding_model: _Optional[str] = ..., answer: _Optional[str] = ..., memory_deps: _Optional[_Iterable[str]] = ..., created_at: _Optional[int] = ..., expires_at_ms: _Optional[int] = ..., model_hint: _Optional[str] = ...) -> None: ...

class CacheSet(_message.Message):
    __slots__ = ("user", "entry", "max_entries")
    USER_FIELD_NUMBER: _ClassVar[int]
    ENTRY_FIELD_NUMBER: _ClassVar[int]
    MAX_ENTRIES_FIELD_NUMBER: _ClassVar[int]
    user: str
    entry: CacheEntry
    max_entries: int
    def __init__(self, user: _Optional[str] = ..., entry: _Optional[_Union[CacheEntry, _Mapping]] = ..., max_entries: _Optional[int] = ...) -> None: ...

class CacheInvalidate(_message.Message):
    __slots__ = ("user", "ids")
    USER_FIELD_NUMBER: _ClassVar[int]
    IDS_FIELD_NUMBER: _ClassVar[int]
    user: str
    ids: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, user: _Optional[str] = ..., ids: _Optional[_Iterable[str]] = ...) -> None: ...
