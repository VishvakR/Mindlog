"""Placeholder process (PLAN 24 phase 2): stays up until SIGTERM so compose can run it.

The gRPC API on port 50051 arrives in phase 5; until then the server runs without models.
"""

import signal
import sys
import threading
from types import FrameType


def main() -> int:
    stop = threading.Event()

    def on_signal(_signum: int, _frame: FrameType | None) -> None:
        stop.set()

    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)
    print("mindlog model service placeholder: no API until phase 5", flush=True)
    stop.wait()
    return 0


if __name__ == "__main__":
    sys.exit(main())
