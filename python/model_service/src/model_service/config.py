"""Settings from the environment and model loading. Models come only from MODELS_DIR (ADR-0020)."""

import json
import logging
import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

from model_service.extract import HeuristicExtractor, LlamaExtractor
from model_service.server import Backends, Limits

# The repo's python/model_service/models/; the image sets MODELS_DIR=/app/models.
DEFAULT_MODELS_DIR = Path(__file__).resolve().parents[2] / "models"

# capability -> directory under MODELS_DIR (written by scripts/download_models.py)
MODEL_DIRS = {
    "embed": "all-MiniLM-L6-v2",
    "rerank": "ms-marco-MiniLM-L6-v2",
    "nli": "nli-deberta-v3-xsmall",
    "ner": "gliner_small-v2.1",
}

log = logging.getLogger("model_service")


@dataclass(frozen=True)
class Settings:
    models_dir: Path
    host: str
    port: int
    limits: Limits
    extract_gguf: Path | None


def settings_from_env(env: Mapping[str, str] = os.environ) -> Settings:
    gguf = env.get("EXTRACT_GGUF")
    return Settings(
        models_dir=Path(env.get("MODELS_DIR", str(DEFAULT_MODELS_DIR))),
        host=env.get("MODEL_SERVICE_HOST", "127.0.0.1"),
        port=int(env.get("MODEL_SERVICE_PORT", "50051")),
        limits=Limits(
            max_batch=int(env.get("MODEL_BATCH_MAX", "32")),
            max_wait_ms=float(env.get("MODEL_BATCH_WAIT_MS", "5")),
            max_queue=int(env.get("MODEL_QUEUE_MAX", "256")),
        ),
        extract_gguf=Path(gguf) if gguf else None,
    )


def model_id(directory: Path) -> str:
    """`name@revision` from the manifest the downloader writes."""
    manifest = directory / "manifest.json"
    revision = json.loads(manifest.read_text())["revision"][:12] if manifest.exists() else "local"
    return f"{directory.name}@{revision}"


def load_backends(settings: Settings) -> Backends:
    """Loads every model present; a missing one leaves its capability unavailable."""
    from model_service.gliner import GlinerOnnx
    from model_service.onnx_models import OnnxCrossEncoder, OnnxEmbedder

    def present(capability: str) -> Path | None:
        directory = settings.models_dir / MODEL_DIRS[capability]
        if (directory / "model.onnx").exists():
            return directory
        log.warning("model for %s not found in %s; capability unavailable", capability, directory)
        return None

    embed, rerank, nli, ner = (present(c) for c in ("embed", "rerank", "nli", "ner"))
    if settings.extract_gguf:
        extractor: HeuristicExtractor | LlamaExtractor = LlamaExtractor(
            settings.extract_gguf, f"{settings.extract_gguf.stem}@gguf"
        )
    else:
        extractor = HeuristicExtractor()
    return Backends(
        embedder=OnnxEmbedder(embed, model_id(embed)) if embed else None,
        reranker=OnnxCrossEncoder(rerank, model_id(rerank)) if rerank else None,
        nli=OnnxCrossEncoder(nli, model_id(nli)) if nli else None,
        ner=GlinerOnnx(ner, model_id(ner)) if ner else None,
        extractor=extractor,
    )
