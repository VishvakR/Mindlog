"""The few Mindlog commands the harness needs, over RESP3 with redis-py."""

from __future__ import annotations

import re
import time
import urllib.request
from typing import Any, cast

import redis

_DEPTH = re.compile(r"^mindlog_jobs_queue_depth_count\{[^}]*\} (\S+)$", re.M)

# Leave room under the 32 KB per-item limit (PLAN 12.3) for UTF-8 growth.
MAX_TEXT_BYTES = 30_000


def _clip(text: str) -> str:
    raw = text.encode()
    return text if len(raw) <= MAX_TEXT_BYTES else raw[:MAX_TEXT_BYTES].decode(errors="ignore")


def _str(value: Any) -> str:
    return value.decode() if isinstance(value, bytes) else str(value)


class Mindlog:
    def __init__(
        self,
        host: str = "127.0.0.1",
        port: int = 6390,
        timeout: float = 120.0,
        http_port: int = 8099,
    ) -> None:
        self._metrics = f"http://{host}:{http_port}/metrics"
        self._r = redis.Redis(
            host=host, port=port, protocol=3, decode_responses=True, socket_timeout=timeout
        )

    def _call(self, *args: str | int | float) -> Any:
        return self._r.execute_command(*args)  # type: ignore[no-untyped-call]

    def add(self, scope: str, text: str, kind: str = "episodic") -> tuple[list[str], bool]:
        """Stores a turn; True when it was stored raw and left to the enrichment jobs."""
        reply = cast(dict[str, Any], self._call("MEM.ADD", scope, _clip(text), "KIND", kind))
        return [_str(i) for i in reply["ids"]], bool(reply.get("degraded"))

    def search(self, scope: str, query: str, k: int, recipe: str) -> list[str]:
        items = cast(
            list[dict[str, Any]], self._call("MEM.SEARCH", scope, query, "K", k, "RECIPE", recipe)
        )
        return [_str(i["id"]) for i in items]

    def pack(self, scope: str, query: str, budget: int, recipe: str) -> tuple[list[str], int]:
        reply = cast(
            dict[str, Any], self._call("MEM.PACK", scope, query, "BUDGET", budget, "RECIPE", recipe)
        )
        return [_str(i) for i in reply["ids"]], int(reply["tokens"])

    def cache_set(self, scope: str, prompt: str, answer: str) -> str:
        return _str(self._call("CACHE.SET", scope, prompt, answer))

    def cache_get(self, scope: str, prompt: str, threshold: float) -> tuple[str, float] | None:
        reply = self._call("CACHE.GET", scope, prompt, "THRESHOLD", threshold)
        if reply is None:
            return None
        hit = cast(dict[str, Any], reply)
        return _str(hit["answer"]), float(hit["similarity"])

    # Resumable ingestion: memory id → corpus id in a hash, and how many turns are in.
    def mapping(self, scope: str) -> tuple[dict[str, str], int]:
        done = self._r.get(f"evals:next:{scope}")
        return cast(dict[str, str], self._r.hgetall(f"evals:map:{scope}")), int(done or 0)

    def record(self, scope: str, ids: list[str], corpus_id: str, next_turn: int) -> None:
        if ids:
            self._r.hset(f"evals:map:{scope}", mapping=dict.fromkeys(ids, corpus_id))
        self._r.set(f"evals:next:{scope}", next_turn)

    def queued_jobs(self) -> int:
        """Queued and leased jobs on the node, from its metrics."""
        with urllib.request.urlopen(self._metrics, timeout=10) as r:
            text = r.read().decode()
        return int(sum(float(v) for v in _DEPTH.findall(text)))

    def drain(self, say: Any, timeout_s: float = 3600) -> None:
        """Waits for the enrichment jobs (embeddings, entities) of degraded writes to finish."""
        deadline = time.monotonic() + timeout_s
        while (left := self.queued_jobs()) > 0:
            if time.monotonic() > deadline:
                raise TimeoutError(f"{left} jobs still queued after {timeout_s:.0f} s")
            say(f"waiting for {left} enrichment jobs")
            time.sleep(30)
