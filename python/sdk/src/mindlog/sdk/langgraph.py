"""LangGraph integration (PLAN 15.5): a long-term memory store and a checkpointer on Mindlog.

Needs the `langgraph` extra. Items and checkpoints are KV keys holding JSON; a store's semantic
search uses Mindlog memory recall on the items' text.
"""

from __future__ import annotations

import asyncio
import base64
import json
from collections.abc import AsyncIterator, Iterable, Iterator, Sequence
from datetime import UTC, datetime
from typing import Any, cast

from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.base import (
    WRITES_IDX_MAP,
    BaseCheckpointSaver,
    ChannelVersions,
    Checkpoint,
    CheckpointMetadata,
    CheckpointTuple,
    get_checkpoint_id,
)
from langgraph.store.base import (
    BaseStore,
    GetOp,
    Item,
    ListNamespacesOp,
    Op,
    PutOp,
    Result,
    SearchItem,
    SearchOp,
)
from mindlog.sdk.client import Client

_SEP = "\x1f"


def _hex(text: str) -> str:
    return text.encode().hex()


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _matches(value: dict[str, Any], flt: dict[str, Any] | None) -> bool:
    return all(value.get(k) == v for k, v in (flt or {}).items())


class MindlogStore(BaseStore):
    """LangGraph's `BaseStore` on Mindlog: exact reads from KV, `search(query=…)` by memory recall
    over user scope `user`.

    shortcut: listing and prefix search scan every store key; keep a namespace index when stores
    hold more than a few thousand items.
    """

    def __init__(self, client: Client, user: str = "langgraph") -> None:
        self._client = client
        self._memory = client.memory(user)

    def _key(self, namespace: tuple[str, ...], key: str) -> str:
        return f"lg:store:{_hex(_SEP.join(namespace))}:{_hex(key)}"

    def _all(self) -> Iterator[dict[str, Any]]:
        for k in self._client.kv_scan("lg:store:*"):
            row = self._client.kv_get(k)
            if row is not None:
                yield cast(dict[str, Any], row)

    @staticmethod
    def _item(row: dict[str, Any]) -> Item:
        return Item(
            value=row["value"],
            key=row["key"],
            namespace=tuple(row["namespace"]),
            created_at=datetime.fromisoformat(row["created_at"]),
            updated_at=datetime.fromisoformat(row["updated_at"]),
        )

    def _get(self, op: GetOp) -> Item | None:
        row = self._client.kv_get(self._key(op.namespace, op.key))
        return self._item(cast(dict[str, Any], row)) if row else None

    def _put(self, op: PutOp) -> None:
        key = self._key(op.namespace, op.key)
        old = cast(dict[str, Any] | None, self._client.kv_get(key))
        if old and old.get("memory"):
            self._memory.forget([old["memory"]], reason="replaced in the store")
        if op.value is None:
            self._client.kv_delete(key)
            return
        memory = None
        if op.index is not False:
            text = json.dumps(op.value, ensure_ascii=False, sort_keys=True)
            ref = {"namespace": list(op.namespace), "key": op.key}
            memory = self._memory.remember(text, kind="semantic", meta={"langgraph": ref})["ids"][0]
        now = _now()
        self._client.kv_put(
            key,
            {
                "namespace": list(op.namespace),
                "key": op.key,
                "value": op.value,
                "created_at": old["created_at"] if old else now,
                "updated_at": now,
                "memory": memory,
            },
        )

    def _search(self, op: SearchOp) -> list[SearchItem]:
        prefix = op.namespace_prefix

        def in_prefix(ns: Sequence[str]) -> bool:
            return tuple(ns[: len(prefix)]) == prefix

        found: list[tuple[dict[str, Any], float | None]] = []
        if op.query:
            hits = self._memory.recall(op.query, k=min(50, (op.limit + op.offset) * 4))["items"]
            for hit in hits:
                ref = (hit["memory"].get("meta") or {}).get("langgraph")
                if not ref or not in_prefix(ref["namespace"]):
                    continue
                row = self._client.kv_get(self._key(tuple(ref["namespace"]), ref["key"]))
                if row and _matches(row["value"], op.filter):
                    found.append((cast(dict[str, Any], row), float(hit["score"])))
        else:
            rows = [
                r
                for r in self._all()
                if in_prefix(r["namespace"]) and _matches(r["value"], op.filter)
            ]
            found = [(r, None) for r in sorted(rows, key=lambda r: r["updated_at"], reverse=True)]
        out = []
        for row, score in found[op.offset : op.offset + op.limit]:
            item = self._item(row)
            out.append(
                SearchItem(
                    item.namespace, item.key, item.value, item.created_at, item.updated_at, score
                )
            )
        return out

    def _namespaces(self, op: ListNamespacesOp) -> list[tuple[str, ...]]:
        spaces = sorted({tuple(r["namespace"]) for r in self._all()})
        for cond in op.match_conditions or ():
            path = cond.path

            def fits(
                ns: tuple[str, ...], path: tuple[str, ...] = path, kind: str = cond.match_type
            ) -> bool:
                part = ns[: len(path)] if kind == "prefix" else ns[-len(path) :]
                return len(part) == len(path) and all(
                    p in ("*", s) for p, s in zip(path, part, strict=True)
                )

            spaces = [ns for ns in spaces if fits(ns)]
        if op.max_depth is not None:
            spaces = sorted({ns[: op.max_depth] for ns in spaces})
        return spaces[op.offset : op.offset + op.limit]

    def batch(self, ops: Iterable[Op]) -> list[Result]:
        out: list[Result] = []
        for op in ops:
            if isinstance(op, GetOp):
                out.append(self._get(op))
            elif isinstance(op, PutOp):
                self._put(op)
                out.append(None)
            elif isinstance(op, SearchOp):
                out.append(self._search(op))
            elif isinstance(op, ListNamespacesOp):
                out.append(self._namespaces(op))
            else:
                raise TypeError(f"unknown store operation {op!r}")
        return out

    async def abatch(self, ops: Iterable[Op]) -> list[Result]:
        return await asyncio.to_thread(self.batch, list(ops))


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


class MindlogCheckpointer(BaseCheckpointSaver[str]):
    """LangGraph's checkpointer on Mindlog KV: one JSON key per checkpoint and per checkpoint's
    pending writes, so graph state survives restarts and is replicated like any other data."""

    def __init__(self, client: Client) -> None:
        super().__init__()
        self._client = client

    @staticmethod
    def _where(config: RunnableConfig) -> tuple[str, str]:
        c = config.get("configurable", {})
        return str(c["thread_id"]), str(c.get("checkpoint_ns", ""))

    @staticmethod
    def _key(kind: str, thread: str, ns: str, checkpoint_id: str = "") -> str:
        return f"lg:{kind}:{_hex(thread)}:{_hex(ns)}:{checkpoint_id}"

    def _load(self, thread: str, ns: str, row: dict[str, Any]) -> CheckpointTuple:
        cid = row["id"]
        writes = cast(
            list[list[Any]], self._client.kv_get(self._key("writes", thread, ns, cid)) or []
        )
        config: RunnableConfig = {
            "configurable": {"thread_id": thread, "checkpoint_ns": ns, "checkpoint_id": cid}
        }
        parent: RunnableConfig | None = (
            {
                "configurable": {
                    "thread_id": thread,
                    "checkpoint_ns": ns,
                    "checkpoint_id": row["parent"],
                }
            }
            if row.get("parent")
            else None
        )
        return CheckpointTuple(
            config=config,
            checkpoint=self.serde.loads_typed((row["type"], base64.b64decode(row["data"]))),
            metadata=cast(CheckpointMetadata, json.loads(row["metadata"])),
            parent_config=parent,
            pending_writes=[
                (w[0], w[1], self.serde.loads_typed((w[2], base64.b64decode(w[3]))))
                for w in sorted(writes, key=lambda w: (w[0], w[4]))
            ],
        )

    def _ids(self, thread: str, ns: str) -> list[str]:
        prefix = self._key("ckpt", thread, ns)
        return sorted((k[len(prefix) :] for k in self._client.kv_scan(f"{prefix}*")), reverse=True)

    def get_tuple(self, config: RunnableConfig) -> CheckpointTuple | None:
        thread, ns = self._where(config)
        cid = get_checkpoint_id(config) or next(iter(self._ids(thread, ns)), None)
        if not cid:
            return None
        row = self._client.kv_get(self._key("ckpt", thread, ns, cid))
        return self._load(thread, ns, cast(dict[str, Any], row)) if row else None

    def list(
        self,
        config: RunnableConfig | None,
        *,
        filter: dict[str, Any] | None = None,
        before: RunnableConfig | None = None,
        limit: int | None = None,
    ) -> Iterator[CheckpointTuple]:
        if config is None:
            return
        thread, ns = self._where(config)
        stop = get_checkpoint_id(before) if before else None
        n = 0
        for cid in self._ids(thread, ns):
            if stop and cid >= stop:
                continue
            row = self._client.kv_get(self._key("ckpt", thread, ns, cid))
            if not row:
                continue
            found = self._load(thread, ns, cast(dict[str, Any], row))
            if not _matches(cast(dict[str, Any], found.metadata), filter):
                continue
            yield found
            n += 1
            if limit is not None and n >= limit:
                return

    def put(
        self,
        config: RunnableConfig,
        checkpoint: Checkpoint,
        metadata: CheckpointMetadata,
        new_versions: ChannelVersions,
    ) -> RunnableConfig:
        thread, ns = self._where(config)
        kind, data = self.serde.dumps_typed(checkpoint)
        self._client.kv_put(
            self._key("ckpt", thread, ns, checkpoint["id"]),
            {
                "id": checkpoint["id"],
                "parent": config.get("configurable", {}).get("checkpoint_id"),
                "type": kind,
                "data": _b64(data),
                "metadata": json.dumps(metadata, default=str),
            },
        )
        return {
            "configurable": {
                "thread_id": thread,
                "checkpoint_ns": ns,
                "checkpoint_id": checkpoint["id"],
            }
        }

    def put_writes(
        self,
        config: RunnableConfig,
        writes: Sequence[tuple[str, Any]],
        task_id: str,
        task_path: str = "",
    ) -> None:
        thread, ns = self._where(config)
        cid = str(config["configurable"]["checkpoint_id"])
        key = self._key("writes", thread, ns, cid)
        stored = cast(list[list[Any]], self._client.kv_get(key) or [])
        kept = {(w[0], w[4]): w for w in stored}
        for i, (channel, value) in enumerate(writes):
            idx = WRITES_IDX_MAP.get(channel, i)
            if idx >= 0 and (task_id, idx) in kept:
                continue  # a regular write is kept once, as in LangGraph's own savers
            kind, data = self.serde.dumps_typed(value)
            kept[(task_id, idx)] = [task_id, channel, kind, _b64(data), idx]
        self._client.kv_put(key, list(kept.values()))

    def delete_thread(self, thread_id: str) -> None:
        for kind in ("ckpt", "writes"):
            for k in self._client.kv_scan(f"lg:{kind}:{_hex(thread_id)}:*"):
                self._client.kv_delete(k)

    async def aget_tuple(self, config: RunnableConfig) -> CheckpointTuple | None:
        return await asyncio.to_thread(self.get_tuple, config)

    async def alist(
        self,
        config: RunnableConfig | None,
        *,
        filter: dict[str, Any] | None = None,
        before: RunnableConfig | None = None,
        limit: int | None = None,
    ) -> AsyncIterator[CheckpointTuple]:
        found = await asyncio.to_thread(
            lambda: list(self.list(config, filter=filter, before=before, limit=limit))
        )
        for t in found:
            yield t

    async def aput(
        self,
        config: RunnableConfig,
        checkpoint: Checkpoint,
        metadata: CheckpointMetadata,
        new_versions: ChannelVersions,
    ) -> RunnableConfig:
        return await asyncio.to_thread(self.put, config, checkpoint, metadata, new_versions)

    async def aput_writes(
        self,
        config: RunnableConfig,
        writes: Sequence[tuple[str, Any]],
        task_id: str,
        task_path: str = "",
    ) -> None:
        await asyncio.to_thread(self.put_writes, config, writes, task_id, task_path)

    async def adelete_thread(self, thread_id: str) -> None:
        await asyncio.to_thread(self.delete_thread, thread_id)

    def get_next_version(self, current: str | None, channel: None) -> str:
        n = int(str(current).split(".")[0]) + 1 if current else 1
        return f"{n:032}.0"
