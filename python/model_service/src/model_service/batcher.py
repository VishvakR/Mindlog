"""Micro-batching per model (PLAN 14.4): one forward pass for many concurrent requests."""

import asyncio
from collections import deque
from collections.abc import Callable, Sequence
from concurrent.futures import Executor
from dataclasses import dataclass, field


class Overloaded(Exception):
    """The queue is full; the caller should degrade instead of waiting (RESOURCE_EXHAUSTED)."""


@dataclass
class _Pending[T, R]:
    items: list[T]
    future: asyncio.Future[list[R]] = field(
        default_factory=lambda: asyncio.get_running_loop().create_future()
    )


class MicroBatcher[T, R]:
    """Collects requests for up to `max_wait_ms` or `max_batch` items, then runs `run` once.

    A request's items stay in one batch; a request larger than `max_batch` runs alone.
    `run` executes in `executor` (the default thread pool), off the event loop.
    """

    def __init__(
        self,
        run: Callable[[list[T]], list[R]],
        *,
        max_batch: int = 32,
        max_wait_ms: float = 5.0,
        max_queue: int = 256,
        executor: Executor | None = None,
    ) -> None:
        self._run = run
        self._max_batch = max_batch
        self._max_wait = max_wait_ms / 1000
        self._max_queue = max_queue
        self._executor = executor
        self._pending: deque[_Pending[T, R]] = deque()
        self._depth = 0
        self._worker: asyncio.Task[None] | None = None

    @property
    def depth(self) -> int:
        """Items queued or running."""
        return self._depth

    async def submit(self, items: Sequence[T]) -> list[R]:
        if self._depth + len(items) > self._max_queue:
            raise Overloaded(f"queue full ({self._depth} items)")
        pending: _Pending[T, R] = _Pending(list(items))
        self._pending.append(pending)
        self._depth += len(items)
        if self._worker is None or self._worker.done():
            self._worker = asyncio.create_task(self._drain())
        return await pending.future

    async def _drain(self) -> None:
        loop = asyncio.get_running_loop()
        while self._pending:
            if sum(len(p.items) for p in self._pending) < self._max_batch:
                await asyncio.sleep(self._max_wait)
            batch = [self._pending.popleft()]
            size = len(batch[0].items)
            while self._pending and size + len(self._pending[0].items) <= self._max_batch:
                size += len(self._pending[0].items)
                batch.append(self._pending.popleft())
            flat = [item for p in batch for item in p.items]
            try:
                results = await loop.run_in_executor(self._executor, self._run, flat)
            except Exception as error:
                for p in batch:
                    p.future.set_exception(error)
            else:
                offset = 0
                for p in batch:
                    p.future.set_result(results[offset : offset + len(p.items)])
                    offset += len(p.items)
            finally:
                self._depth -= size

    async def close(self) -> None:
        if self._worker is not None:
            await self._worker
