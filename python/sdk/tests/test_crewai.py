from __future__ import annotations

import pytest
from mindlog.sdk.crewai import MindlogCrewStorage

from .conftest import Node

pytestmark = pytest.mark.integration


def test_save_search_reset(node: Node) -> None:
    storage = MindlogCrewStorage(node.client(), user="crew")
    storage.save("The release is planned for March.", {"agent": "planner"})
    storage.save("Lunch is at noon.", {"agent": "chef"})
    hits = storage.search("when is the release", limit=2, score_threshold=0.5)
    assert hits[0]["context"] == "The release is planned for March."
    assert hits[0]["metadata"] == {"agent": "planner"}
    storage.reset()
    assert storage.search("release", limit=3) == []
