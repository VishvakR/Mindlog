from google.protobuf.internal import containers as _containers
from google.protobuf.internal import enum_type_wrapper as _enum_type_wrapper
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class EntryType(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    ENTRY_TYPE_UNSPECIFIED: _ClassVar[EntryType]
    ENTRY_TYPE_NORMAL: _ClassVar[EntryType]
    ENTRY_TYPE_CONF_CHANGE: _ClassVar[EntryType]

class ConfChangeType(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    CONF_CHANGE_TYPE_UNSPECIFIED: _ClassVar[ConfChangeType]
    CONF_CHANGE_TYPE_ADD_LEARNER: _ClassVar[ConfChangeType]
    CONF_CHANGE_TYPE_ADD_VOTER: _ClassVar[ConfChangeType]
    CONF_CHANGE_TYPE_REMOVE_NODE: _ClassVar[ConfChangeType]

class MessageType(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    MESSAGE_TYPE_UNSPECIFIED: _ClassVar[MessageType]
    MESSAGE_TYPE_PROPOSE: _ClassVar[MessageType]
    MESSAGE_TYPE_APPEND: _ClassVar[MessageType]
    MESSAGE_TYPE_APPEND_RESPONSE: _ClassVar[MessageType]
    MESSAGE_TYPE_VOTE: _ClassVar[MessageType]
    MESSAGE_TYPE_VOTE_RESPONSE: _ClassVar[MessageType]
    MESSAGE_TYPE_PRE_VOTE: _ClassVar[MessageType]
    MESSAGE_TYPE_PRE_VOTE_RESPONSE: _ClassVar[MessageType]
    MESSAGE_TYPE_HEARTBEAT: _ClassVar[MessageType]
    MESSAGE_TYPE_HEARTBEAT_RESPONSE: _ClassVar[MessageType]
    MESSAGE_TYPE_SNAPSHOT: _ClassVar[MessageType]
    MESSAGE_TYPE_TIMEOUT_NOW: _ClassVar[MessageType]
    MESSAGE_TYPE_READ_INDEX: _ClassVar[MessageType]
    MESSAGE_TYPE_READ_INDEX_RESPONSE: _ClassVar[MessageType]
ENTRY_TYPE_UNSPECIFIED: EntryType
ENTRY_TYPE_NORMAL: EntryType
ENTRY_TYPE_CONF_CHANGE: EntryType
CONF_CHANGE_TYPE_UNSPECIFIED: ConfChangeType
CONF_CHANGE_TYPE_ADD_LEARNER: ConfChangeType
CONF_CHANGE_TYPE_ADD_VOTER: ConfChangeType
CONF_CHANGE_TYPE_REMOVE_NODE: ConfChangeType
MESSAGE_TYPE_UNSPECIFIED: MessageType
MESSAGE_TYPE_PROPOSE: MessageType
MESSAGE_TYPE_APPEND: MessageType
MESSAGE_TYPE_APPEND_RESPONSE: MessageType
MESSAGE_TYPE_VOTE: MessageType
MESSAGE_TYPE_VOTE_RESPONSE: MessageType
MESSAGE_TYPE_PRE_VOTE: MessageType
MESSAGE_TYPE_PRE_VOTE_RESPONSE: MessageType
MESSAGE_TYPE_HEARTBEAT: MessageType
MESSAGE_TYPE_HEARTBEAT_RESPONSE: MessageType
MESSAGE_TYPE_SNAPSHOT: MessageType
MESSAGE_TYPE_TIMEOUT_NOW: MessageType
MESSAGE_TYPE_READ_INDEX: MessageType
MESSAGE_TYPE_READ_INDEX_RESPONSE: MessageType

class Entry(_message.Message):
    __slots__ = ("term", "index", "type", "data")
    TERM_FIELD_NUMBER: _ClassVar[int]
    INDEX_FIELD_NUMBER: _ClassVar[int]
    TYPE_FIELD_NUMBER: _ClassVar[int]
    DATA_FIELD_NUMBER: _ClassVar[int]
    term: int
    index: int
    type: EntryType
    data: bytes
    def __init__(self, term: _Optional[int] = ..., index: _Optional[int] = ..., type: _Optional[_Union[EntryType, str]] = ..., data: _Optional[bytes] = ...) -> None: ...

class HardState(_message.Message):
    __slots__ = ("term", "vote", "commit")
    TERM_FIELD_NUMBER: _ClassVar[int]
    VOTE_FIELD_NUMBER: _ClassVar[int]
    COMMIT_FIELD_NUMBER: _ClassVar[int]
    term: int
    vote: int
    commit: int
    def __init__(self, term: _Optional[int] = ..., vote: _Optional[int] = ..., commit: _Optional[int] = ...) -> None: ...

class TruncatedState(_message.Message):
    __slots__ = ("index", "term")
    INDEX_FIELD_NUMBER: _ClassVar[int]
    TERM_FIELD_NUMBER: _ClassVar[int]
    index: int
    term: int
    def __init__(self, index: _Optional[int] = ..., term: _Optional[int] = ...) -> None: ...

class ConfState(_message.Message):
    __slots__ = ("voters", "learners", "addresses")
    class AddressesEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: int
        value: str
        def __init__(self, key: _Optional[int] = ..., value: _Optional[str] = ...) -> None: ...
    VOTERS_FIELD_NUMBER: _ClassVar[int]
    LEARNERS_FIELD_NUMBER: _ClassVar[int]
    ADDRESSES_FIELD_NUMBER: _ClassVar[int]
    voters: _containers.RepeatedScalarFieldContainer[int]
    learners: _containers.RepeatedScalarFieldContainer[int]
    addresses: _containers.ScalarMap[int, str]
    def __init__(self, voters: _Optional[_Iterable[int]] = ..., learners: _Optional[_Iterable[int]] = ..., addresses: _Optional[_Mapping[int, str]] = ...) -> None: ...

class ConfChange(_message.Message):
    __slots__ = ("type", "node_id", "address")
    TYPE_FIELD_NUMBER: _ClassVar[int]
    NODE_ID_FIELD_NUMBER: _ClassVar[int]
    ADDRESS_FIELD_NUMBER: _ClassVar[int]
    type: ConfChangeType
    node_id: int
    address: str
    def __init__(self, type: _Optional[_Union[ConfChangeType, str]] = ..., node_id: _Optional[int] = ..., address: _Optional[str] = ...) -> None: ...

class SnapshotMeta(_message.Message):
    __slots__ = ("index", "term", "conf_state")
    INDEX_FIELD_NUMBER: _ClassVar[int]
    TERM_FIELD_NUMBER: _ClassVar[int]
    CONF_STATE_FIELD_NUMBER: _ClassVar[int]
    index: int
    term: int
    conf_state: ConfState
    def __init__(self, index: _Optional[int] = ..., term: _Optional[int] = ..., conf_state: _Optional[_Union[ConfState, _Mapping]] = ...) -> None: ...

class Message(_message.Message):
    __slots__ = ("type", "to", "term", "log_term", "index", "entries", "commit", "reject", "reject_hint", "snapshot", "context", "range_id", "lease_tick", "quiesce")
    TYPE_FIELD_NUMBER: _ClassVar[int]
    FROM_FIELD_NUMBER: _ClassVar[int]
    TO_FIELD_NUMBER: _ClassVar[int]
    TERM_FIELD_NUMBER: _ClassVar[int]
    LOG_TERM_FIELD_NUMBER: _ClassVar[int]
    INDEX_FIELD_NUMBER: _ClassVar[int]
    ENTRIES_FIELD_NUMBER: _ClassVar[int]
    COMMIT_FIELD_NUMBER: _ClassVar[int]
    REJECT_FIELD_NUMBER: _ClassVar[int]
    REJECT_HINT_FIELD_NUMBER: _ClassVar[int]
    SNAPSHOT_FIELD_NUMBER: _ClassVar[int]
    CONTEXT_FIELD_NUMBER: _ClassVar[int]
    RANGE_ID_FIELD_NUMBER: _ClassVar[int]
    LEASE_TICK_FIELD_NUMBER: _ClassVar[int]
    QUIESCE_FIELD_NUMBER: _ClassVar[int]
    type: MessageType
    to: int
    term: int
    log_term: int
    index: int
    entries: _containers.RepeatedCompositeFieldContainer[Entry]
    commit: int
    reject: bool
    reject_hint: int
    snapshot: SnapshotMeta
    context: bytes
    range_id: int
    lease_tick: int
    quiesce: bool
    def __init__(self, type: _Optional[_Union[MessageType, str]] = ..., to: _Optional[int] = ..., term: _Optional[int] = ..., log_term: _Optional[int] = ..., index: _Optional[int] = ..., entries: _Optional[_Iterable[_Union[Entry, _Mapping]]] = ..., commit: _Optional[int] = ..., reject: _Optional[bool] = ..., reject_hint: _Optional[int] = ..., snapshot: _Optional[_Union[SnapshotMeta, _Mapping]] = ..., context: _Optional[bytes] = ..., range_id: _Optional[int] = ..., lease_tick: _Optional[int] = ..., quiesce: _Optional[bool] = ..., **kwargs) -> None: ...

class KeyValue(_message.Message):
    __slots__ = ("key", "value")
    KEY_FIELD_NUMBER: _ClassVar[int]
    VALUE_FIELD_NUMBER: _ClassVar[int]
    key: bytes
    value: bytes
    def __init__(self, key: _Optional[bytes] = ..., value: _Optional[bytes] = ...) -> None: ...

class SendRequest(_message.Message):
    __slots__ = ("messages", "from_address")
    MESSAGES_FIELD_NUMBER: _ClassVar[int]
    FROM_ADDRESS_FIELD_NUMBER: _ClassVar[int]
    messages: _containers.RepeatedCompositeFieldContainer[Message]
    from_address: str
    def __init__(self, messages: _Optional[_Iterable[_Union[Message, _Mapping]]] = ..., from_address: _Optional[str] = ...) -> None: ...

class SendResponse(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class SnapshotRequest(_message.Message):
    __slots__ = ("message", "pairs")
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    PAIRS_FIELD_NUMBER: _ClassVar[int]
    message: Message
    pairs: _containers.RepeatedCompositeFieldContainer[KeyValue]
    def __init__(self, message: _Optional[_Union[Message, _Mapping]] = ..., pairs: _Optional[_Iterable[_Union[KeyValue, _Mapping]]] = ...) -> None: ...

class SnapshotResponse(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...
