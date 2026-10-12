from mindlog.v1 import kv_pb2


def test_header_round_trips_with_signed_list_bounds() -> None:
    header = kv_pb2.KvHeader(
        type=kv_pb2.KV_TYPE_LIST,
        generation=3,
        count=2,
        expire_at_ms=1_760_000_000_000,
        version=2**64 - 1,
        list_head=-5,
        list_tail=-3,
    )
    assert kv_pb2.KvHeader.FromString(header.SerializeToString()) == header


def test_reply_nests_arrays_and_maps() -> None:
    reply = kv_pb2.KvReply(
        array=kv_pb2.KvReplyList(
            items=[
                kv_pb2.KvReply(integer=-1),
                kv_pb2.KvReply(null=kv_pb2.KvNull()),
                kv_pb2.KvReply(
                    map=kv_pb2.KvReplyMap(
                        entries=[
                            kv_pb2.KvReplyPair(
                                key=kv_pb2.KvReply(bulk=b"f"),
                                value=kv_pb2.KvReply(double=1.5),
                            )
                        ]
                    )
                ),
            ]
        )
    )
    decoded = kv_pb2.KvReply.FromString(reply.SerializeToString())
    assert decoded == reply
    assert decoded.array.items[1].WhichOneof("kind") == "null"
