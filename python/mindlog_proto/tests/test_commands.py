from mindlog.v1 import commands_pb2, common_pb2

# Same Command as packages/proto/test/command-envelope.test.ts; both languages
# must produce these exact bytes (TS <-> Python wire compatibility, ADR-0004).
GOLDEN_HEX = (
    "0a 03 01 02 03 12 0d 61 67 65 6e 74 3a 70 6c 61 6e "
    "6e 65 72 18 87 80 80 80 cc 85 f2 cc 01 22 04 6d 61 69 6e"
)


def golden_command() -> commands_pb2.Command:
    return commands_pb2.Command(
        request_id=b"\x01\x02\x03",
        principal="agent:planner",
        hlc=(1_760_000_000_000 << 16) | 7,
        branch="main",
    )


def test_command_serializes_to_the_shared_golden_bytes() -> None:
    assert golden_command().SerializeToString().hex(" ") == GOLDEN_HEX


def test_command_round_trips_with_a_full_range_hlc() -> None:
    original = commands_pb2.Command(hlc=2**64 - 1, branch="feature-x")
    decoded = commands_pb2.Command.FromString(original.SerializeToString())
    assert decoded.hlc == 2**64 - 1
    assert decoded.branch == "feature-x"


def test_command_uses_body_numbers_10_to_13() -> None:
    numbers = {f.number for f in commands_pb2.Command.DESCRIPTOR.fields}
    assert numbers == {
        1,
        2,
        3,
        4,
        5,
        6,
        10,
        11,
        12,
        13,
        20,
        21,
        22,
        23,
        24,
        25,
        30,
        31,
        32,
        40,
        41,
        50,
        51,
        60,
        61,
        62,
        63,
        71,
        72,
        80,
        81,
        82,
        90,
        91,
        92,
        93,
        94,
        95,
        96,
    }


def test_command_with_kv_write_round_trips() -> None:
    cmd = commands_pb2.Command(tenant="acme")
    cmd.kv_write.argv.extend([b"INCR", b"n"])
    decoded = commands_pb2.Command.FromString(cmd.SerializeToString())
    assert decoded.WhichOneof("body") == "kv_write"
    assert list(decoded.kv_write.argv) == [b"INCR", b"n"]


def test_error_detail_carries_field_messages() -> None:
    detail = common_pb2.ErrorDetail(code="INVALID_ARGUMENT", fields={"scope.tenant": "required"})
    decoded = common_pb2.ErrorDetail.FromString(detail.SerializeToString())
    assert dict(decoded.fields) == {"scope.tenant": "required"}
