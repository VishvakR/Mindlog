from __future__ import annotations

import pytest
from mindlog.sdk import ClientError

from .conftest import Node

pytestmark = pytest.mark.integration


def test_memory_round_trip_and_request_ids(node: Node) -> None:
    memory = node.client().memory("bo")
    a = memory.remember("Bo plays the cello.", request_id="py-once")
    b = memory.remember("Bo plays the cello.", request_id="py-once")
    assert a["ids"] == b["ids"]
    assert [m["id"] for m in memory.get_many(a["ids"])] == a["ids"]
    assert memory.recall("cello")["items"][0]["memory"]["id"] == a["ids"][0]
    assert memory.forget(a["ids"])["count"] == 1
    assert memory.get(a["ids"][0])["expiredAtMs"] > 0  # type: ignore[index]


def test_errors_carry_the_problem(node: Node) -> None:
    with pytest.raises(ClientError) as e:
        node.client().memory("bo").get("")
    assert e.value.status == 400
