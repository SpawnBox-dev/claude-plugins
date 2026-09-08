#!/usr/bin/env python3
"""
Minimal Python HTTP server wrapping an ONNX sentence-embedding model.

Usage:
    python embed_server.py --port-file /tmp/embed.port [--port 0] [--model BAAI/bge-base-en-v1.5]

Endpoints:
    GET  /health -> {"status": "ready", "model": "<loaded model id>", "dim": 768}
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


# Largest batch handed to ONNX in one forward pass.
#
# 🔴 THIS BOUNDS A PERMANENT LEAK, NOT JUST A TRANSIENT SPIKE. Measured
# 2026-09-05 on a sidecar that had reached 9.7 GB RSS on a 32 GB box shared by
# the whole fleet, while Windows was killing background tasks during a
# production deploy.
#
# ONNX Runtime's CPU memory arena (SessionOptions.enable_cpu_mem_arena, ON by
# default) grows to the largest allocation it has ever served and NEVER RETURNS
# IT. An unchunked _embed passes the caller's whole list to encode_batch, so a
# single large call permanently raises the process floor. Measured, same box,
# same model, identical workload:
#
#   phase                     unchunked      chunked(32)
#   model loaded, 0 calls        505 MB          505 MB
#   400 calls of batch=1         508 MB          508 MB   <- call COUNT is not it
#   one batch=256              1,906 MB          709 MB
#   one batch=512              3,402 MB          714 MB
#   after 100 more small calls 3,402 MB          713 MB   <- never returned
#   PEAK working set           3,572 MB          743 MB
#
# So growth tracks the LARGEST BATCH EVER EMBEDDED, not uptime and not call
# count - which is why a sidecar doing ordinary query traffic sits near
# baseline for days and one that served a single backfill stays huge until it
# is killed. Chunking bounds both the retained floor and the transient peak;
# the peak is the one that actually gets a process OOM-killed mid-deploy.
#
# Disabling the arena also bounds the floor (520 MB) but leaves a 2,595 MB
# transient peak, so chunking is the better lever and the arena is left on for
# its speed. Raising this constant re-raises the ceiling proportionally.
MAX_BATCH = 32


def _embed(texts: list[str]) -> list[list[float]]:
    """Embed in bounded chunks so one large call cannot raise the floor."""
    if len(texts) <= MAX_BATCH:
        return _embed_batch(texts)

    out: list[list[float]] = []
    for i in range(0, len(texts), MAX_BATCH):
        out.extend(_embed_batch(texts[i:i + MAX_BATCH]))
    return out


def _embed_batch(texts: list[str]) -> list[list[float]]:
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


def _rss_mb() -> tuple[float, float]:
    """(resident MB, peak resident MB). Best-effort, never raises: this is
    diagnostics, and a /health that 500s because a memory probe failed would be
    strictly worse than one that reports nulls."""
    try:
        if sys.platform == "win32":
            import ctypes
            import ctypes.wintypes as wt

            class PMC(ctypes.Structure):
                _fields_ = [
                    ("cb", wt.DWORD), ("PageFaultCount", wt.DWORD),
                    ("PeakWorkingSetSize", ctypes.c_size_t),
                    ("WorkingSetSize", ctypes.c_size_t),
                    ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                    ("PagefileUsage", ctypes.c_size_t),
                    ("PeakPagefileUsage", ctypes.c_size_t),
                ]

            c = PMC()
            c.cb = ctypes.sizeof(c)
            # restype MUST be set. GetCurrentProcess returns the pseudo-handle
            # (HANDLE)-1; with ctypes' default c_int restype that truncates to
            # 32 bits on a 64-bit build, GetProcessMemoryInfo then fails, and
            # this function returns (None, None) through a perfectly clean path
            # with no exception raised. /health kept serving 200 with null
            # memory fields, which reads as "the sidecar does not report this"
            # rather than "the probe is broken".
            k32 = ctypes.windll.kernel32
            k32.GetCurrentProcess.restype = ctypes.c_void_p
            h = ctypes.c_void_p(k32.GetCurrentProcess())
            if ctypes.windll.psapi.GetProcessMemoryInfo(h, ctypes.byref(c), c.cb):
                return (round(c.WorkingSetSize / 1048576, 1),
                        round(c.PeakWorkingSetSize / 1048576, 1))
            return (None, None)

        import resource
        peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        # Linux reports KB, macOS bytes.
        peak_mb = peak / 1024 if sys.platform.startswith("linux") else peak / 1048576
        rss_mb = None
        try:
            with open("/proc/self/statm") as f:
                rss_mb = round(int(f.read().split()[1]) * os.sysconf("SC_PAGE_SIZE") / 1048576, 1)
        except Exception:
            pass
        return (rss_mb, round(peak_mb, 1))
    except Exception:
        return (None, None)


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
            # rss_mb and peak_rss_mb let a caller (and system_status) see the
            # sidecar's footprint without a process survey. Tonight's 9.7 GB
            # sidecar was invisible until someone ran Win32_Process by hand, and
            # the process that LOOKED like the sidecar (largest RSS) was an
            # orphan nothing routed to - so the number belongs on the endpoint
            # that identity is already established through.
            rss, peak = _rss_mb()
            self._send_json(200, {
                "status": "ready",
                "model": _model_id,
                "dim": _embedding_dim,
                "pid": os.getpid(),
                "rss_mb": rss,
                "peak_rss_mb": peak,
                "max_batch": MAX_BATCH,
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
    parser.add_argument("--model", default="BAAI/bge-base-en-v1.5", help="HuggingFace model ID")
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
