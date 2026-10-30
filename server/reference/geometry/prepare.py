"""Explicit source/weight preparation, separate from inference and serving reports."""
from __future__ import annotations

import subprocess

from files import DATA, VENDOR, read_json, write_json

SOURCES = {
    "sam3": ("https://github.com/facebookresearch/sam3.git", "f1647e8d0c1d280991f4d1b7d974c2704537fe66"),
    "vggt": ("https://github.com/facebookresearch/vggt.git", "a288dd0f14786c93483e45524328726ab7b1b4ce"),
}


def prepare(vggt_repo: str, model: str = "vggt") -> None:
    from huggingface_hub import HfApi, hf_hub_download
    path = DATA / "models.json"
    manifest = read_json(path) if path.exists() else {"format": "LittleTake.local-geometry-models", "version": 1}
    specs = {
        "sam3": ("facebook/sam3.1", "sam3.1_multiplex.pt"),
        "vggt": (vggt_repo, "vggt_1B_commercial.pt" if vggt_repo.endswith("-Commercial") else "model.pt"),
    }
    VENDOR.mkdir(parents=True, exist_ok=True)
    for name, (url, revision) in SOURCES.items():
        if model != "all" and model != name:
            continue
        repo, filename = specs[name]
        model_revision = "daa63191845a41281374e725f4c9e51c7a824460" if name == "sam3" else HfApi().model_info(repo).sha
        print(f"Preparing {repo} weights; no inference is performed.", flush=True)
        hf_hub_download(repo, filename, revision=model_revision)
        folder = VENDOR / name
        if not (folder / ".git").exists():
            subprocess.run(["git", "clone", "--filter=blob:none", "--no-checkout", url, str(folder)], check=True)
        # Also completes an interrupted clone, without deleting its partial files.
        subprocess.run(["git", "-C", str(folder), "config", "remote.origin.promisor", "true"], check=True)
        subprocess.run(["git", "-C", str(folder), "config", "remote.origin.partialclonefilter", "blob:none"], check=True)
        subprocess.run(["git", "-C", str(folder), "fetch", "--filter=blob:none", "--depth", "1", "origin", revision], check=True)
        subprocess.run(["git", "-C", str(folder), "sparse-checkout", "set", "--cone", name], check=True)
        subprocess.run(["git", "-C", str(folder), "checkout", "--detach", revision], check=True)
        manifest[name] = {"repo": repo, "filename": filename, "revision": model_revision, "sourceRevision": revision}
        write_json(path, manifest)
    print("Local model files prepared.", flush=True)
