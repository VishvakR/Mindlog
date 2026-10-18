import asyncio
from pathlib import Path

from model_service.health import check
from model_service.server import Backends, Limits, serve


def test_check_is_true_against_a_ready_server_and_false_without_one(tmp_path: Path) -> None:
    async def go() -> tuple[bool, bool]:
        server, port = await serve(Backends(), "127.0.0.1", 0, Limits())
        up = await check(f"127.0.0.1:{port}", timeout=5)
        await server.stop(None)
        down = await check(f"127.0.0.1:{port}", timeout=0.5)
        return up, down

    assert asyncio.run(go()) == (True, False)
