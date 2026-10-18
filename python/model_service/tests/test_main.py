import os
import signal
import subprocess
import sys
from pathlib import Path


def test_serves_without_models_until_sigterm(tmp_path: Path) -> None:
    env = {**os.environ, "MODELS_DIR": str(tmp_path), "MODEL_SERVICE_PORT": "0"}
    proc = subprocess.Popen(
        [sys.executable, "-m", "model_service"],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        env=env,
    )
    assert proc.stdout is not None
    line = proc.stdout.readline()
    assert line.startswith("mindlog model service listening on 127.0.0.1:")
    assert int(line.rsplit(":", 1)[1]) > 0
    proc.send_signal(signal.SIGTERM)
    assert proc.wait(timeout=10) == 0
