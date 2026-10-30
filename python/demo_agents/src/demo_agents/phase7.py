"""`python -m demo_agents.phase7`: the phase 7 demo (PLAN 24) against a running Mindlog.

Two agents, each its own MCP connection and API key, write contradicting facts
about the same user; Mindlog raises a conflict and quarantines the newer one. A
human resolves it through the dashboard's REST endpoint. One agent then tries a
plan on a branch, merges it, and time travel shows memory before the merge.

Environment: MINDLOG_MCP_URL, MINDLOG_API_KEY (agent A), MINDLOG_API_KEY_B
(agent B), MINDLOG_HTTP_URL, MINDLOG_ADMIN_EMAIL and MINDLOG_ADMIN_PASSWORD.
"""

from __future__ import annotations

import asyncio
import os
import sys
import time
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Any

import httpx2
from mcp import Client
from mcp.client.streamable_http import streamable_http_client

from demo_agents.agent import Target, _structured

VEGETARIAN = "The user is vegetarian."
STEAK = "The user eats steak every weekend."
PLAN = "The user will move to Porto in the spring."
BRANCH = "trip-plan"

Resolve = Callable[[str, str], Awaitable[None]]


async def _call(client: Client, tool: str, args: dict[str, Any]) -> dict[str, Any]:
    return _structured(await client.call_tool(tool, args))


async def _context(client: Client, query: str, **extra: Any) -> str:
    return str((await _call(client, "recall", {"query": query, **extra})).get("context", ""))


async def run_phase7(
    connect_a: Callable[[], Target],
    connect_b: Callable[[], Target],
    resolve: Resolve,
    say: Callable[[str], None] = print,
) -> bool:
    checks: list[tuple[str, bool]] = []

    def check(what: str, ok: bool) -> None:
        checks.append((what, ok))
        say(f"{'PASS' if ok else 'FAIL'}: {what}")

    async with Client(connect_a()) as a, Client(connect_b()) as b:
        say(f"agent A: remember {VEGETARIAN!r}")
        await _call(a, "remember", {"content": VEGETARIAN, "kind": "semantic"})
        say(f"agent B: remember {STEAK!r}")
        await _call(b, "remember", {"content": STEAK, "kind": "semantic"})

        listed = (await _call(b, "conflicts", {})).get("conflicts", [])
        found = next(
            (
                c
                for c in listed
                if (c.get("a") or {}).get("text") == VEGETARIAN
                and (c.get("b") or {}).get("text") == STEAK
            ),
            None,
        )
        check("a conflict was raised between the two agents' facts", found is not None)
        if found is None:
            return False
        meal = "What does the user eat?"
        check(
            "the newer fact is quarantined: recall does not use it",
            "steak" not in (await _context(a, meal)).lower(),
        )

        say(f"human (dashboard): resolve conflict {found['id']} keeping b")
        await resolve(found["id"], "b")
        after = (await _context(a, meal)).lower()
        check(
            "after the resolution recall uses b, not a",
            "steak" in after and "vegetarian" not in after,
        )

        say(f"agent A: try a plan on branch {BRANCH!r}")
        await _call(a, "branch_create", {"name": BRANCH})
        await _call(a, "remember", {"content": PLAN, "kind": "semantic", "branch": BRANCH})
        where = "Where will the user live?"
        planned = await _context(a, where, branch=BRANCH)
        check("the branch sees the plan", "porto" in planned.lower())
        check("main does not see the plan yet", "porto" not in (await _context(b, where)).lower())

        before = datetime.now(UTC).isoformat(timespec="milliseconds")
        time.sleep(1.2)
        merged = await _call(a, "branch_merge", {"name": BRANCH, "policy": "raise"})
        check("the branch merged into main", bool(merged.get("merged")))
        check("main sees the plan now", "porto" in (await _context(b, where)).lower())
        check(
            "time travel to before the merge does not see it",
            "porto" not in (await _context(b, where, as_of=before)).lower(),
        )

    passed = all(ok for _, ok in checks)
    say(f"phase 7 demo: {sum(ok for _, ok in checks)}/{len(checks)} checks passed")
    return passed


def main() -> int:
    url = os.environ.get("MINDLOG_MCP_URL", "http://127.0.0.1:8765/mcp")
    http_url = os.environ.get("MINDLOG_HTTP_URL", "http://127.0.0.1:8090")
    keys = (os.environ.get("MINDLOG_API_KEY"), os.environ.get("MINDLOG_API_KEY_B"))
    email = os.environ.get("MINDLOG_ADMIN_EMAIL")
    password = os.environ.get("MINDLOG_ADMIN_PASSWORD")
    if not all(keys) or not email or not password:
        print(
            "set MINDLOG_API_KEY, MINDLOG_API_KEY_B, MINDLOG_ADMIN_EMAIL, MINDLOG_ADMIN_PASSWORD",
            file=sys.stderr,
        )
        return 64

    def connector(key: str | None) -> Callable[[], Target]:
        def connect() -> object:
            http = httpx2.AsyncClient(
                headers={"Authorization": f"Bearer {key}"},
                timeout=httpx2.Timeout(30.0, read=300.0),
            )
            return streamable_http_client(url, http_client=http)

        return connect

    async def resolve(conflict: str, keep: str) -> None:
        async with httpx2.AsyncClient(base_url=http_url, timeout=30.0) as http:
            login = await http.post(
                "/api/superusers/auth-with-password", json={"email": email, "password": password}
            )
            login.raise_for_status()
            token = login.json()["token"]
            done = await http.post(
                "/api/memory/resolve",
                headers={"Authorization": f"Bearer {token}"},
                json={"scope": {"user": "demo"}, "id": conflict, "keep": keep},
            )
            done.raise_for_status()

    ok = asyncio.run(run_phase7(connector(keys[0]), connector(keys[1]), resolve))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
