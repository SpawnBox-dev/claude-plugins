#!/usr/bin/env python3
"""
Minimal Python HTTP server wrapping an ONNX sentence-embedding model.

Usage:
    python embed_server.py --port-file /tmp/embed.port [--port 0] [--model BAAI/bge-small-en-v1.5]

Endpoints:
    GET  /health -> {"status": "ready", "model": "<loaded model id>", "dim": 384}
    POST /embed  -> {"vectors": [[...], [...]]}  (input: {"texts": ["...", "..."]})
"""

import argparse
import atexit
import json
import logging
import os
import sys
import time
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path

import numpy as np
import onnxruntime as ort
from huggingface_hub import hf_hub_download
from tokenizers import Tokenizer

log = logging.getLogger("embed_server")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    stream=sys.stderr,
)

# ── globals filled at startup ──
_session: ort.InferenceSession = None
_tokenizer: Tokenizer = None
_input_names: list[str] = []
_output_name: str = ""
_embedding_dim: int = 0
_model_id: str = ""


def load_model(model_id: str) -> None:
    """Download (cached) and load the ONNX model + tokenizer."""
    global _session, _tokenizer, _input_names, _output_name, _embedding_dim, _model_id

    _model_id = model_id
    t0 = time.monotonic()
    log.info("Downloading/caching model %s ...", model_id)

    onnx_path = hf_hub_download(
        repo_id=model_id,
        filename="onnx/model.onnx",
    )
    # bge-m3 stores tensor weights in a separate external data file
    try:
        hf_hub_download(
            repo_id=model_id,
            filename="onnx/model.onnx_data",
        )
    except Exception:
        pass  # Some models don't have external data files
    tokenizer_path = hf_hub_download(
        repo_id=model_id,
        filename="tokenizer.json",
    )

    log.info("Loading ONNX session ...")
    sess_opts = ort.SessionOptions()
    sess_opts.inter_op_num_threads = 1
    sess_opts.intra_op_num_threads = os.cpu_count() or 4
    _session = ort.InferenceSession(onnx_path, sess_options=sess_opts)

    _tokenizer = Tokenizer.from_file(tokenizer_path)

    # ── discover actual model I/O names ──
    model_inputs = _session.get_inputs()
    model_outputs = _session.get_outputs()
    log.info("Model inputs:  %s", [(i.name, i.shape) for i in model_inputs])
    log.info("Model outputs: %s", [(o.name, o.shape) for o in model_outputs])

    _input_names = [i.name for i in model_inputs]
    _output_name = model_outputs[0].name

    # Probe embedding dimension with a dummy forward pass
    dummy = _tokenizer.encode("hello")
    feed = _build_feed([dummy])
    out = _session.run([_output_name], feed)[0]  # (1, seq, dim)
    _embedding_dim = out.shape[-1]

    elapsed = time.monotonic() - t0
    log.info(
        "Model ready: dim=%d, inputs=%s, load_time=%.1fs",
        _embedding_dim,
        _input_names,
        elapsed,
    )


def _build_feed(encodings: list) -> dict:
    """Build ONNX feed dict from tokenizer encodings, using only the
    input names the model actually expects."""
    ids = np.array([e.ids for e in encodings], dtype=np.int64)
    mask = np.array([e.attention_mask for e in encodings], dtype=np.int64)

    feed = {}
    if "input_ids" in _input_names:
        feed["input_ids"] = ids
    if "attention_mask" in _input_names:
        feed["attention_mask"] = mask
    if "token_type_ids" in _input_names:
        feed["token_type_ids"] = np.zeros_like(ids)
    return feed


def _embed(texts: list[str]) -> list[list[float]]:
    """Tokenize, run ONNX inference, mean-pool, L2-normalize."""
    _tokenizer.enable_padding(length=None)
    _tokenizer.enable_truncation(max_length=512)
    encodings = _tokenizer.encode_batch(texts)

    feed = _build_feed(encodings)
    # output shape: (batch, seq_len, dim)
    token_embeddings = _session.run([_output_name], feed)[0]

    # mean pooling with attention mask
    mask = np.array([e.attention_mask for e in encodings], dtype=np.float32)
    mask_expanded = np.expand_dims(mask, axis=-1)  # (batch, seq, 1)
    summed = np.sum(token_embeddings * mask_expanded, axis=1)  # (batch, dim)
    counts = np.clip(mask_expanded.sum(axis=1), a_min=1e-9, a_max=None)  # (batch, 1)
    pooled = summed / counts

    # L2 normalize
    norms = np.linalg.norm(pooled, axis=1, keepdims=True)
    norms = np.clip(norms, a_min=1e-12, a_max=None)
    normalized = pooled / norms

    return normalized.tolist()


class _Handler(BaseHTTPRequestHandler):
    """Handles /health and /embed requests."""

    def log_message(self, format, *args):
        """Suppress default access logging."""
        pass

    def _send_json(self, code: int, obj: dict) -> None:
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            # Report the model ACTUALLY LOADED, not a hardcoded literal.
            # This said "bge-m3" regardless of --model, so a sidecar serving
            # bge-small-en-v1.5 still announced itself as bge-m3 (caught
            # 2026-08-08 only because dim=384 contradicted it). Callers use
            # /health to decide whether an existing sidecar is safe to adopt;
            # a lie here means adopting a sidecar of the wrong model and
            # writing vectors tagged with a model that did not produce them.
            self._send_json(200, {
                "status": "ready",
                "model": _model_id,
                "dim": _embedding_dim,
            })
        else:
            self._send_json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/embed":
            self._send_json(404, {"error": "not found"})
            return

        try:
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length)
            payload = json.loads(raw)
        except Exception as e:
            self._send_json(400, {"error": f"bad request: {e}"})
            return

        texts = payload.get("texts")
        if not isinstance(texts, list) or not all(isinstance(t, str) for t in texts):
            self._send_json(400, {"error": "\"texts\" must be a list of strings"})
            return

        if len(texts) == 0:
            self._send_json(200, {"vectors": []})
            return

        try:
            vectors = _embed(texts)
            self._send_json(200, {"vectors": vectors})
        except Exception as e:
            log.exception("Embedding failed")
            self._send_json(500, {"error": str(e)})


def main() -> None:
    parser = argparse.ArgumentParser(description="ONNX embedding HTTP server")
    parser.add_argument("--port", type=int, default=0, help="Listen port (0 = dynamic)")
    parser.add_argument("--port-file", required=True, help="File to write assigned port")
    parser.add_argument("--model", default="BAAI/bge-small-en-v1.5", help="HuggingFace model ID")
    args = parser.parse_args()

    load_model(args.model)

    server = HTTPServer(("127.0.0.1", args.port), _Handler)
    actual_port = server.server_address[1]

    # Write port file
    port_path = Path(args.port_file)
    port_path.write_text(str(actual_port))
    log.info("Wrote port %d to %s", actual_port, port_path)

    # Clean up port file on exit
    def _cleanup():
        try:
            port_path.unlink(missing_ok=True)
            log.info("Deleted port file %s", port_path)
        except OSError:
            pass

    atexit.register(_cleanup)

    log.info("Listening on 127.0.0.1:%d", actual_port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info("Shutting down")
        server.shutdown()


if __name__ == "__main__":
    main()
