"""Explicit source/weight preparation, separate from inference and serving reports."""
from __future__ import annotations

import subprocess
import sys
import tomllib
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path

from files import DATA, VENDOR, read_json, write_json, measurement_lock, source_path, local_checkpoint

SOURCES = {
    "sam3": ("https://github.com/facebookresearch/sam3.git", "f1647e8d0c1d280991f4d1b7d974c2704537fe66"),
    "vggt": ("https://github.com/facebookresearch/vggt.git", "a288dd0f14786c93483e45524328726ab7b1b4ce"),
    "sam3dbody": ("https://github.com/facebookresearch/sam-3d-body.git", "b5c765a0d89d789985e186d396315e7590887b94"),
}
# Python package directory checked out from each source repository.
PACKAGES = {"sam3": "sam3", "vggt": "vggt", "sam3dbody": "sam_3d_body"}
# Additional files the loader reads next to the main checkpoint.
EXTRA_FILES = {"sam3dbody": ["model_config.yaml", "assets/mhr_model.pt"]}


def prepare(vggt_repo: str, model: str = "vggt") -> None:
    with measurement_lock(DATA / "prepare.lock", "Model preparation is already running. No additional download was started."):
        _prepare(vggt_repo, model)


def _prepare(vggt_repo: str, model: str) -> None:
    from huggingface_hub import HfApi, hf_hub_download
    path = DATA / "models.json"
    manifest = read_json(path) if path.exists() else {"format": "LittleTake.local-geometry-models", "version": 1}
    specs = {
        "sam3": ("facebook/sam3.1", "sam3.1_multiplex.pt"),
        "vggt": (vggt_repo, "vggt_1B_commercial.pt" if vggt_repo.endswith("-Commercial") else "model.pt"),
        "sam3dbody": ("facebook/sam-3d-body-dinov3", "model.ckpt"),
    }
    VENDOR.mkdir(parents=True, exist_ok=True)
    for name, (url, revision) in SOURCES.items():
        if model != "all" and model != name:
            continue
        repo, filename = specs[name]
        existing = manifest.get(name, {})
        same_weights = existing.get("repo") == repo and existing.get("filename") == filename
        if same_weights and existing.get("sourceRevision") == revision:
            try:
                source_path(name, manifest)
                local_checkpoint(name, manifest)
            except Exception:
                pass  # Complete missing local files using the saved checkpoint revision.
            else:
                print(f"Reusing prepared {repo}; no download, model load or inference.", flush=True)
                continue
        model_revision = (existing.get("revision") if same_weights else None) or ("daa63191845a41281374e725f4c9e51c7a824460" if name == "sam3" else HfApi().model_info(repo).sha)
        print(f"Preparing {repo} weights; no inference is performed.", flush=True)
        for file in [filename, *EXTRA_FILES.get(name, [])]:
            hf_hub_download(repo, file, revision=model_revision)
        folder = VENDOR / name
        if not (folder / ".git").exists():
            subprocess.run(["git", "clone", "--filter=blob:none", "--no-checkout", url, str(folder)], check=True)
        # Also completes an interrupted clone, without deleting its partial files.
        subprocess.run(["git", "-C", str(folder), "config", "remote.origin.promisor", "true"], check=True)
        subprocess.run(["git", "-C", str(folder), "config", "remote.origin.partialclonefilter", "blob:none"], check=True)
        subprocess.run(["git", "-C", str(folder), "fetch", "--filter=blob:none", "--depth", "1", "origin", revision], check=True)
        subprocess.run(["git", "-C", str(folder), "sparse-checkout", "set", "--cone", PACKAGES[name]], check=True)
        subprocess.run(["git", "-C", str(folder), "checkout", "--detach", revision], check=True)
        manifest[name] = {"repo": repo, "filename": filename, "revision": model_revision, "sourceRevision": revision}
        if name in EXTRA_FILES:
            manifest[name]["extraFiles"] = EXTRA_FILES[name]
        write_json(path, manifest)
    print("Local model files prepared.", flush=True)


def environment_status(include_sam: bool = False) -> dict:
    from packaging.requirements import Requirement
    from packaging.specifiers import SpecifierSet
    project = tomllib.loads(Path(__file__).with_name("pyproject.toml").read_text(encoding="utf-8"))["project"]
    requirements = [*project["dependencies"], *(project["optional-dependencies"]["sam"] if include_sam else [])]
    missing = []
    for item in requirements:
        requirement = Requirement(item)
        if requirement.marker and not requirement.marker.evaluate():
            continue
        try:
            if requirement.specifier.contains(version(requirement.name)):
                continue
        except PackageNotFoundError:
            pass
        missing.append(str(requirement))
    python = ".".join(map(str, sys.version_info[:3]))
    return {"ready": not missing and SpecifierSet(project["requires-python"]).contains(python), "python": python, "includeSam": include_sam, "missing": missing}


def model_status(include_sam: bool = False) -> dict:
    path = DATA / "models.json"
    manifest = read_json(path) if path.exists() else {}
    result = {"dataDirectory": str(DATA), "inference": "not run", "dependencies": environment_status(include_sam), "models": {}}
    for name in SOURCES:
        model = manifest.get(name)
        if not model:
            result["models"][name] = {"ready": False, "detail": "Not prepared; local SAM is optional when SAM_PROVIDER=cloud." if name == "sam3" else "Run setup.bat vggt."}
            continue
        try:
            source = source_path(name, manifest)
            checkpoint = local_checkpoint(name, manifest)
            result["models"][name] = {"ready": True, "repo": model["repo"], "revision": model["revision"], "source": str(source), "checkpoint": checkpoint}
        except Exception:
            result["models"][name] = {"ready": False, "repo": model.get("repo"), "detail": "Local source or checkpoint unavailable; rerun setup.bat vggt or setup.bat sam."}
    return result
