"""Starts a real mindlog-server for the redis-py compatibility suite (PLAN 24, phase 1 gate).

The server runs from the built package (`pnpm build`); without a build the
suite is skipped. MINDLOG_SERVER_BIN points at another build.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from collections.abc import Iterator
from pathlib import Path

import pytest
import redis

REPO = Path(__file__).resolve().parents[2]
SERVER_BIN = Path(
    os.environ.get("MINDLOG_SERVER_BIN", REPO / "packages" / "server" / "dist" / "bin.js")
)


def _start(data_dir: str) -> tuple[subprocess.Popen[str], int]:
    process = subprocess.Popen(
        [
            "node",
            str(SERVER_BIN),
            "--single-node",
            "--host",
            "127.0.0.1",
            "--port",
            "0",
            "--data-dir",
            data_dir,
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    assert process.stdout is not None
    for line in process.stdout:
        entry = json.loads(line)
        if entry.get("msg") == "node started":
            return process, int(str(entry["resp"]).rsplit(":", 1)[1])
    raise RuntimeError(f"mindlog-server exited with {process.wait()}")


@pytest.fixture(scope="session")
def server_port() -> Iterator[int]:
    if not SERVER_BIN.exists() or shutil.which("node") is None:
        pytest.skip(f"build the server first (pnpm build); {SERVER_BIN} not found")
    data_dir = tempfile.mkdtemp(prefix="mindlog-redis-py-")
    process, port = _start(data_dir)
    try:
        yield port
    finally:
        process.terminate()
        process.wait(timeout=10)
        shutil.rmtree(data_dir, ignore_errors=True)


@pytest.fixture(params=[2, 3], ids=["resp2", "resp3"])
def r(request: pytest.FixtureRequest, server_port: int) -> Iterator[redis.Redis]:
    """A client per protocol version; each test starts from an empty keyspace."""
    client = redis.Redis(port=server_port, protocol=request.param, decode_responses=True)
    keys = list(client.scan_iter(count=1000))
    if keys:
        client.delete(*keys)
    yield client
    client.close()
