import signal
import subprocess
import sys


def test_placeholder_runs_until_sigterm() -> None:
    proc = subprocess.Popen(
        [sys.executable, "-m", "model_service"], stdout=subprocess.PIPE, text=True
    )
    assert proc.stdout is not None
    assert "placeholder" in proc.stdout.readline()
    proc.send_signal(signal.SIGTERM)
    assert proc.wait(timeout=10) == 0
