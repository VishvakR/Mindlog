"""Downloads the default ONNX models into MODELS_DIR (ADR-0020). The only networked step.

Usage (from python/):  uv run --group download python model_service/scripts/download_models.py [dir]

Everything, including Hugging Face's own cache and lock files, stays under the target
directory: nothing is written to ~/.cache. Revisions are pinned so the model ids are stable.
"""

import json
import os
import platform
import shutil
import sys
from pathlib import Path

TARGET = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[1] / "models"
CACHE = TARGET / ".hf"
os.environ["HF_HOME"] = str(CACHE)
os.environ["HF_HUB_CACHE"] = str(CACHE / "hub")
os.environ["HF_XET_CACHE"] = str(CACHE / "xet")
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"

from huggingface_hub import hf_hub_download  # noqa: E402

NLI_ONNX = (
    "onnx/model_qint8_arm64.onnx"
    if platform.machine() in ("arm64", "aarch64")
    else "onnx/model_quint8_avx2.onnx"
)

# directory -> (repo, revision, {repo file: local name})
MODELS: dict[str, tuple[str, str, dict[str, str]]] = {
    "all-MiniLM-L6-v2": (
        "sentence-transformers/all-MiniLM-L6-v2",
        "1110a243fdf4706b3f48f1d95db1a4f5529b4d41",
        {"onnx/model.onnx": "model.onnx", "tokenizer.json": "tokenizer.json"},
    ),
    "ms-marco-MiniLM-L6-v2": (
        "cross-encoder/ms-marco-MiniLM-L6-v2",
        "233902d25c440f23af6f7d6e94d2946bac0bee0a",
        {
            "onnx/model.onnx": "model.onnx",
            "tokenizer.json": "tokenizer.json",
            "config.json": "config.json",
        },
    ),
    "nli-deberta-v3-xsmall": (
        "cross-encoder/nli-deberta-v3-xsmall",
        "a150876415327c80daeff35ca6f68f5ed8cf5c24",
        {NLI_ONNX: "model.onnx", "tokenizer.json": "tokenizer.json", "config.json": "config.json"},
    ),
    "gliner_small-v2.1": (
        "onnx-community/gliner_small-v2.1",
        "8142fb00740ccea973e64b1272949ff48653df5e",
        {
            "onnx/model_int8.onnx": "model.onnx",
            "tokenizer.json": "tokenizer.json",
            "gliner_config.json": "gliner_config.json",
        },
    ),
}


def main() -> int:
    for name, (repo, revision, files) in MODELS.items():
        directory = TARGET / name
        directory.mkdir(parents=True, exist_ok=True)
        for remote, local in files.items():
            if (directory / local).exists():
                continue
            print(f"{repo}: {remote}", flush=True)
            path = hf_hub_download(repo, remote, revision=revision, cache_dir=CACHE / "hub")
            shutil.copyfile(path, directory / local)
        (directory / "manifest.json").write_text(
            json.dumps({"repo": repo, "revision": revision, "files": files}, indent=2) + "\n"
        )
    shutil.rmtree(CACHE, ignore_errors=True)  # the copies are what the service loads
    print(f"models ready in {TARGET}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
