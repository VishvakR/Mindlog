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

    def add_fact(self, scope: str, text: str, valid_from: int = 0) -> str:
        """Stores one semantic fact verbatim; its id."""
        args: list[str | int] = ["MEM.ADD", scope, text, "KIND", "semantic"]
        if valid_from:
            args += ["VALID_FROM", valid_from]
        reply = cast(dict[str, Any], self._call(*args))
        return _str(reply["ids"][0])

    def conflicts(self, scope: str) -> list[dict[str, Any]]:
        return cast(list[dict[str, Any]], self._call("MEM.CONFLICTS", scope, "ALL"))

    def valid_to(self, scope: str, memory_id: str) -> int:
        reply = cast(dict[str, Any] | None, self._call("MEM.GET", scope, memory_id))
        return int((reply or {}).get("valid_to", 0))

    # Resumable ingestion: memory id → corpus id in a hash, and how many turns are in.
    def mapping(self, scope: str) -> tuple[dict[str, str], int]:
        done = self._r.get(f"evals:next:{scope}")
        return cast(dict[str, str], self._r.hgetall(f"evals:map:{scope}")), int(done or 0)

    def record(self, scope: str, ids: list[str], corpus_id: str, next_turn: int) -> None:
        if ids:
            self._r.hset(f"evals:map:{scope}", mapping=dict.fromkeys(ids, corpus_id))
        self._r.set(f"evals:next:{scope}", next_turn)

    def queued_jobs(self) -> int:
        """Queued and leased jobs on the node, from its metrics (consolidation ticks included)."""
        with urllib.request.urlopen(self._metrics, timeout=10) as r:
            text = r.read().decode()
        return int(sum(float(v) for v in _DEPTH.findall(text)))

    def jobs(self, scope: str) -> list[dict[str, Any]]:
        """A scope's jobs, all states but done (MEM.JOBS)."""
        reply = cast(dict[str, Any], self._call("MEM.JOBS", scope, "LIMIT", 200))
        return cast(list[dict[str, Any]], reply["jobs"])

    def pending(self, scope: str, kinds: tuple[str, ...]) -> int:
        """Queued or running jobs of these kinds in a scope."""
        return sum(
            1
            for j in self.jobs(scope)
            if _str(j["kind"]) in kinds and _str(j["state"]) in ("queued", "leased")
        )

    def drain(
        self,
        say: Any,
        scopes: list[str],
        kinds: tuple[str, ...] = ("memory.enrich",),
        timeout_s: float = 3600,
        poll_s: float = 30,
    ) -> None:
        """Waits until no job of `kinds` is queued or running in the scopes.

        Phase 8 keeps a consolidation tick queued in every scope, so the node-wide queue
        depth never reaches 0; this counts the jobs that matter per scope.
        """
        deadline = time.monotonic() + timeout_s
        while (left := sum(self.pending(s, kinds) for s in scopes)) > 0:
            if time.monotonic() > deadline:
                raise TimeoutError(f"{left} jobs still queued after {timeout_s:.0f} s")
            say(f"waiting for {left} jobs ({', '.join(kinds)})")
            time.sleep(poll_s)

    def consolidate(self, scope: str, workers: list[str]) -> list[str]:
        """Enqueues consolidation workers now (MEM.CONSOLIDATE)."""
        return [_str(k) for k in cast(list[Any], self._call("MEM.CONSOLIDATE", scope, *workers))]

    def derived_from(self, scope: str, memory_id: str) -> tuple[str, list[str]]:
        """A memory's text and the memories it was derived from (a summary's turns)."""
        reply = cast(dict[str, Any] | None, self._call("MEM.GET", scope, memory_id)) or {}
        return _str(reply.get("text", "")), [_str(i) for i in reply.get("derived_from", [])]
