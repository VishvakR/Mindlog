"""Container healthcheck: `python -m model_service.health host:port` exits 0 once ready."""

import asyncio
import sys

import grpc
from mindlog.v1 import models_pb2, models_pb2_grpc


async def check(address: str, timeout: float) -> bool:
    try:
        async with grpc.aio.insecure_channel(address) as channel:
            stub = models_pb2_grpc.ModelsServiceStub(channel)
            reply = await stub.Health(models_pb2.HealthRequest(), timeout=timeout)
            return bool(reply.ready)
    except grpc.aio.AioRpcError:
        return False


if __name__ == "__main__":
    sys.exit(0 if asyncio.run(check(sys.argv[1], timeout=3)) else 1)
