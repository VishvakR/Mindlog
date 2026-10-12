from mindlog.v1 import common_pb2 as _common_pb2
from mindlog.v1 import kv_pb2 as _kv_pb2
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class Command(_message.Message):
    __slots__ = ("request_id", "principal", "hlc", "branch", "tenant", "kv_write", "kv_batch", "expire", "gc_threshold")
    REQUEST_ID_FIELD_NUMBER: _ClassVar[int]
    PRINCIPAL_FIELD_NUMBER: _ClassVar[int]
    HLC_FIELD_NUMBER: _ClassVar[int]
    BRANCH_FIELD_NUMBER: _ClassVar[int]
    TENANT_FIELD_NUMBER: _ClassVar[int]
    KV_WRITE_FIELD_NUMBER: _ClassVar[int]
    KV_BATCH_FIELD_NUMBER: _ClassVar[int]
    EXPIRE_FIELD_NUMBER: _ClassVar[int]
    GC_THRESHOLD_FIELD_NUMBER: _ClassVar[int]
    request_id: bytes
    principal: str
    hlc: int
    branch: str
    tenant: str
    kv_write: _kv_pb2.KvWrite
    kv_batch: _kv_pb2.KvBatch
    expire: _kv_pb2.Expire
    gc_threshold: GcThreshold
    def __init__(self, request_id: _Optional[bytes] = ..., principal: _Optional[str] = ..., hlc: _Optional[int] = ..., branch: _Optional[str] = ..., tenant: _Optional[str] = ..., kv_write: _Optional[_Union[_kv_pb2.KvWrite, _Mapping]] = ..., kv_batch: _Optional[_Union[_kv_pb2.KvBatch, _Mapping]] = ..., expire: _Optional[_Union[_kv_pb2.Expire, _Mapping]] = ..., gc_threshold: _Optional[_Union[GcThreshold, _Mapping]] = ...) -> None: ...

class GcThreshold(_message.Message):
    __slots__ = ("below_index", "limit")
    BELOW_INDEX_FIELD_NUMBER: _ClassVar[int]
    LIMIT_FIELD_NUMBER: _ClassVar[int]
    below_index: int
    limit: int
    def __init__(self, below_index: _Optional[int] = ..., limit: _Optional[int] = ...) -> None: ...

class CommandResult(_message.Message):
    __slots__ = ("kv", "error")
    KV_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    kv: _kv_pb2.KvReply
    error: _common_pb2.ErrorDetail
    def __init__(self, kv: _Optional[_Union[_kv_pb2.KvReply, _Mapping]] = ..., error: _Optional[_Union[_common_pb2.ErrorDetail, _Mapping]] = ...) -> None: ...
