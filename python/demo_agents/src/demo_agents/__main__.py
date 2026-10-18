"""`python -m demo_agents`: run the two-session demo against a Mindlog MCP endpoint.

Environment: MINDLOG_MCP_URL (default http://127.0.0.1:8765/mcp), MINDLOG_API_KEY (required).
"""

import asyncio
import os
import sys

import httpx2
from mcp.client.streamable_http import streamable_http_client

from demo_agents.agent import run_demo


def main() -> int:
    url = os.environ.get("MINDLOG_MCP_URL", "http://127.0.0.1:8765/mcp")
    key = os.environ.get("MINDLOG_API_KEY")
    if not key:
        print("set MINDLOG_API_KEY (mindlog-server apikey create ...)", file=sys.stderr)
        return 64

    def connect() -> object:
        http = httpx2.AsyncClient(
            headers={"Authorization": f"Bearer {key}"},
            timeout=httpx2.Timeout(30.0, read=300.0),
        )
        return streamable_http_client(url, http_client=http)

    return 0 if asyncio.run(run_demo(connect)) else 1


if __name__ == "__main__":
    sys.exit(main())
