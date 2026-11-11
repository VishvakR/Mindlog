"""PLAN 18.4: the sidecar requires a client certificate from the cluster CA."""

import asyncio
import subprocess
from pathlib import Path

import grpc
import numpy as np
import numpy.typing as npt
import pytest
from mindlog.v1 import models_pb2, models_pb2_grpc
from model_service.server import Backends, Limits, serve


class OneHotEmbedder:
    model_id = "fake-embed@1"

    def embed(self, texts: list[str], kind: str) -> npt.NDArray[np.float32]:
        return np.eye(len(texts), 4, dtype=np.float32)


def openssl(cwd: Path, *args: str) -> None:
    subprocess.run(["openssl", *args], cwd=cwd, check=True, capture_output=True)


def make_ca(cwd: Path, name: str) -> None:
    openssl(cwd, "ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", f"{name}.key")
    openssl(
        cwd, "req", "-x509", "-new", "-key", f"{name}.key", "-subj", f"/CN={name}",
        "-days", "2", "-out", f"{name}.pem",
    )  # fmt: skip


def make_leaf(cwd: Path, ca: str, name: str) -> None:
    (cwd / "ext.cnf").write_text("subjectAltName=DNS:localhost,IP:127.0.0.1\n")
    openssl(cwd, "ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", f"{name}.key")
    subject = f"/CN={name}"
    openssl(cwd, "req", "-new", "-key", f"{name}.key", "-subj", subject, "-out", f"{name}.csr")
    openssl(
        cwd, "x509", "-req", "-in", f"{name}.csr", "-CA", f"{ca}.pem", "-CAkey", f"{ca}.key",
        "-set_serial", "7", "-days", "2", "-extfile", "ext.cnf", "-out", f"{name}.pem",
    )  # fmt: skip


async def embed_with(port: int, tmp: Path, ca: str, leaf: str | None) -> list[int]:
    credentials = grpc.ssl_channel_credentials(
        root_certificates=(tmp / f"{ca}.pem").read_bytes(),
        private_key=(tmp / f"{leaf}.key").read_bytes() if leaf else None,
        certificate_chain=(tmp / f"{leaf}.pem").read_bytes() if leaf else None,
    )
    async with grpc.aio.secure_channel(f"localhost:{port}", credentials) as channel:
        stub = models_pb2_grpc.ModelsServiceStub(channel)
        reply = await stub.Embed(models_pb2.EmbedRequest(texts=["a"]), timeout=5)
        return [len(reply.vectors)]


def test_mutual_tls(tmp_path: Path) -> None:
    make_ca(tmp_path, "ca")
    make_ca(tmp_path, "other")
    make_leaf(tmp_path, "ca", "server")
    make_leaf(tmp_path, "ca", "client")
    make_leaf(tmp_path, "other", "intruder")
    paths = (str(tmp_path / "ca.pem"), str(tmp_path / "server.pem"), str(tmp_path / "server.key"))

    async def go() -> None:
        backends = Backends(embedder=OneHotEmbedder())
        server, port = await serve(backends, "127.0.0.1", 0, Limits(), paths)
        try:
            assert await embed_with(port, tmp_path, "ca", "client") == [1]
            for leaf in ("intruder", None):
                with pytest.raises(grpc.aio.AioRpcError):
                    await embed_with(port, tmp_path, "ca", leaf)
        finally:
            await server.stop(grace=0)

    asyncio.run(go())
