from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from typing import ClassVar as _ClassVar, Optional as _Optional

DESCRIPTOR: _descriptor.FileDescriptor

class Command(_message.Message):
    __slots__ = ("request_id", "principal", "hlc", "branch")
    REQUEST_ID_FIELD_NUMBER: _ClassVar[int]
    PRINCIPAL_FIELD_NUMBER: _ClassVar[int]
    HLC_FIELD_NUMBER: _ClassVar[int]
    BRANCH_FIELD_NUMBER: _ClassVar[int]
    request_id: bytes
    principal: str
    hlc: int
    branch: str
    def __init__(self, request_id: _Optional[bytes] = ..., principal: _Optional[str] = ..., hlc: _Optional[int] = ..., branch: _Optional[str] = ...) -> None: ...
