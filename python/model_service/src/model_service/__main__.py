"""Runs the model service (PLAN 14): `python -m model_service`, configured from the environment."""

import asyncio
import logging
import os
import signal
import sys

# Never reach the network for models (ADR-0020); set before any Hugging Face import.
os.environ.setdefault("HF_HUB_OFFLINE", "1")

from model_service.config import load_backends, settings_from_env
from model_service.server import serve


async def run() -> int:
    settings = settings_from_env()
    backends = load_backends(settings)
    server, port = await serve(backends, settings.host, settings.port, settings.limits)
    print(f"mindlog model service listening on {settings.host}:{port}", flush=True)
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)
    await stop.wait()
    await server.stop(grace=5)
    return 0


def main() -> int:
    logging.basicConfig(level=logging.INFO, stream=sys.stderr)
    return asyncio.run(run())


if __name__ == "__main__":
    sys.exit(main())
