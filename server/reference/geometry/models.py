"""Local VGGT depth and camera execution, and shared CUDA availability guard."""
from __future__ import annotations

import gc
import sys
import time
from pathlib import Path

from files import local_checkpoint, model_manifest, read_json, require_frame, source_path, write_json


def cuda_guard(min_free_gb: float):
    import torch
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is unavailable. No CPU/model substitution was made; VGGT can be explicitly requested on CPU.")
    torch.cuda.set_device(0)
    free, _ = torch.cuda.mem_get_info()
    if free < min_free_gb * 1024**3:
        raise RuntimeError(f"Only {free / 1024**3:.1f} GiB VRAM free; this step requires {min_free_gb:g} GiB. Other workloads were left running.")
    return torch


def depth(run: Path, device: str, min_free_gb: float, context_runs: list[Path] | None = None) -> None:
    import numpy as np
    from PIL import Image
    runs = [run, *(context_runs or [])]
    frames = [require_frame(target) for target in runs]
    if len({frame["id"] for frame in frames}) != len(frames):
        raise ValueError("Joint views must identify different saved source frames.")
    if any((target / "geometry.json").exists() for target in runs):
        raise RuntimeError("Geometry already exists. Layout changes reuse it; use new run folders to remeasure.")
    manifest = model_manifest()
    checkpoint = local_checkpoint("vggt", manifest)
    if device == "cuda":
        torch = cuda_guard(min_free_gb)
        torch.cuda.reset_peak_memory_stats()
    else:
        import torch
        torch.set_num_threads(8)
    sys.path.insert(0, str(source_path("vggt", manifest)))
    from vggt.models.vggt import VGGT
    from vggt.utils.pose_enc import pose_encoding_to_extri_intri
    torch.manual_seed(0)
    started = time.perf_counter()
    print(f"Loading the prepared local VGGT checkpoint on {device}.", flush=True)
    # Reproduce the official square-padding preprocessor with its exact pixel transform.
    size = 518
    inputs, mappings, padded_inputs = [], [], []
    for target in runs:
        with Image.open(target / "frame.png") as source:
            image = source.convert("RGB")
        width, height = image.size
        side = max(width, height)
        left, top = (side - width) // 2, (side - height) // 2
        padded = Image.new("RGB", (side, side))
        padded.paste(image, (left, top))
        padded = padded.resize((size, size), Image.Resampling.BICUBIC)
        inputs.append(torch.from_numpy(np.asarray(padded, dtype=np.float32) / 255).permute(2, 0, 1))
        scale = size / side
        mappings.append(np.array([[scale, 0, scale * (left + .5) - .5], [0, scale, scale * (top + .5) - .5], [0, 0, 1]]))
        padded_inputs.append(padded)
    images = torch.stack(inputs).to(device)
    model = VGGT(enable_point=False, enable_track=False)
    state = torch.load(checkpoint, map_location="cpu", weights_only=True)
    ignored = ("point_head.", "track_head.")
    state = {key: value for key, value in state.items() if not key.startswith(ignored)}
    model.load_state_dict(state, strict=True)
    del state
    model.eval().to(device)
    if device == "cuda":
        torch.cuda.synchronize()
    load_seconds = time.perf_counter() - started
    from contextlib import nullcontext
    dtype = torch.bfloat16 if device == "cuda" and torch.cuda.is_bf16_supported() else torch.float16
    precision = torch.autocast("cuda", dtype=dtype) if device == "cuda" else nullcontext()
    try:
        inference_started = time.perf_counter()
        with torch.inference_mode(), precision:
            print(f"Estimating depth and camera jointly for {len(runs)} saved view(s).", flush=True)
            predictions = model(images)
            extrinsic, intrinsic = pose_encoding_to_extri_intri(predictions["pose_enc"].float(), (size, size))
        if device == "cuda":
            torch.cuda.synchronize()
        inference_seconds = time.perf_counter() - inference_started
        for index, (target, frame, affine, padded) in enumerate(zip(runs, frames, mappings, padded_inputs)):
            d = predictions["depth"][0, index, ..., 0].float().cpu().numpy()
            confidence = predictions["depth_conf"][0, index].float().cpu().numpy()
            k = intrinsic[0, index].float().cpu().numpy()
            e = extrinsic[0, index].float().cpu().numpy()
            np.savez_compressed(target / "geometry.npz", depth=d, confidence=confidence, intrinsics=k, extrinsics=e, image_to_depth=affine)
            padded.save(target / "depth-input.png")
            write_json(target / "geometry.json", {"format": "LittleTake.reference-geometry", "version": 1, "frameId": frame["id"],
                   "model": manifest["vggt"], "device": device, "depthFile": "geometry.npz", "depthSize": [size, size],
                   "imageSize": [frame["width"], frame["height"]], "imageToDepth": affine.tolist(),
                   "cameraConvention": "opencv-world-to-camera", "depthConvention": "camera-z", "intrinsicsUnits": "pixels",
                   "pixelConvention": "zero-indexed pixel centers", "scale": "relative",
                   "confidence": "uncalibrated model scores; not probabilities",
                   "runtime": {"torch": torch.__version__, "cuda": torch.version.cuda,
                               "deviceName": torch.cuda.get_device_name(0) if device == "cuda" else "CPU",
                               "precision": str(dtype) if device == "cuda" else "float32",
                               "loadSeconds": load_seconds, "inferenceSeconds": inference_seconds,
                               "peakAllocatedGiB": torch.cuda.max_memory_allocated() / 1024**3 if device == "cuda" else None,
                               "peakReservedGiB": torch.cuda.max_memory_reserved() / 1024**3 if device == "cuda" else None,
                               "heads": ["camera", "depth"], "inputFrames": len(runs),
                               "referenceFrameIds": [source["id"] for source in frames],
                               "timingScope": "Shared model load and joint forward pass, not separate per-frame costs."},
                   "elapsedSeconds": time.perf_counter() - started})
    finally:
        del model, images
        gc.collect()
        if device == "cuda":
            torch.cuda.empty_cache()
