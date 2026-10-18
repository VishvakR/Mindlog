import asyncio
from typing import Any

from demo_agents.agent import PREFERENCE, QUESTION, run_demo
from mcp.server.mcpserver import MCPServer


def fake_mindlog() -> MCPServer[Any]:
    """Stands in for Mindlog's MCP tools: remembers text and recalls it by word overlap."""
    server: MCPServer[Any] = MCPServer("fake-mindlog")
    memories: list[str] = []

    @server.tool()
    def remember(content: str) -> dict[str, Any]:
        memories.append(content)
        return {"ids": [str(len(memories))], "degraded": False}

    @server.tool()
    def recall(query: str) -> dict[str, Any]:
        words = set(query.lower().split()) | {"coffee"}
        hits = [m for m in memories if words & set(m.lower().replace(".", "").split())]
        return {"context": "\n".join(f"- {m}" for m in hits), "items": [], "degraded": False}

    return server


def test_the_second_session_recalls_what_the_first_remembered() -> None:
    server = fake_mindlog()
    lines: list[str] = []
    ok = asyncio.run(run_demo(lambda: server, say=lines.append))
    assert ok
    assert any(PREFERENCE in line for line in lines)
    assert any(QUESTION in line for line in lines)
    assert lines[-1] == "PASS: session 2 recalled the preference from session 1."


def test_fails_when_nothing_is_recalled() -> None:
    empty: MCPServer[Any] = MCPServer("empty")

    @empty.tool()
    def remember(content: str) -> dict[str, Any]:
        return {"ids": [], "degraded": False}

    @empty.tool()
    def recall(query: str) -> dict[str, Any]:
        return {"context": "", "items": [], "degraded": False}

    lines: list[str] = []
    assert not asyncio.run(run_demo(lambda: empty, say=lines.append))
    assert lines[-1].startswith("FAIL")
