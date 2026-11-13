"""HTTP client for Mindlog's REST API (PLAN 15.3, 15.5); standard library only."""

from __future__ import annotations

import json
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from collections.abc import Callable, Iterator, Sequence
from dataclasses import dataclass, field
from typing import Any, cast

_RETRY_STATUS = {429, 502, 503, 504}
_RETRY_CODES = {"UNAVAILABLE", "BUSY", "RATE_LIMITED", "NOT_LEADER"}
_ATTEMPTS = 5


@dataclass
class ClientError(Exception):
    """A failed request: RFC 9457 problem details, or status 0 when the server was not reached."""

    status: int
    message: str
    code: str = ""
    fields: dict[str, str] = field(default_factory=dict)

    def __str__(self) -> str:
        return f"{self.status} {self.code}: {self.message}"


def retryable(e: BaseException) -> bool:
    """A failure the next attempt may not have: the network, or the server asking to retry."""
    if isinstance(e, ClientError):
        return e.status == 0 or e.status in _RETRY_STATUS or e.code in _RETRY_CODES
    return isinstance(e, (OSError, socket.timeout))


@dataclass(frozen=True)
class Change:
    """A change to a scope's memory (PLAN 13.5); ids only, so a follower fetches what it needs."""

    type: str
    cursor: str
    ids: tuple[str, ...]


class Client:
    """Talks to one node; `api_key` authenticates (`mlk_…`)."""

    def __init__(
        self,
        base_url: str,
        api_key: str | None = None,
        tenant: str | None = None,
        timeout: float = 30,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.tenant = tenant
        self.timeout = timeout

    def headers(self) -> dict[str, str]:
        out: dict[str, str] = {}
        if self.api_key:
            out["authorization"] = f"Bearer {self.api_key}"
        if self.tenant:
            out["x-mindlog-tenant"] = self.tenant
        return out

    def _once(self, method: str, path: str, body: Any) -> Any:
        data = None if body is None else json.dumps(body).encode()
        headers = self.headers() | ({"content-type": "application/json"} if data else {})
        request = urllib.request.Request(
            self.base_url + path, data=data, method=method, headers=headers
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                text = response.read().decode()
        except urllib.error.HTTPError as e:
            raw = e.read().decode()
            problem = json.loads(raw) if raw.startswith("{") else {}
            raise ClientError(
                e.code,
                str(problem.get("detail", e.reason)),
                str(problem.get("code", "")),
                cast(dict[str, str], problem.get("fields", {})),
            ) from None
        except (urllib.error.URLError, OSError) as e:
            raise ClientError(0, f"cannot reach {self.base_url}: {e}") from None
        return json.loads(text) if text else None

    def send(self, method: str, path: str, body: Any = None) -> Any:
        """One API call, retried on network failures and retryable answers."""
        for attempt in range(1, _ATTEMPTS + 1):
            try:
                return self._once(method, path, body)
            except ClientError as e:
                if attempt == _ATTEMPTS or not retryable(e):
                    raise
                time.sleep(0.1 * 2**attempt)
        raise AssertionError("unreachable")

    def memory(self, user: str) -> MemoryApi:
        return MemoryApi(self, user)

    # KV keys as JSON values, for the LangGraph adapters.
    def kv_get(self, key: str) -> Any | None:
        try:
            got = self.send("GET", f"/api/kv/keys/{urllib.parse.quote(key, safe='')}")
        except ClientError as e:
            if e.status == 404:
                return None
            raise
        return cast(dict[str, Any], got)["value"]

    def kv_put(self, key: str, value: Any) -> None:
        self.send(
            "PUT",
            f"/api/kv/keys/{urllib.parse.quote(key, safe='')}",
            {"type": "json", "value": value},
        )

    def kv_delete(self, key: str) -> None:
        try:
            self.send("DELETE", f"/api/kv/keys/{urllib.parse.quote(key, safe='')}")
        except ClientError as e:
            if e.status != 404:
                raise

    def kv_scan(self, match: str) -> Iterator[str]:
        cursor = "0"
        while True:
            q = urllib.parse.urlencode({"cursor": cursor, "match": match, "count": 1000})
            page = cast(dict[str, Any], self.send("GET", f"/api/kv/keys?{q}"))
            for k in page["keys"]:
                yield str(k["key"])
            cursor = str(page["cursor"])
            if cursor == "0":
                return


class MemoryApi:
    """One user scope's memory. Writes carry a request id, so a retry never applies twice."""

    def __init__(self, client: Client, user: str) -> None:
        self.client = client
        self.user = user

    def _call(self, op: str, **body: Any) -> Any:
        return self.client.send("POST", f"/api/memory/{op}", {"scope": {"user": self.user}, **body})

    def remember(
        self,
        content: str,
        *,
        kind: str | None = None,
        tags: list[str] | None = None,
        meta: dict[str, Any] | None = None,
        request_id: str | None = None,
    ) -> dict[str, Any]:
        extra = {k: v for k, v in (("kind", kind), ("tags", tags), ("meta", meta)) if v is not None}
        return cast(
            dict[str, Any],
            self._call(
                "remember", content=content, requestId=request_id or str(uuid.uuid4()), **extra
            ),
        )

    def recall(self, query: str, k: int = 10, recipe: str | None = None) -> dict[str, Any]:
        extra = {"recipe": recipe} if recipe else {}
        return cast(dict[str, Any], self._call("recall", query=query, k=k, **extra))

    def get(self, memory_id: str) -> dict[str, Any] | None:
        return cast(dict[str, Any] | None, self._call("get", id=memory_id))

    def get_many(self, ids: list[str]) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for at in range(0, len(ids), 100):
            out += cast(dict[str, Any], self._call("getMany", ids=ids[at : at + 100]))["memories"]
        return out

    def list(self, limit: int = 200, after: str | None = None) -> dict[str, Any]:
        extra = {"after": after} if after else {}
        return cast(dict[str, Any], self._call("list", limit=limit, **extra))

    def forget(
        self, ids: Sequence[str], reason: str | None = None, request_id: str | None = None
    ) -> dict[str, Any]:
        extra = {"reason": reason} if reason else {}
        return cast(
            dict[str, Any],
            self._call("forget", ids=[*ids], requestId=request_id or str(uuid.uuid4()), **extra),
        )

    def follow(
        self,
        on_change: Callable[[Change], None],
        stop: threading.Event,
        from_cursor: str | None = None,
        on_state: Callable[[bool], None] | None = None,
    ) -> None:
        """Follows the scope's changes over SSE until `stop` is set; resumes from the last cursor.

        A `resync` change means the server no longer holds that cursor: re-read the scope.
        """
        cursor = from_cursor or ""
        attempt = 0
        while not stop.is_set():
            q = urllib.parse.urlencode({"user": self.user})
            headers = {**self.client.headers(), "accept": "text/event-stream"}
            if cursor:
                headers["last-event-id"] = cursor
            request = urllib.request.Request(
                f"{self.client.base_url}/api/realtime?{q}", headers=headers
            )
            try:
                with urllib.request.urlopen(request, timeout=60) as response:
                    if on_state:
                        on_state(True)
                    attempt = 0
                    for event, data, event_id in _sse(response, stop):
                        if event == "resync":
                            on_change(Change("resync", "", ()))
                        elif data:
                            cursor = event_id or cursor
                            ids = tuple(json.loads(data).get("ids", []))
                            on_change(Change(event, cursor, ids))
            except urllib.error.HTTPError as e:
                if e.code not in _RETRY_STATUS:
                    raise ClientError(e.code, str(e.reason)) from None
            except (OSError, ValueError):
                pass  # the network: reconnect below
            if on_state:
                on_state(False)
            attempt += 1
            stop.wait(min(5.0, 0.2 * 2**attempt))


def _sse(response: Any, stop: threading.Event) -> Iterator[tuple[str, str, str]]:
    event, data, event_id = "message", "", ""
    while not stop.is_set():
        raw = response.readline()
        if not raw:
            return
        line = raw.decode().rstrip("\r\n")
        if line == "":
            if data or event != "message":
                yield event, data, event_id
            event, data, event_id = "message", "", ""
        elif line.startswith(":"):
            continue
        else:
            name, _, value = line.partition(":")
            value = value[1:] if value.startswith(" ") else value
            if name == "id":
                event_id = value
            elif name == "event":
                event = value
            elif name == "data":
                data = f"{data}\n{value}" if data else value
