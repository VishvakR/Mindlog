"""Embedded replica (PLAN 13.10, ADR-0040): a local SQLite copy of user scopes that keeps
answering reads while the server is unreachable, and queues writes until it is back."""

from __future__ import annotations

import json
import math
import re
import sqlite3
import threading
import time
import uuid
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any

from mindlog.sdk.client import Change, Client, ClientError, MemoryApi, retryable

# The same tables the TypeScript SDK's replica uses, so either can open the other's file.
SCHEMA = """
CREATE TABLE IF NOT EXISTS memories (
  user TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL,
  pending INTEGER NOT NULL DEFAULT 0, vector BLOB, PRIMARY KEY (user, id));
CREATE TABLE IF NOT EXISTS queue (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, user TEXT NOT NULL, op TEXT NOT NULL,
  body TEXT NOT NULL, local_id TEXT);
CREATE TABLE IF NOT EXISTS cursors (user TEXT PRIMARY KEY, cursor TEXT NOT NULL);
"""

Embed = Callable[[list[str]], list[list[float]]]
_WORD = re.compile(r"[^\W_]+", re.UNICODE)


@dataclass(frozen=True)
class LocalHit:
    id: str
    text: str
    kind: str
    score: float
    pending: bool


def _words(text: str) -> list[str]:
    return _WORD.findall(text.lower())


def _bm25(rows: Sequence[sqlite3.Row], query: str) -> dict[str, float]:
    """BM25 (k1 1.2, b 0.75), as the server's keyword retriever and the TypeScript replica score."""
    docs = [_words(r["text"]) for r in rows]
    avg = sum(len(d) for d in docs) / max(1, len(docs))
    out: dict[str, float] = {}
    for term in set(_words(query)):
        df = sum(1 for d in docs if term in d)
        if df == 0:
            continue
        idf = math.log(1 + (len(docs) - df + 0.5) / (df + 0.5))
        for row, d in zip(rows, docs, strict=True):
            tf = d.count(term)
            if tf:
                s = idf * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * len(d) / avg))
                out[row["id"]] = out.get(row["id"], 0.0) + s
    return out


def _pack(vector: list[float]) -> bytes:
    import array

    return array.array("f", vector).tobytes()


def _unpack(blob: bytes) -> list[float]:
    import array

    a = array.array("f")
    a.frombytes(blob)
    return list(a)


class EmbeddedReplica:
    """A local copy of `users`. It subscribes to each scope before reading it, applies changes in
    order, and replays writes queued while offline with stable request ids (each applies once)."""

    def __init__(
        self,
        client: Client,
        path: str,
        users: Sequence[str],
        embed: Embed | None = None,
        on_rejected: Callable[[str, BaseException], None] | None = None,
    ) -> None:
        self._db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self._db.row_factory = sqlite3.Row
        self._db.executescript(SCHEMA)
        self._db_lock = threading.Lock()
        # Changes, snapshots, flushes and writes never interleave; reads only need the db lock.
        self._serial = threading.RLock()
        self._apis = {u: MemoryApi(client, u) for u in users}
        self._embed = embed
        self._on_rejected = on_rejected
        self._stop = threading.Event()
        self._connected: set[str] = set()
        self._threads = [
            threading.Thread(target=self._follow, args=(u,), daemon=True, name=f"mindlog-{u}")
            for u in users
        ]
        for t in self._threads:
            t.start()

    # -- plumbing ------------------------------------------------------------------------------

    def _sql(self, query: str, args: tuple[Any, ...] = ()) -> list[sqlite3.Row]:
        with self._db_lock:
            return self._db.execute(query, args).fetchall()

    def _api(self, user: str) -> MemoryApi:
        if user not in self._apis:
            raise KeyError(f"the replica does not follow {user}")
        return self._apis[user]

    @property
    def online(self) -> bool:
        """Whether every scope's change stream is connected."""
        return len(self._connected) == len(self._apis)

    @property
    def queued(self) -> int:
        """Writes still waiting for the server."""
        return int(self._sql("SELECT COUNT(*) FROM queue")[0][0])

    def _follow(self, user: str) -> None:
        stored = self._sql("SELECT cursor FROM cursors WHERE user = ?", (user,))
        first = [not stored]

        def on_state(connected: bool) -> None:
            if not connected:
                self._connected.discard(user)
                return
            self._connected.add(user)
            with self._serial:
                self._flush(user)
                attempt = 0
                while first[0] and user in self._connected and not self._stop.is_set():
                    try:
                        self._snapshot(user)
                        first[0] = False
                    except ClientError:
                        attempt += 1
                        self._stop.wait(min(5.0, 0.2 * 2**attempt))

        def on_change(change: Change) -> None:
            with self._serial:
                self._apply(user, change)

        try:
            self._api(user).follow(
                on_change,
                self._stop,
                from_cursor=stored[0][0] if stored else None,
                on_state=on_state,
            )
        except ClientError:
            self._connected.discard(user)

    def _apply(self, user: str, change: Change) -> None:
        if change.type == "resync":
            self._snapshot(user)
            return
        if change.type == "memory.forgotten":
            for memory_id in change.ids:
                self._sql("DELETE FROM memories WHERE user = ? AND id = ?", (user, memory_id))
        elif change.type in ("memory.added", "memory.evolved"):
            self._store(user, self._api(user).get_many(list(change.ids)))
        if change.cursor:
            self._sql(
                "INSERT INTO cursors (user, cursor) VALUES (?, ?) "
                "ON CONFLICT(user) DO UPDATE SET cursor = excluded.cursor",
                (user, change.cursor),
            )

    def _snapshot(self, user: str) -> None:
        """Reads the whole scope again; written-offline rows stay until their write is replayed."""
        memories: list[dict[str, Any]] = []
        after: str | None = None
        while True:
            page = self._api(user).list(limit=200, after=after)
            memories += page["memories"]
            after = page.get("next")
            if not after:
                break
        self._sql("DELETE FROM memories WHERE user = ? AND pending = 0", (user,))
        self._store(user, memories)

    def _store(self, user: str, memories: list[dict[str, Any]]) -> None:
        live = [m for m in memories if m.get("expiredAtMs") is None]
        vectors = self._embed([m["text"] for m in live]) if self._embed and live else []
        for i, m in enumerate(live):
            blob = _pack(vectors[i]) if i < len(vectors) else None
            self._sql(
                "INSERT INTO memories (user, id, kind, text, tags, created_at, pending, vector) "
                "VALUES (?, ?, ?, ?, ?, ?, 0, ?) ON CONFLICT(user, id) DO UPDATE SET "
                "kind = excluded.kind, text = excluded.text, tags = excluded.tags, "
                "created_at = excluded.created_at, pending = 0, vector = excluded.vector",
                (user, m["id"], m["kind"], m["text"], json.dumps(m.get("tags", [])),
                 int(m["createdAtMs"]), blob),
            )  # fmt: skip
        for m in memories:
            if m.get("expiredAtMs") is not None:
                self._sql("DELETE FROM memories WHERE user = ? AND id = ?", (user, m["id"]))

    def _flush(self, user: str) -> None:
        """Replays queued writes in order; stops at the first one the server cannot take yet."""
        rows = self._sql(
            "SELECT seq, op, body, local_id FROM queue WHERE user = ? ORDER BY seq", (user,)
        )
        for row in rows:
            body = json.loads(row["body"])
            try:
                if row["op"] == "remember":
                    done = self._api(user).remember(
                        body["content"],
                        kind=body.get("kind"),
                        tags=body.get("tags"),
                        meta=body.get("meta"),
                        request_id=body["requestId"],
                    )
                    self._store(user, done["memories"])
                else:
                    self._api(user).forget(body["ids"], request_id=body["requestId"])
            except ClientError as e:
                if retryable(e):
                    return
                if self._on_rejected:
                    self._on_rejected(row["op"], e)
            if row["local_id"]:
                self._sql("DELETE FROM memories WHERE user = ? AND id = ?", (user, row["local_id"]))
            self._sql("DELETE FROM queue WHERE seq = ?", (row["seq"],))

    def _has_queue(self, user: str) -> bool:
        return bool(self._sql("SELECT 1 FROM queue WHERE user = ? LIMIT 1", (user,)))

    # -- API -------------------------------------------------------------------------------------

    def remember(
        self,
        user: str,
        content: str,
        *,
        kind: str | None = None,
        tags: list[str] | None = None,
        request_id: str | None = None,
    ) -> tuple[list[str], bool]:
        """Remembers `content`; returns its ids and whether it was queued.

        Online, the server's answer is stored before this returns (read-your-writes). Offline,
        it is readable at once under a local id, which the server's id replaces once replayed.
        """
        rid = request_id or str(uuid.uuid4())
        with self._serial:
            if not self._has_queue(user) and user in self._connected:
                try:
                    done = self._api(user).remember(content, kind=kind, tags=tags, request_id=rid)
                    self._store(user, done["memories"])
                    return list(done["ids"]), False
                except ClientError as e:
                    if not retryable(e):
                        raise
            local_id = f"local:{rid}"
            vector = self._embed([content])[0] if self._embed else None
            self._sql(
                "INSERT OR REPLACE INTO memories (user, id, kind, text, tags, created_at, pending, "
                "vector) VALUES (?, ?, ?, ?, ?, ?, 1, ?)",
                (user, local_id, kind or "episodic", content, json.dumps(tags or []),
                 int(time.time() * 1000), _pack(vector) if vector else None),
            )  # fmt: skip
            body = {"content": content, "requestId": rid, "kind": kind, "tags": tags}
            self._sql(
                "INSERT INTO queue (user, op, body, local_id) VALUES (?, 'remember', ?, ?)",
                (user, json.dumps(body), local_id),
            )
            return [local_id], True

    def forget(self, user: str, ids: list[str]) -> bool:
        """Forgets memories locally at once, on the server now or once reachable; True if queued."""
        rid = str(uuid.uuid4())
        with self._serial:
            for memory_id in ids:
                self._sql("DELETE FROM memories WHERE user = ? AND id = ?", (user, memory_id))
                if memory_id.startswith("local:"):
                    self._sql(
                        "DELETE FROM queue WHERE user = ? AND local_id = ?", (user, memory_id)
                    )
            remote = [i for i in ids if not i.startswith("local:")]
            if not remote:
                return False
            if not self._has_queue(user) and user in self._connected:
                try:
                    self._api(user).forget(remote, request_id=rid)
                    return False
                except ClientError as e:
                    if not retryable(e):
                        raise
            self._sql(
                "INSERT INTO queue (user, op, body) VALUES (?, 'forget', ?)",
                (user, json.dumps({"ids": remote, "requestId": rid})),
            )
            return True

    def recall(self, user: str, query: str, k: int = 10) -> list[LocalHit]:
        """Local recall: BM25, fused with vector similarity when the replica embeds (RRF)."""
        rows = self._sql("SELECT * FROM memories WHERE user = ?", (user,))
        keyword = sorted(_bm25(rows, query).items(), key=lambda kv: -kv[1])
        rankings = [[memory_id for memory_id, _ in keyword]]
        if self._embed:
            q = self._embed([query])[0]
            scored = [
                (r["id"], sum(a * b for a, b in zip(q, _unpack(r["vector"]), strict=False)))
                for r in rows
                if r["vector"]
            ]
            rankings.append([memory_id for memory_id, _ in sorted(scored, key=lambda kv: -kv[1])])
        fused: dict[str, float] = {}
        for ranking in rankings:
            for rank, memory_id in enumerate(ranking):
                fused[memory_id] = fused.get(memory_id, 0.0) + 1 / (60 + rank + 1)
        by_id = {r["id"]: r for r in rows}
        top = sorted(fused.items(), key=lambda kv: -kv[1])[:k]
        return [
            LocalHit(i, by_id[i]["text"], by_id[i]["kind"], s, bool(by_id[i]["pending"]))
            for i, s in top
        ]

    def list(self, user: str) -> list[LocalHit]:
        """Every local memory of a scope, oldest first."""
        rows = self._sql("SELECT * FROM memories WHERE user = ? ORDER BY created_at, id", (user,))
        return [LocalHit(r["id"], r["text"], r["kind"], 0.0, bool(r["pending"])) for r in rows]

    def settled(self) -> None:
        """Waits for any step in progress (a change, sync or flush) to finish."""
        with self._serial:
            pass

    def close(self) -> None:
        self._stop.set()
        for t in self._threads:
            t.join(timeout=2)
        with self._db_lock:
            self._db.close()
