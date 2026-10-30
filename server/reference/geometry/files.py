"""Shared on-disk measurements. Importing this module never loads a model."""
from __future__ import annotations

import json
import os
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[3]
DATA = ROOT / ".littletake" / "geometry"
VENDOR = DATA / "vendor"


@contextmanager
def measurement_lock(path: Path):
    """OS-released lock: prevent duplicate inference and concurrent checkpoints."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+b") as lock:
        lock.seek(0, os.SEEK_END)
        if lock.tell() == 0:
            lock.write(b"\0"); lock.flush()
        lock.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise RuntimeError("SAM segmentation is already running. No additional model was started.") from None
        try:
            yield
        finally:
            lock.seek(0)
            if os.name == "nt":
                msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(lock, fcntl.LOCK_UN)


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8", newline="\n")
    for attempt in range(6):
        try:
            os.replace(temporary, path)
            break
        except PermissionError as error:
            # Windows readers/virus scanners can briefly deny atomic replacement.
            # Keep the prior complete JSON until its sharing handle is released.
            if os.name != "nt" or getattr(error, "winerror", None) not in (5, 32, 33) or attempt == 5:
                raise
            time.sleep(.05 * 2**attempt)


def require_frame(run: Path) -> dict:
    frame = read_json(run / "frame.json")
    if frame.get("format") != "LittleTake.reference-frame" or frame.get("version") != 1:
        raise ValueError("Unsupported frame measurement format.")
    return frame


def model_manifest() -> dict:
    path = DATA / "models.json"
    if not path.exists():
        raise RuntimeError("Model files are not prepared. Run the explicit prepare command first.")
    return read_json(path)


def source_path(name: str, manifest: dict) -> Path:
    path = VENDOR / name
    # VGGT is a namespace package and intentionally has no top-level __init__.py.
    entry = "sam3/__init__.py" if name == "sam3" else "vggt/models/vggt.py"
    if not (path / entry).is_file():
        raise RuntimeError(f"Missing {name} source. Run prepare first.")
    import subprocess
    revision = subprocess.check_output(["git", "-C", str(path), "rev-parse", "HEAD"], text=True).strip()
    if revision != manifest[name]["sourceRevision"]:
        raise RuntimeError(f"{name} source differs from the prepared model manifest. Run prepare explicitly.")
    return path


def local_checkpoint(name: str, manifest: dict) -> str:
    from huggingface_hub import hf_hub_download
    if name not in manifest:
        raise RuntimeError(f"{name} is not prepared. Run the explicit prepare command first.")
    model = manifest[name]
    # Inference never downloads weights or silently changes the checkpoint.
    return hf_hub_download(model["repo"], model["filename"], revision=model["revision"], local_files_only=True)
