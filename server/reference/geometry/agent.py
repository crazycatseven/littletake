"""Depth request/summary for the local Agent API. Reuses the CLI's VGGT inference."""
from __future__ import annotations

import argparse
import time
from pathlib import Path

from files import measurement_lock, model_manifest, read_json, require_frame, write_json


def summarize(run: Path, regions: list[dict]) -> dict:
    import numpy as np
    from PIL import Image
    from layout import sample_source
    frame, geometry = require_frame(run), read_json(run / "geometry.json")
    if (geometry.get("frameId"), geometry.get("imageSize"), geometry.get("scale")) != (frame["id"], [frame["width"], frame["height"]], "relative"):
        raise ValueError("Depth source, dimensions or scale differ from this reference.")
    if (geometry.get("depthConvention"), geometry.get("cameraConvention"), geometry.get("intrinsicsUnits")) != ("camera-z", "opencv-world-to-camera", "pixels"):
        raise ValueError("Unsupported camera/depth conventions.")
    with np.load(run / geometry["depthFile"], allow_pickle=False) as saved:
        depth, confidence = saved["depth"], saved["confidence"]
        k, e, affine = saved["intrinsics"], saved["extrinsics"], saved["image_to_depth"]
    width, height = frame["width"], frame["height"]
    source_valid = sample_source(np.ones((height, width), dtype=bool), affine, depth.shape)
    valid = source_valid & np.isfinite(depth) & (depth > 0) & np.isfinite(confidence)
    if not valid.any():
        raise ValueError("No valid depth; no replacement distance was guessed.")
    valid &= confidence >= np.quantile(confidence[valid], .25)
    sy, sx = np.mgrid[:height, :width]
    model_uv = np.stack((sx, sy, np.ones_like(sx)), axis=-1) @ affine.T
    mx = np.clip(np.rint(model_uv[..., 0]).astype(int), 0, depth.shape[1] - 1)
    my = np.clip(np.rint(model_uv[..., 1]).astype(int), 0, depth.shape[0] - 1)
    source_depth, source_reliable = depth[my, mx], valid[my, mx]
    low, high = np.quantile(depth[valid], [.02, .98])
    display = np.rint(255 * np.nan_to_num(np.clip((source_depth - low) / max(float(high - low), 1e-9), 0, 1))).astype(np.uint8)
    display[~source_reliable] = 0
    Image.fromarray(display).save(run / "depth.png")
    source_k = np.linalg.inv(affine) @ k
    y, x = np.mgrid[:depth.shape[0], :depth.shape[1]]
    points = (np.stack((x, y, np.ones_like(x)), axis=-1) @ np.linalg.inv(k).T) * depth[..., None]
    measurements = []
    for region in regions:
        x0, y0, x1, y1 = region["box"]
        if not (0 <= x0 < x1 <= 1 and 0 <= y0 < y1 <= 1):
            raise ValueError("Expected an ordered normalized source box.")
        mask = (sx >= x0 * width) & (sx < x1 * width) & (sy >= y0 * height) & (sy < y1 * height)
        selection = sample_source(mask, affine, depth.shape) & valid
        measured = {"label": region["label"], "box": region["box"], "samples": int(selection.sum())}
        if selection.sum() < 4:
            measured.update(status="unresolved", reason="Too few reliable visible-surface depth samples.")
        else:
            values = depth[selection]
            measured.update(status="measured", depthQuantiles=dict(zip(("p10", "median", "p90"), map(float, np.quantile(values, [.1, .5, .9])))),
                            cameraSpaceCenter=np.median(points[selection], axis=0).tolist(),
                            reliableFraction=float(selection.sum() / max(1, sample_source(mask, affine, depth.shape).sum())))
        measurements.append(measured)
    grid = []
    for row in range(16):
        line = []
        for column in range(16):
            ys, xs = slice(row * height // 16, (row + 1) * height // 16), slice(column * width // 16, (column + 1) * width // 16)
            values = source_depth[ys, xs][source_reliable[ys, xs]]
            line.append(float(np.median(values)) if len(values) else None)
        grid.append(line)
    return {"sourceId": frame["source"]["sourceId"], "frameId": frame["id"], "width": width, "height": height,
            "model": geometry["model"], "device": geometry["device"], "scale": "relative",
            "camera": {"intrinsics": source_k.tolist(), "extrinsics": e.tolist(), "intrinsicsUnits": "source pixels", "convention": "OpenCV; camera +X right, +Y down, +Z forward; extrinsics world-to-camera"},
            "grid": {"rows": 16, "columns": 16, "values": grid, "coordinates": "Full source image, row-major, top-left origin; null is unreliable depth"},
            "regions": measurements, "runtime": geometry.get("runtime"),
            "visualization": {"low": float(low), "high": float(high), "mapping": "Near dark, far light; unreliable samples black; PNG is display-only"},
            "limitations": ["Single-frame relative depth, not metres; independent frames have independent scales.",
                            "Region boxes may mix foreground and background; use compact visible patches and inspect the original image.",
                            "Camera-space surface centres are not object pivots, hidden volume, a ground plane or LittleTake scene coordinates.",
                            "Confidence scores are uncalibrated; geometry does not replace rendered visual checks."]}


def request_depth(run: Path, request: dict, device: str, min_free_gb: float) -> dict:
    frame = require_frame(run)
    if request["frameId"] != frame["id"] or request["sourceId"] != frame["source"]["sourceId"]:
        raise ValueError("Request belongs to another source frame.")
    cached = (run / "geometry.json").exists()
    if cached:
        geometry = read_json(run / "geometry.json")
        if geometry["model"] != model_manifest()["vggt"] or geometry["device"] != device:
            raise ValueError("Cached depth uses a different model or device.")
    else:
        from models import depth
        depth(run, device, min_free_gb)
    return {**summarize(run, request.get("regions", [])), "cached": cached}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument("--request", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--device", choices=["cuda", "cpu"], required=True)
    parser.add_argument("--min-free-vram-gb", type=float, default=16)
    args = parser.parse_args()
    started = time.time()
    outcome = {"phase": "agent-depth", "status": "running", "request": str(args.request), "device": args.device}
    try:
        with measurement_lock(args.run / "depth-request.lock", "This reference frame is already being measured. No additional model was started."):
            result = request_depth(args.run, read_json(args.request), args.device, args.min_free_vram_gb)
        write_json(args.output, result)
        outcome.update(status="complete", cached=result["cached"])
    except BaseException as error:
        outcome.update(status="failed", errorType=type(error).__name__, message=str(error))
        raise
    finally:
        outcome["elapsedSeconds"] = time.time() - started
        write_json(args.run / "attempts" / args.request.name, outcome)


if __name__ == "__main__":
    main()
