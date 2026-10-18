import asyncio
import threading

import pytest
from model_service.batcher import MicroBatcher, Overloaded


def test_concurrent_requests_share_one_forward_pass() -> None:
    calls: list[list[int]] = []

    def run(items: list[int]) -> list[int]:
        calls.append(list(items))
        return [i * 10 for i in items]

    async def go() -> list[list[int]]:
        batcher = MicroBatcher(run, max_batch=32, max_wait_ms=5)
        results = list(await asyncio.gather(*(batcher.submit([i]) for i in range(10))))
        await batcher.close()
        return results

    results = asyncio.run(go())
    assert results == [[i * 10] for i in range(10)]
    assert calls == [list(range(10))]


def test_batches_never_exceed_max_batch_but_keep_requests_whole() -> None:
    sizes: list[int] = []

    def run(items: list[int]) -> list[int]:
        sizes.append(len(items))
        return items

    async def go() -> list[list[int]]:
        batcher = MicroBatcher(run, max_batch=4, max_wait_ms=1)
        out = list(await asyncio.gather(batcher.submit([1, 2, 3]), batcher.submit([4, 5])))
        await batcher.close()
        return out

    assert asyncio.run(go()) == [[1, 2, 3], [4, 5]]
    assert sizes == [3, 2]


def test_a_request_larger_than_max_batch_runs_alone() -> None:
    sizes: list[int] = []

    def run(items: list[int]) -> list[int]:
        sizes.append(len(items))
        return items

    async def go() -> list[int]:
        batcher = MicroBatcher(run, max_batch=2, max_wait_ms=1)
        out = await batcher.submit([1, 2, 3, 4, 5])
        await batcher.close()
        return out

    assert asyncio.run(go()) == [1, 2, 3, 4, 5]
    assert sizes == [5]


def test_full_queue_rejects_instead_of_waiting() -> None:
    release = threading.Event()

    def run(items: list[int]) -> list[int]:
        release.wait(5)
        return items

    async def go() -> None:
        batcher = MicroBatcher(run, max_batch=1, max_wait_ms=0, max_queue=2)
        first = asyncio.ensure_future(batcher.submit([1]))
        await asyncio.sleep(0.05)  # the first batch is running, holding one slot
        second = asyncio.ensure_future(batcher.submit([2]))
        await asyncio.sleep(0)
        with pytest.raises(Overloaded):
            await batcher.submit([3])
        assert batcher.depth == 2
        release.set()
        assert await first == [1]
        assert await second == [2]
        await batcher.close()

    asyncio.run(go())


def test_a_failing_forward_pass_fails_only_its_batch() -> None:
    def run(items: list[int]) -> list[int]:
        if 0 in items:
            raise ValueError("boom")
        return items

    async def go() -> None:
        batcher = MicroBatcher(run, max_batch=1, max_wait_ms=0)
        with pytest.raises(ValueError, match="boom"):
            await batcher.submit([0])
        assert await batcher.submit([7]) == [7]
        await batcher.close()

    asyncio.run(go())
