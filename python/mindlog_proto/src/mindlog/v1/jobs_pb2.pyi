from google.protobuf.internal import enum_type_wrapper as _enum_type_wrapper
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class JobState(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    JOB_STATE_UNSPECIFIED: _ClassVar[JobState]
    JOB_STATE_QUEUED: _ClassVar[JobState]
    JOB_STATE_LEASED: _ClassVar[JobState]
    JOB_STATE_DONE: _ClassVar[JobState]
    JOB_STATE_DEAD: _ClassVar[JobState]
JOB_STATE_UNSPECIFIED: JobState
JOB_STATE_QUEUED: JobState
JOB_STATE_LEASED: JobState
JOB_STATE_DONE: JobState
JOB_STATE_DEAD: JobState

class JobSpec(_message.Message):
    __slots__ = ("id", "kind", "payload", "run_at_ms")
    ID_FIELD_NUMBER: _ClassVar[int]
    KIND_FIELD_NUMBER: _ClassVar[int]
    PAYLOAD_FIELD_NUMBER: _ClassVar[int]
    RUN_AT_MS_FIELD_NUMBER: _ClassVar[int]
    id: str
    kind: str
    payload: bytes
    run_at_ms: int
    def __init__(self, id: _Optional[str] = ..., kind: _Optional[str] = ..., payload: _Optional[bytes] = ..., run_at_ms: _Optional[int] = ...) -> None: ...

class Job(_message.Message):
    __slots__ = ("id", "kind", "payload", "state", "attempts", "run_at_ms", "lease_until_ms", "error", "created_at", "deferrals")
    ID_FIELD_NUMBER: _ClassVar[int]
    KIND_FIELD_NUMBER: _ClassVar[int]
    PAYLOAD_FIELD_NUMBER: _ClassVar[int]
    STATE_FIELD_NUMBER: _ClassVar[int]
    ATTEMPTS_FIELD_NUMBER: _ClassVar[int]
    RUN_AT_MS_FIELD_NUMBER: _ClassVar[int]
    LEASE_UNTIL_MS_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    CREATED_AT_FIELD_NUMBER: _ClassVar[int]
    DEFERRALS_FIELD_NUMBER: _ClassVar[int]
    id: str
    kind: str
    payload: bytes
    state: JobState
    attempts: int
    run_at_ms: int
    lease_until_ms: int
    error: str
    created_at: int
    deferrals: int
    def __init__(self, id: _Optional[str] = ..., kind: _Optional[str] = ..., payload: _Optional[bytes] = ..., state: _Optional[_Union[JobState, str]] = ..., attempts: _Optional[int] = ..., run_at_ms: _Optional[int] = ..., lease_until_ms: _Optional[int] = ..., error: _Optional[str] = ..., created_at: _Optional[int] = ..., deferrals: _Optional[int] = ...) -> None: ...

class JobLease(_message.Message):
    __slots__ = ("user", "id", "lease_ms")
    USER_FIELD_NUMBER: _ClassVar[int]
    ID_FIELD_NUMBER: _ClassVar[int]
    LEASE_MS_FIELD_NUMBER: _ClassVar[int]
    user: str
    id: str
    lease_ms: int
    def __init__(self, user: _Optional[str] = ..., id: _Optional[str] = ..., lease_ms: _Optional[int] = ...) -> None: ...

class JobComplete(_message.Message):
    __slots__ = ("user", "id", "attempt", "error", "defer_until_ms")
    USER_FIELD_NUMBER: _ClassVar[int]
    ID_FIELD_NUMBER: _ClassVar[int]
    ATTEMPT_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    DEFER_UNTIL_MS_FIELD_NUMBER: _ClassVar[int]
    user: str
    id: str
    attempt: int
    error: str
    defer_until_ms: int
    def __init__(self, user: _Optional[str] = ..., id: _Optional[str] = ..., attempt: _Optional[int] = ..., error: _Optional[str] = ..., defer_until_ms: _Optional[int] = ...) -> None: ...

class JobOutcome(_message.Message):
    __slots__ = ("attempt", "state")
    ATTEMPT_FIELD_NUMBER: _ClassVar[int]
    STATE_FIELD_NUMBER: _ClassVar[int]
    attempt: int
    state: JobState
    def __init__(self, attempt: _Optional[int] = ..., state: _Optional[_Union[JobState, str]] = ...) -> None: ...
