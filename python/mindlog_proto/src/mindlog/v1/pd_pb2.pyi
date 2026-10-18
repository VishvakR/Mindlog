from mindlog.v1 import range_pb2 as _range_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf.internal import enum_type_wrapper as _enum_type_wrapper
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class NodeState(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    NODE_STATE_UNSPECIFIED: _ClassVar[NodeState]
    NODE_STATE_JOINING: _ClassVar[NodeState]
    NODE_STATE_LIVE: _ClassVar[NodeState]
    NODE_STATE_SUSPECT: _ClassVar[NodeState]
    NODE_STATE_DEAD: _ClassVar[NodeState]
    NODE_STATE_DRAINING: _ClassVar[NodeState]
    NODE_STATE_DECOMMISSIONED: _ClassVar[NodeState]

class StepKind(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    STEP_KIND_UNSPECIFIED: _ClassVar[StepKind]
    STEP_KIND_ADD_LEARNER: _ClassVar[StepKind]
    STEP_KIND_PROMOTE: _ClassVar[StepKind]
    STEP_KIND_TRANSFER_LEADER: _ClassVar[StepKind]
    STEP_KIND_REMOVE_VOTER: _ClassVar[StepKind]
    STEP_KIND_SPLIT: _ClassVar[StepKind]
    STEP_KIND_MERGE: _ClassVar[StepKind]
NODE_STATE_UNSPECIFIED: NodeState
NODE_STATE_JOINING: NodeState
NODE_STATE_LIVE: NodeState
NODE_STATE_SUSPECT: NodeState
NODE_STATE_DEAD: NodeState
NODE_STATE_DRAINING: NodeState
NODE_STATE_DECOMMISSIONED: NodeState
STEP_KIND_UNSPECIFIED: StepKind
STEP_KIND_ADD_LEARNER: StepKind
STEP_KIND_PROMOTE: StepKind
STEP_KIND_TRANSFER_LEADER: StepKind
STEP_KIND_REMOVE_VOTER: StepKind
STEP_KIND_SPLIT: StepKind
STEP_KIND_MERGE: StepKind

class NodeInfo(_message.Message):
    __slots__ = ("node_id", "address", "zone", "state", "binary_version", "labels")
    NODE_ID_FIELD_NUMBER: _ClassVar[int]
    ADDRESS_FIELD_NUMBER: _ClassVar[int]
    ZONE_FIELD_NUMBER: _ClassVar[int]
    STATE_FIELD_NUMBER: _ClassVar[int]
    BINARY_VERSION_FIELD_NUMBER: _ClassVar[int]
    LABELS_FIELD_NUMBER: _ClassVar[int]
    node_id: int
    address: str
    zone: str
    state: NodeState
    binary_version: int
    labels: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, node_id: _Optional[int] = ..., address: _Optional[str] = ..., zone: _Optional[str] = ..., state: _Optional[_Union[NodeState, str]] = ..., binary_version: _Optional[int] = ..., labels: _Optional[_Iterable[str]] = ...) -> None: ...

class PdAllocIds(_message.Message):
    __slots__ = ("count",)
    COUNT_FIELD_NUMBER: _ClassVar[int]
    count: int
    def __init__(self, count: _Optional[int] = ...) -> None: ...

class PdPutNode(_message.Message):
    __slots__ = ("node",)
    NODE_FIELD_NUMBER: _ClassVar[int]
    node: NodeInfo
    def __init__(self, node: _Optional[_Union[NodeInfo, _Mapping]] = ...) -> None: ...

class PdPutRange(_message.Message):
    __slots__ = ("range",)
    RANGE_FIELD_NUMBER: _ClassVar[int]
    range: _range_pb2.RangeDescriptor
    def __init__(self, range: _Optional[_Union[_range_pb2.RangeDescriptor, _Mapping]] = ...) -> None: ...

class PdRemoveRange(_message.Message):
    __slots__ = ("range_id",)
    RANGE_ID_FIELD_NUMBER: _ClassVar[int]
    range_id: int
    def __init__(self, range_id: _Optional[int] = ...) -> None: ...

class PdSetTso(_message.Message):
    __slots__ = ("max",)
    MAX_FIELD_NUMBER: _ClassVar[int]
    max: int
    def __init__(self, max: _Optional[int] = ...) -> None: ...

class PdSetVersion(_message.Message):
    __slots__ = ("version",)
    VERSION_FIELD_NUMBER: _ClassVar[int]
    version: int
    def __init__(self, version: _Optional[int] = ...) -> None: ...

class PdRecordOperator(_message.Message):
    __slots__ = ("operator",)
    OPERATOR_FIELD_NUMBER: _ClassVar[int]
    operator: Operator
    def __init__(self, operator: _Optional[_Union[Operator, _Mapping]] = ...) -> None: ...

class OperatorStep(_message.Message):
    __slots__ = ("kind", "replica_id", "node_id", "address", "new_range_id")
    KIND_FIELD_NUMBER: _ClassVar[int]
    REPLICA_ID_FIELD_NUMBER: _ClassVar[int]
    NODE_ID_FIELD_NUMBER: _ClassVar[int]
    ADDRESS_FIELD_NUMBER: _ClassVar[int]
    NEW_RANGE_ID_FIELD_NUMBER: _ClassVar[int]
    kind: StepKind
    replica_id: int
    node_id: int
    address: str
    new_range_id: int
    def __init__(self, kind: _Optional[_Union[StepKind, str]] = ..., replica_id: _Optional[int] = ..., node_id: _Optional[int] = ..., address: _Optional[str] = ..., new_range_id: _Optional[int] = ...) -> None: ...

class Operator(_message.Message):
    __slots__ = ("id", "range_id", "scheduler", "steps", "step", "explanation", "created_ms", "status")
    ID_FIELD_NUMBER: _ClassVar[int]
    RANGE_ID_FIELD_NUMBER: _ClassVar[int]
    SCHEDULER_FIELD_NUMBER: _ClassVar[int]
    STEPS_FIELD_NUMBER: _ClassVar[int]
    STEP_FIELD_NUMBER: _ClassVar[int]
    EXPLANATION_FIELD_NUMBER: _ClassVar[int]
    CREATED_MS_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    id: int
    range_id: int
    scheduler: str
    steps: _containers.RepeatedCompositeFieldContainer[OperatorStep]
    step: int
    explanation: str
    created_ms: int
    status: str
    def __init__(self, id: _Optional[int] = ..., range_id: _Optional[int] = ..., scheduler: _Optional[str] = ..., steps: _Optional[_Iterable[_Union[OperatorStep, _Mapping]]] = ..., step: _Optional[int] = ..., explanation: _Optional[str] = ..., created_ms: _Optional[int] = ..., status: _Optional[str] = ...) -> None: ...

class StoreStats(_message.Message):
    __slots__ = ("node", "capacity_bytes", "used_bytes", "range_count", "leader_count", "qps", "cpu")
    NODE_FIELD_NUMBER: _ClassVar[int]
    CAPACITY_BYTES_FIELD_NUMBER: _ClassVar[int]
    USED_BYTES_FIELD_NUMBER: _ClassVar[int]
    RANGE_COUNT_FIELD_NUMBER: _ClassVar[int]
    LEADER_COUNT_FIELD_NUMBER: _ClassVar[int]
    QPS_FIELD_NUMBER: _ClassVar[int]
    CPU_FIELD_NUMBER: _ClassVar[int]
    node: NodeInfo
    capacity_bytes: int
    used_bytes: int
    range_count: int
    leader_count: int
    qps: float
    cpu: float
    def __init__(self, node: _Optional[_Union[NodeInfo, _Mapping]] = ..., capacity_bytes: _Optional[int] = ..., used_bytes: _Optional[int] = ..., range_count: _Optional[int] = ..., leader_count: _Optional[int] = ..., qps: _Optional[float] = ..., cpu: _Optional[float] = ...) -> None: ...

class FollowerProgress(_message.Message):
    __slots__ = ("replica_id", "match")
    REPLICA_ID_FIELD_NUMBER: _ClassVar[int]
    MATCH_FIELD_NUMBER: _ClassVar[int]
    replica_id: int
    match: int
    def __init__(self, replica_id: _Optional[int] = ..., match: _Optional[int] = ...) -> None: ...

class RangeStats(_message.Message):
    __slots__ = ("range", "leader_replica_id", "bytes", "qps", "followers", "learners", "applied")
    RANGE_FIELD_NUMBER: _ClassVar[int]
    LEADER_REPLICA_ID_FIELD_NUMBER: _ClassVar[int]
    BYTES_FIELD_NUMBER: _ClassVar[int]
    QPS_FIELD_NUMBER: _ClassVar[int]
    FOLLOWERS_FIELD_NUMBER: _ClassVar[int]
    LEARNERS_FIELD_NUMBER: _ClassVar[int]
    APPLIED_FIELD_NUMBER: _ClassVar[int]
    range: _range_pb2.RangeDescriptor
    leader_replica_id: int
    bytes: int
    qps: float
    followers: _containers.RepeatedCompositeFieldContainer[FollowerProgress]
    learners: _containers.RepeatedScalarFieldContainer[int]
    applied: int
    def __init__(self, range: _Optional[_Union[_range_pb2.RangeDescriptor, _Mapping]] = ..., leader_replica_id: _Optional[int] = ..., bytes: _Optional[int] = ..., qps: _Optional[float] = ..., followers: _Optional[_Iterable[_Union[FollowerProgress, _Mapping]]] = ..., learners: _Optional[_Iterable[int]] = ..., applied: _Optional[int] = ...) -> None: ...

class AllocIdsRequest(_message.Message):
    __slots__ = ("count",)
    COUNT_FIELD_NUMBER: _ClassVar[int]
    count: int
    def __init__(self, count: _Optional[int] = ...) -> None: ...

class AllocIdsResponse(_message.Message):
    __slots__ = ("first",)
    FIRST_FIELD_NUMBER: _ClassVar[int]
    first: int
    def __init__(self, first: _Optional[int] = ...) -> None: ...

class TsoRequest(_message.Message):
    __slots__ = ("count",)
    COUNT_FIELD_NUMBER: _ClassVar[int]
    count: int
    def __init__(self, count: _Optional[int] = ...) -> None: ...

class TsoResponse(_message.Message):
    __slots__ = ("last",)
    LAST_FIELD_NUMBER: _ClassVar[int]
    last: int
    def __init__(self, last: _Optional[int] = ...) -> None: ...

class GetRangeRequest(_message.Message):
    __slots__ = ("key",)
    KEY_FIELD_NUMBER: _ClassVar[int]
    key: bytes
    def __init__(self, key: _Optional[bytes] = ...) -> None: ...

class GetRangeResponse(_message.Message):
    __slots__ = ("range", "leader_replica_id")
    RANGE_FIELD_NUMBER: _ClassVar[int]
    LEADER_REPLICA_ID_FIELD_NUMBER: _ClassVar[int]
    range: _range_pb2.RangeDescriptor
    leader_replica_id: int
    def __init__(self, range: _Optional[_Union[_range_pb2.RangeDescriptor, _Mapping]] = ..., leader_replica_id: _Optional[int] = ...) -> None: ...

class ScanRangesRequest(_message.Message):
    __slots__ = ("start_key", "limit")
    START_KEY_FIELD_NUMBER: _ClassVar[int]
    LIMIT_FIELD_NUMBER: _ClassVar[int]
    start_key: bytes
    limit: int
    def __init__(self, start_key: _Optional[bytes] = ..., limit: _Optional[int] = ...) -> None: ...

class ScanRangesResponse(_message.Message):
    __slots__ = ("ranges",)
    RANGES_FIELD_NUMBER: _ClassVar[int]
    ranges: _containers.RepeatedCompositeFieldContainer[_range_pb2.RangeDescriptor]
    def __init__(self, ranges: _Optional[_Iterable[_Union[_range_pb2.RangeDescriptor, _Mapping]]] = ...) -> None: ...

class StoreHeartbeatRequest(_message.Message):
    __slots__ = ("stats",)
    STATS_FIELD_NUMBER: _ClassVar[int]
    stats: StoreStats
    def __init__(self, stats: _Optional[_Union[StoreStats, _Mapping]] = ...) -> None: ...

class StoreHeartbeatResponse(_message.Message):
    __slots__ = ("cluster_version", "nodes")
    CLUSTER_VERSION_FIELD_NUMBER: _ClassVar[int]
    NODES_FIELD_NUMBER: _ClassVar[int]
    cluster_version: int
    nodes: _containers.RepeatedCompositeFieldContainer[NodeInfo]
    def __init__(self, cluster_version: _Optional[int] = ..., nodes: _Optional[_Iterable[_Union[NodeInfo, _Mapping]]] = ...) -> None: ...

class RangeHeartbeatRequest(_message.Message):
    __slots__ = ("stats",)
    STATS_FIELD_NUMBER: _ClassVar[int]
    stats: RangeStats
    def __init__(self, stats: _Optional[_Union[RangeStats, _Mapping]] = ...) -> None: ...

class RangeHeartbeatResponse(_message.Message):
    __slots__ = ("operator",)
    OPERATOR_FIELD_NUMBER: _ClassVar[int]
    operator: Operator
    def __init__(self, operator: _Optional[_Union[Operator, _Mapping]] = ...) -> None: ...

class ClusterRequest(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class ClusterResponse(_message.Message):
    __slots__ = ("nodes", "stores", "ranges", "operators", "recent", "cluster_version")
    NODES_FIELD_NUMBER: _ClassVar[int]
    STORES_FIELD_NUMBER: _ClassVar[int]
    RANGES_FIELD_NUMBER: _ClassVar[int]
    OPERATORS_FIELD_NUMBER: _ClassVar[int]
    RECENT_FIELD_NUMBER: _ClassVar[int]
    CLUSTER_VERSION_FIELD_NUMBER: _ClassVar[int]
    nodes: _containers.RepeatedCompositeFieldContainer[NodeInfo]
    stores: _containers.RepeatedCompositeFieldContainer[StoreStats]
    ranges: _containers.RepeatedCompositeFieldContainer[_range_pb2.RangeDescriptor]
    operators: _containers.RepeatedCompositeFieldContainer[Operator]
    recent: _containers.RepeatedCompositeFieldContainer[Operator]
    cluster_version: int
    def __init__(self, nodes: _Optional[_Iterable[_Union[NodeInfo, _Mapping]]] = ..., stores: _Optional[_Iterable[_Union[StoreStats, _Mapping]]] = ..., ranges: _Optional[_Iterable[_Union[_range_pb2.RangeDescriptor, _Mapping]]] = ..., operators: _Optional[_Iterable[_Union[Operator, _Mapping]]] = ..., recent: _Optional[_Iterable[_Union[Operator, _Mapping]]] = ..., cluster_version: _Optional[int] = ...) -> None: ...

class AdminRequest(_message.Message):
    __slots__ = ("drain_node", "undrain_node", "transfer_leader", "split", "remove_node")
    DRAIN_NODE_FIELD_NUMBER: _ClassVar[int]
    UNDRAIN_NODE_FIELD_NUMBER: _ClassVar[int]
    TRANSFER_LEADER_FIELD_NUMBER: _ClassVar[int]
    SPLIT_FIELD_NUMBER: _ClassVar[int]
    REMOVE_NODE_FIELD_NUMBER: _ClassVar[int]
    drain_node: int
    undrain_node: int
    transfer_leader: TransferLeaderAction
    split: SplitAction
    remove_node: int
    def __init__(self, drain_node: _Optional[int] = ..., undrain_node: _Optional[int] = ..., transfer_leader: _Optional[_Union[TransferLeaderAction, _Mapping]] = ..., split: _Optional[_Union[SplitAction, _Mapping]] = ..., remove_node: _Optional[int] = ...) -> None: ...

class TransferLeaderAction(_message.Message):
    __slots__ = ("range_id", "replica_id")
    RANGE_ID_FIELD_NUMBER: _ClassVar[int]
    REPLICA_ID_FIELD_NUMBER: _ClassVar[int]
    range_id: int
    replica_id: int
    def __init__(self, range_id: _Optional[int] = ..., replica_id: _Optional[int] = ...) -> None: ...

class SplitAction(_message.Message):
    __slots__ = ("range_id",)
    RANGE_ID_FIELD_NUMBER: _ClassVar[int]
    range_id: int
    def __init__(self, range_id: _Optional[int] = ...) -> None: ...

class AdminResponse(_message.Message):
    __slots__ = ("message",)
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    message: str
    def __init__(self, message: _Optional[str] = ...) -> None: ...
