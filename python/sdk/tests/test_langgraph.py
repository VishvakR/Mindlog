from __future__ import annotations

from typing import TypedDict

import pytest

from .conftest import Node

pytestmark = pytest.mark.integration
langgraph = pytest.importorskip("langgraph")


def test_store_put_get_search_delete(node: Node) -> None:
    from mindlog.sdk.langgraph import MindlogStore

    store = MindlogStore(node.client(), user="lg")
    store.put(("users", "ann"), "food", {"likes": "green tea and dumplings"})
    store.put(("users", "ann"), "travel", {"likes": "night trains"})
    assert store.get(("users", "ann"), "food").value == {"likes": "green tea and dumplings"}  # type: ignore[union-attr]
    # The test node has no models: recall is keyword only, so the query shares words with the value.
    hits = store.search(("users",), query="green tea", limit=1)
    assert hits[0].key == "food"
    assert {i.key for i in store.search(("users", "ann"))} == {"food", "travel"}
    assert store.list_namespaces(prefix=("users",)) == [("users", "ann")]
    store.delete(("users", "ann"), "food")
    assert store.get(("users", "ann"), "food") is None


def test_checkpointer_keeps_a_threads_state(node: Node) -> None:
    from langchain_core.runnables import RunnableConfig
    from langgraph.graph import END, START, StateGraph
    from mindlog.sdk.langgraph import MindlogCheckpointer

    class State(TypedDict):
        count: int

    graph = StateGraph(State)
    graph.add_node("step", lambda s: {"count": s["count"] + 1})
    graph.add_edge(START, "step")
    graph.add_edge("step", END)
    saver = MindlogCheckpointer(node.client())
    app = graph.compile(checkpointer=saver)
    config: RunnableConfig = {"configurable": {"thread_id": "t1"}}
    assert app.invoke(State(count=1), config) == {"count": 2}
    assert app.get_state(config).values == {"count": 2}
    assert len(list(saver.list(config))) >= 2
    saver.delete_thread("t1")
    assert saver.get_tuple(config) is None
