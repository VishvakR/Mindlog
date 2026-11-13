"""A real single node (`pnpm build` first) behind a TCP proxy whose link can be cut."""

from __future__ import annotations

import contextlib
import json
import os
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import urllib.request
from collections.abc import Iterator, Mapping
from dataclasses import dataclass
from pathlib import Path

import pytest
from mindlog.sdk import Client

ROOT = Path(__file__).resolve().parents[3]
BIN = ROOT / "packages" / "server" / "dist" / "bin.js"
PASSWORD = "correct horse battery"


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def wait_port(port: int, timeout: float = 30) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with socket.socket() as s:
            if s.connect_ex(("127.0.0.1", port)) == 0:
                return
        time.sleep(0.1)
    raise TimeoutError(f"nothing listens on {port}")


class Proxy:
    """Forwards to `target`; `cut()` drops every connection and refuses new ones till restored."""

    def __init__(self, target: int) -> None:
        self.target = target
        self.cut_off = False
        self.open: set[socket.socket] = set()
        self.lock = threading.Lock()
        self.server = socket.create_server(("127.0.0.1", 0))
        self.port = int(self.server.getsockname()[1])
        threading.Thread(target=self._accept, daemon=True).start()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def _pipe(self, a: socket.socket, b: socket.socket) -> None:
        try:
            while data := a.recv(65536):
                b.sendall(data)
        except OSError:
            pass
        finally:
            for s in (a, b):
                self._close(s)

    def _close(self, s: socket.socket) -> None:
        with self.lock:
            self.open.discard(s)
        with contextlib.suppress(OSError):
            s.shutdown(socket.SHUT_RDWR)
        s.close()

    def _accept(self) -> None:
        while True:
            try:
                client, _ = self.server.accept()
            except OSError:
                return
            if self.cut_off:
                client.close()
                continue
            upstream = socket.create_connection(("127.0.0.1", self.target))
            with self.lock:
                self.open |= {client, upstream}
            threading.Thread(target=self._pipe, args=(client, upstream), daemon=True).start()
            threading.Thread(target=self._pipe, args=(upstream, client), daemon=True).start()

    def cut(self) -> None:
        self.cut_off = True
        with self.lock:
            sockets = list(self.open)
        for s in sockets:
            self._close(s)

    def restore(self) -> None:
        self.cut_off = False


@dataclass
class Node:
    http: int
    key: str
    proxy: Proxy

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.http}"

    def client(self, through_proxy: bool = False) -> Client:
        return Client(self.proxy.url if through_proxy else self.url, api_key=self.key)


def _post(url: str, body: Mapping[str, object], token: str | None = None) -> dict[str, object]:
    headers = {"content-type": "application/json"}
    if token:
        headers["authorization"] = f"Bearer {token}"
    request = urllib.request.Request(url, data=json.dumps(body).encode(), headers=headers)
    with urllib.request.urlopen(request, timeout=30) as r:
        return dict(json.loads(r.read()))


@pytest.fixture(scope="session")
def node() -> Iterator[Node]:
    if not BIN.exists() or not shutil.which("node"):
        pytest.skip("needs `pnpm build` and node")
    data = tempfile.mkdtemp(prefix="mindlog-sdk-", dir=os.environ.get("TMPDIR"))
    env = {**os.environ, "MINDLOG_LISTEN__MCP__HTTP__PORT": "0"}
    subprocess.run(
        ["node", str(BIN), "superuser", "upsert", "root@example.com", PASSWORD, "--data-dir", data],
        check=True, capture_output=True, env=env, cwd=ROOT,
    )  # fmt: skip
    resp, http = free_port(), free_port()
    proc = subprocess.Popen(
        ["node", str(BIN), "--single-node", "--port", str(resp), "--http-port", str(http),
         "--data-dir", data],
        env=env, cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )  # fmt: skip
    try:
        wait_port(http)
        base = f"http://127.0.0.1:{http}"
        login = {"email": "root@example.com", "password": PASSWORD}
        token = str(_post(f"{base}/api/superusers/auth-with-password", login)["token"])
        made = _post(
            f"{base}/api/tenants/default/keys", {"name": "sdk", "role": "developer"}, token
        )
        yield Node(http, str(made["key"]), Proxy(http))
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
        shutil.rmtree(data, ignore_errors=True)
