from google.protobuf.internal import containers as _containers
from google.protobuf.internal import enum_type_wrapper as _enum_type_wrapper
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class ReplicaRole(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    REPLICA_ROLE_UNSPECIFIED: _ClassVar[ReplicaRole]
    REPLICA_ROLE_VOTER: _ClassVar[ReplicaRole]
    REPLICA_ROLE_LEARNER: _ClassVar[ReplicaRole]
REPLICA_ROLE_UNSPECIFIED: ReplicaRole
REPLICA_ROLE_VOTER: ReplicaRole
REPLICA_ROLE_LEARNER: ReplicaRole

class RangeEpoch(_message.Message):
    __slots__ = ("conf_version", "version")
    CONF_VERSION_FIELD_NUMBER: _ClassVar[int]
    VERSION_FIELD_NUMBER: _ClassVar[int]
    conf_version: int
    version: int
    def __init__(self, conf_version: _Optional[int] = ..., version: _Optional[int] = ...) -> None: ...

class ReplicaDescriptor(_message.Message):
    __slots__ = ("node_id", "replica_id", "role")
    NODE_ID_FIELD_NUMBER: _ClassVar[int]
    REPLICA_ID_FIELD_NUMBER: _ClassVar[int]
    ROLE_FIELD_NUMBER: _ClassVar[int]
    node_id: int
    replica_id: int
    role: ReplicaRole
    def __init__(self, node_id: _Optional[int] = ..., replica_id: _Optional[int] = ..., role: _Optional[_Union[ReplicaRole, str]] = ...) -> None: ...

class RangeDescriptor(_message.Message):
    __slots__ = ("range_id", "start_key", "end_key", "epoch", "replicas")
    RANGE_ID_FIELD_NUMBER: _ClassVar[int]
    START_KEY_FIELD_NUMBER: _ClassVar[int]
    END_KEY_FIELD_NUMBER: _ClassVar[int]
    EPOCH_FIELD_NUMBER: _ClassVar[int]
    REPLICAS_FIELD_NUMBER: _ClassVar[int]
    range_id: int
    start_key: bytes
    end_key: bytes
    epoch: RangeEpoch
    replicas: _containers.RepeatedCompositeFieldContainer[ReplicaDescriptor]
    def __init__(self, range_id: _Optional[int] = ..., start_key: _Optional[bytes] = ..., end_key: _Optional[bytes] = ..., epoch: _Optional[_Union[RangeEpoch, _Mapping]] = ..., replicas: _Optional[_Iterable[_Union[ReplicaDescriptor, _Mapping]]] = ...) -> None: ...
