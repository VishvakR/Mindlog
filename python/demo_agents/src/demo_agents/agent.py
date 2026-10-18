"""A scripted agent for the phase 5 demo: session 1 remembers, session 2 recalls.

Each session is a separate MCP connection with no shared state in the agent, so
anything session 2 knows came back from Mindlog.
"""

from collections.abc import Callable
from typing import Any

from mcp import Client

PREFERENCE = "I prefer dark roast coffee, black, no sugar."
QUESTION = "What coffee should I order for the user?"

# What `Client` accepts: a URL, a Transport, or (in tests) an in-process server.
Target = Any


def _structured(result: Any) -> dict[str, Any]:
    if result.is_error:
        text = " ".join(getattr(c, "text", "") for c in result.content)
        raise RuntimeError(f"tool error: {text}")
    content = result.structured_content
    return content if isinstance(content, dict) else {}


async def run_demo(connect: Callable[[], Target], say: Callable[[str], None] = print) -> bool:
    """Runs both sessions; `connect` returns what to connect to for each new session."""
    async with Client(connect()) as session1:
        say(f"session 1: remember {PREFERENCE!r}")
        stored = _structured(
            await session1.call_tool("remember", {"content": f"Hi! For the record: {PREFERENCE}"})
        )
        say(f"session 1: stored {stored.get('ids')} (degraded: {stored.get('degraded')})")

    async with Client(connect()) as session2:
        say(f"session 2: recall {QUESTION!r}")
        recalled = _structured(await session2.call_tool("recall", {"query": QUESTION}))
        context = str(recalled.get("context", ""))
        say(f"session 2: context\n{context or '(empty)'}")

    if "dark roast" in context.lower():
        say("PASS: session 2 recalled the preference from session 1.")
        return True
    say("FAIL: session 2 did not recall the preference.")
    return False
