from mindlog.v1 import kv_pb2 as _kv_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf.internal import enum_type_wrapper as _enum_type_wrapper
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class TxnStatus(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    TXN_STATUS_UNSPECIFIED: _ClassVar[TxnStatus]
    TXN_STATUS_OK: _ClassVar[TxnStatus]
    TXN_STATUS_LOCKED: _ClassVar[TxnStatus]
    TXN_STATUS_CONFLICT: _ClassVar[TxnStatus]
    TXN_STATUS_COMMITTED: _ClassVar[TxnStatus]
    TXN_STATUS_ROLLED_BACK: _ClassVar[TxnStatus]
    TXN_STATUS_ABORTED: _ClassVar[TxnStatus]
TXN_STATUS_UNSPECIFIED: TxnStatus
TXN_STATUS_OK: TxnStatus
TXN_STATUS_LOCKED: TxnStatus
TXN_STATUS_CONFLICT: TxnStatus
TXN_STATUS_COMMITTED: TxnStatus
TXN_STATUS_ROLLED_BACK: TxnStatus
TXN_STATUS_ABORTED: TxnStatus

class TxnPrewrite(_message.Message):
    __slots__ = ("start_ts", "primary", "ttl_ms", "writes")
    START_TS_FIELD_NUMBER: _ClassVar[int]
    PRIMARY_FIELD_NUMBER: _ClassVar[int]
    TTL_MS_FIELD_NUMBER: _ClassVar[int]
    WRITES_FIELD_NUMBER: _ClassVar[int]
    start_ts: int
    primary: bytes
    ttl_ms: int
    writes: _containers.RepeatedCompositeFieldContainer[_kv_pb2.KvWrite]
    def __init__(self, start_ts: _Optional[int] = ..., primary: _Optional[bytes] = ..., ttl_ms: _Optional[int] = ..., writes: _Optional[_Iterable[_Union[_kv_pb2.KvWrite, _Mapping]]] = ...) -> None: ...

class TxnCommit(_message.Message):
    __slots__ = ("start_ts", "commit_ts", "keys", "primary")
    START_TS_FIELD_NUMBER: _ClassVar[int]
    COMMIT_TS_FIELD_NUMBER: _ClassVar[int]
    KEYS_FIELD_NUMBER: _ClassVar[int]
    PRIMARY_FIELD_NUMBER: _ClassVar[int]
    start_ts: int
    commit_ts: int
    keys: _containers.RepeatedScalarFieldContainer[bytes]
    primary: bytes
    def __init__(self, start_ts: _Optional[int] = ..., commit_ts: _Optional[int] = ..., keys: _Optional[_Iterable[bytes]] = ..., primary: _Optional[bytes] = ...) -> None: ...

class TxnRollback(_message.Message):
    __slots__ = ("start_ts", "keys")
    START_TS_FIELD_NUMBER: _ClassVar[int]
    KEYS_FIELD_NUMBER: _ClassVar[int]
    start_ts: int
    keys: _containers.RepeatedScalarFieldContainer[bytes]
    def __init__(self, start_ts: _Optional[int] = ..., keys: _Optional[_Iterable[bytes]] = ...) -> None: ...

class TxnCheck(_message.Message):
    __slots__ = ("start_ts", "primary")
    START_TS_FIELD_NUMBER: _ClassVar[int]
    PRIMARY_FIELD_NUMBER: _ClassVar[int]
    start_ts: int
    primary: bytes
    def __init__(self, start_ts: _Optional[int] = ..., primary: _Optional[bytes] = ...) -> None: ...

class TxnOutcome(_message.Message):
    __slots__ = ("status", "commit_ts", "locked_key", "locked_primary", "locked_start_ts", "replies")
    STATUS_FIELD_NUMBER: _ClassVar[int]
    COMMIT_TS_FIELD_NUMBER: _ClassVar[int]
    LOCKED_KEY_FIELD_NUMBER: _ClassVar[int]
    LOCKED_PRIMARY_FIELD_NUMBER: _ClassVar[int]
    LOCKED_START_TS_FIELD_NUMBER: _ClassVar[int]
    REPLIES_FIELD_NUMBER: _ClassVar[int]
    status: TxnStatus
    commit_ts: int
    locked_key: bytes
    locked_primary: bytes
    locked_start_ts: int
    replies: _containers.RepeatedCompositeFieldContainer[_kv_pb2.KvReply]
    def __init__(self, status: _Optional[_Union[TxnStatus, str]] = ..., commit_ts: _Optional[int] = ..., locked_key: _Optional[bytes] = ..., locked_primary: _Optional[bytes] = ..., locked_start_ts: _Optional[int] = ..., replies: _Optional[_Iterable[_Union[_kv_pb2.KvReply, _Mapping]]] = ...) -> None: ...

class TxnLock(_message.Message):
    __slots__ = ("start_ts", "primary", "ttl_ms", "locked_at_ms", "argv")
    START_TS_FIELD_NUMBER: _ClassVar[int]
    PRIMARY_FIELD_NUMBER: _ClassVar[int]
    TTL_MS_FIELD_NUMBER: _ClassVar[int]
    LOCKED_AT_MS_FIELD_NUMBER: _ClassVar[int]
    ARGV_FIELD_NUMBER: _ClassVar[int]
    start_ts: int
    primary: bytes
    ttl_ms: int
    locked_at_ms: int
    argv: _containers.RepeatedScalarFieldContainer[bytes]
    def __init__(self, start_ts: _Optional[int] = ..., primary: _Optional[bytes] = ..., ttl_ms: _Optional[int] = ..., locked_at_ms: _Optional[int] = ..., argv: _Optional[_Iterable[bytes]] = ...) -> None: ...
