"""The shared offline scenario (test/scenarios/replica-offline.json), on the Python replica."""

from __future__ import annotations

import json
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from mindlog.sdk import EmbeddedReplica

from .conftest import ROOT, Node

pytestmark = pytest.mark.integration
SCENARIO = json.loads((ROOT / "test" / "scenarios" / "replica-offline.json").read_text())


def until(check: Callable[[], bool], what: str, timeout: float = 20) -> None:
    deadline = time.monotonic() + timeout
    while not check():
        if time.monotonic() > deadline:
            raise TimeoutError(f"timed out waiting for {what}")
        time.sleep(0.05)


def run_step(replica: EmbeddedReplica, node: Node, step: dict[str, Any]) -> None:
    user = SCENARIO["user"]
    direct = node.client().memory(user)

    def has(text: str) -> list[Any]:
        return [m for m in replica.list(user) if text in m.text]

    match step["do"]:
        case "waitOnline":
            until(lambda: replica.online, "the replica to connect")
        case "waitOffline":
            until(lambda: not replica.online, "the replica to notice the cut")
        case "waitDrained":
            until(lambda: replica.online and replica.queued == 0, "the queue to drain")
        case "waitLocal":
            until(lambda: bool(has(step["contains"])), step["contains"])
        case "cut":
            node.proxy.cut()
        case "restore":
            node.proxy.restore()
        case "remote":
            direct.remember(step["text"])
        case "remember":
            _, queued = replica.remember(user, step["text"])
            assert queued is step["queued"]
        case "recall":
            top = replica.recall(user, step["query"])[0]
            assert step["top"] in top.text
            if "pending" in step:
                assert top.pending is step["pending"]
        case "localOnce":
            replica.settled()
            found = has(step["contains"])
            assert len(found) == 1 and not found[0].pending
        case "serverOnce":
            memories = direct.list(limit=200)["memories"]
            assert sum(step["contains"] in m["text"] for m in memories) == 1
        case other:
            raise AssertionError(f"unknown step {other}")


def test_shared_offline_scenario(node: Node, tmp_path: Path) -> None:
    replica = EmbeddedReplica(
        node.client(through_proxy=True), str(tmp_path / "r.db"), [SCENARIO["user"]]
    )
    try:
        for step in SCENARIO["steps"]:
            run_step(replica, node, step)
    finally:
        replica.close()
