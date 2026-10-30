from mindlog.v1 import cache_pb2 as _cache_pb2
from mindlog.v1 import common_pb2 as _common_pb2
from mindlog.v1 import jobs_pb2 as _jobs_pb2
from mindlog.v1 import kv_pb2 as _kv_pb2
from mindlog.v1 import memory_pb2 as _memory_pb2
from mindlog.v1 import pd_pb2 as _pd_pb2
from mindlog.v1 import range_pb2 as _range_pb2
from mindlog.v1 import txn_pb2 as _txn_pb2
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class Command(_message.Message):
    __slots__ = ("request_id", "principal", "hlc", "branch", "tenant", "kv_write", "kv_batch", "expire", "gc_threshold", "memory_commit", "memory_forget", "conflict_resolve", "memory_trust", "branch_create", "branch_merge", "branch_drop", "cache_set", "cache_invalidate", "txn_prewrite", "txn_commit", "txn_rollback", "txn_check", "job_lease", "job_complete", "split", "freeze", "merge", "pd_alloc_ids", "pd_put_node", "pd_put_range", "pd_remove_range", "pd_set_tso", "pd_set_version", "pd_record_operator")
    REQUEST_ID_FIELD_NUMBER: _ClassVar[int]
    PRINCIPAL_FIELD_NUMBER: _ClassVar[int]
    HLC_FIELD_NUMBER: _ClassVar[int]
    BRANCH_FIELD_NUMBER: _ClassVar[int]
    TENANT_FIELD_NUMBER: _ClassVar[int]
    KV_WRITE_FIELD_NUMBER: _ClassVar[int]
    KV_BATCH_FIELD_NUMBER: _ClassVar[int]
    EXPIRE_FIELD_NUMBER: _ClassVar[int]
    GC_THRESHOLD_FIELD_NUMBER: _ClassVar[int]
    MEMORY_COMMIT_FIELD_NUMBER: _ClassVar[int]
    MEMORY_FORGET_FIELD_NUMBER: _ClassVar[int]
    CONFLICT_RESOLVE_FIELD_NUMBER: _ClassVar[int]
    MEMORY_TRUST_FIELD_NUMBER: _ClassVar[int]
    BRANCH_CREATE_FIELD_NUMBER: _ClassVar[int]
    BRANCH_MERGE_FIELD_NUMBER: _ClassVar[int]
    BRANCH_DROP_FIELD_NUMBER: _ClassVar[int]
    CACHE_SET_FIELD_NUMBER: _ClassVar[int]
    CACHE_INVALIDATE_FIELD_NUMBER: _ClassVar[int]
    TXN_PREWRITE_FIELD_NUMBER: _ClassVar[int]
    TXN_COMMIT_FIELD_NUMBER: _ClassVar[int]
    TXN_ROLLBACK_FIELD_NUMBER: _ClassVar[int]
    TXN_CHECK_FIELD_NUMBER: _ClassVar[int]
    JOB_LEASE_FIELD_NUMBER: _ClassVar[int]
    JOB_COMPLETE_FIELD_NUMBER: _ClassVar[int]
    SPLIT_FIELD_NUMBER: _ClassVar[int]
    FREEZE_FIELD_NUMBER: _ClassVar[int]
    MERGE_FIELD_NUMBER: _ClassVar[int]
    PD_ALLOC_IDS_FIELD_NUMBER: _ClassVar[int]
    PD_PUT_NODE_FIELD_NUMBER: _ClassVar[int]
    PD_PUT_RANGE_FIELD_NUMBER: _ClassVar[int]
    PD_REMOVE_RANGE_FIELD_NUMBER: _ClassVar[int]
    PD_SET_TSO_FIELD_NUMBER: _ClassVar[int]
    PD_SET_VERSION_FIELD_NUMBER: _ClassVar[int]
    PD_RECORD_OPERATOR_FIELD_NUMBER: _ClassVar[int]
    request_id: bytes
    principal: str
    hlc: int
    branch: str
    tenant: str
    kv_write: _kv_pb2.KvWrite
    kv_batch: _kv_pb2.KvBatch
    expire: _kv_pb2.Expire
    gc_threshold: GcThreshold
    memory_commit: _memory_pb2.MemoryCommit
    memory_forget: _memory_pb2.MemoryForget
    conflict_resolve: _memory_pb2.ConflictResolve
    memory_trust: _memory_pb2.MemoryTrust
    branch_create: _memory_pb2.BranchCreate
    branch_merge: _memory_pb2.BranchMerge
    branch_drop: _memory_pb2.BranchDrop
    cache_set: _cache_pb2.CacheSet
    cache_invalidate: _cache_pb2.CacheInvalidate
    txn_prewrite: _txn_pb2.TxnPrewrite
    txn_commit: _txn_pb2.TxnCommit
    txn_rollback: _txn_pb2.TxnRollback
    txn_check: _txn_pb2.TxnCheck
    job_lease: _jobs_pb2.JobLease
    job_complete: _jobs_pb2.JobComplete
    split: _range_pb2.Split
    freeze: _range_pb2.Freeze
    merge: _range_pb2.Merge
    pd_alloc_ids: _pd_pb2.PdAllocIds
    pd_put_node: _pd_pb2.PdPutNode
    pd_put_range: _pd_pb2.PdPutRange
    pd_remove_range: _pd_pb2.PdRemoveRange
    pd_set_tso: _pd_pb2.PdSetTso
    pd_set_version: _pd_pb2.PdSetVersion
    pd_record_operator: _pd_pb2.PdRecordOperator
    def __init__(self, request_id: _Optional[bytes] = ..., principal: _Optional[str] = ..., hlc: _Optional[int] = ..., branch: _Optional[str] = ..., tenant: _Optional[str] = ..., kv_write: _Optional[_Union[_kv_pb2.KvWrite, _Mapping]] = ..., kv_batch: _Optional[_Union[_kv_pb2.KvBatch, _Mapping]] = ..., expire: _Optional[_Union[_kv_pb2.Expire, _Mapping]] = ..., gc_threshold: _Optional[_Union[GcThreshold, _Mapping]] = ..., memory_commit: _Optional[_Union[_memory_pb2.MemoryCommit, _Mapping]] = ..., memory_forget: _Optional[_Union[_memory_pb2.MemoryForget, _Mapping]] = ..., conflict_resolve: _Optional[_Union[_memory_pb2.ConflictResolve, _Mapping]] = ..., memory_trust: _Optional[_Union[_memory_pb2.MemoryTrust, _Mapping]] = ..., branch_create: _Optional[_Union[_memory_pb2.BranchCreate, _Mapping]] = ..., branch_merge: _Optional[_Union[_memory_pb2.BranchMerge, _Mapping]] = ..., branch_drop: _Optional[_Union[_memory_pb2.BranchDrop, _Mapping]] = ..., cache_set: _Optional[_Union[_cache_pb2.CacheSet, _Mapping]] = ..., cache_invalidate: _Optional[_Union[_cache_pb2.CacheInvalidate, _Mapping]] = ..., txn_prewrite: _Optional[_Union[_txn_pb2.TxnPrewrite, _Mapping]] = ..., txn_commit: _Optional[_Union[_txn_pb2.TxnCommit, _Mapping]] = ..., txn_rollback: _Optional[_Union[_txn_pb2.TxnRollback, _Mapping]] = ..., txn_check: _Optional[_Union[_txn_pb2.TxnCheck, _Mapping]] = ..., job_lease: _Optional[_Union[_jobs_pb2.JobLease, _Mapping]] = ..., job_complete: _Optional[_Union[_jobs_pb2.JobComplete, _Mapping]] = ..., split: _Optional[_Union[_range_pb2.Split, _Mapping]] = ..., freeze: _Optional[_Union[_range_pb2.Freeze, _Mapping]] = ..., merge: _Optional[_Union[_range_pb2.Merge, _Mapping]] = ..., pd_alloc_ids: _Optional[_Union[_pd_pb2.PdAllocIds, _Mapping]] = ..., pd_put_node: _Optional[_Union[_pd_pb2.PdPutNode, _Mapping]] = ..., pd_put_range: _Optional[_Union[_pd_pb2.PdPutRange, _Mapping]] = ..., pd_remove_range: _Optional[_Union[_pd_pb2.PdRemoveRange, _Mapping]] = ..., pd_set_tso: _Optional[_Union[_pd_pb2.PdSetTso, _Mapping]] = ..., pd_set_version: _Optional[_Union[_pd_pb2.PdSetVersion, _Mapping]] = ..., pd_record_operator: _Optional[_Union[_pd_pb2.PdRecordOperator, _Mapping]] = ...) -> None: ...

class GcThreshold(_message.Message):
    __slots__ = ("below_index", "limit", "below_version")
    BELOW_INDEX_FIELD_NUMBER: _ClassVar[int]
    LIMIT_FIELD_NUMBER: _ClassVar[int]
    BELOW_VERSION_FIELD_NUMBER: _ClassVar[int]
    below_index: int
    limit: int
    below_version: int
    def __init__(self, below_index: _Optional[int] = ..., limit: _Optional[int] = ..., below_version: _Optional[int] = ...) -> None: ...

class CommandResult(_message.Message):
    __slots__ = ("kv", "error", "txn", "memory", "job")
    KV_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    TXN_FIELD_NUMBER: _ClassVar[int]
    MEMORY_FIELD_NUMBER: _ClassVar[int]
    JOB_FIELD_NUMBER: _ClassVar[int]
    kv: _kv_pb2.KvReply
    error: _common_pb2.ErrorDetail
    txn: _txn_pb2.TxnOutcome
    memory: _memory_pb2.MemoryOutcome
    job: _jobs_pb2.JobOutcome
    def __init__(self, kv: _Optional[_Union[_kv_pb2.KvReply, _Mapping]] = ..., error: _Optional[_Union[_common_pb2.ErrorDetail, _Mapping]] = ..., txn: _Optional[_Union[_txn_pb2.TxnOutcome, _Mapping]] = ..., memory: _Optional[_Union[_memory_pb2.MemoryOutcome, _Mapping]] = ..., job: _Optional[_Union[_jobs_pb2.JobOutcome, _Mapping]] = ...) -> None: ...
