"""Local SAM 3D Body: full-body 3D joints for the people in one saved reference frame.

`estimate` is the only function that loads a model, and only from prepared offline
files. `ground_body` is pure NumPy and is reused by the layout step to place each
skeleton in the shared ground frame of the VGGT reconstruction.
"""
from __future__ import annotations

import math
import sys
import time
from pathlib import Path

import numpy as np

from files import DATA, local_files, measurement_lock, model_manifest, read_json, require_frame, source_path, write_json

FORMAT = "LittleTake.reference-bodies"
# Indices in SAM 3D Body's MHR70 keypoint order; checked against the prepared source before inference.
JOINTS = {"nose": 0, "left-shoulder": 5, "right-shoulder": 6, "left-elbow": 7, "right-elbow": 8, "left-hip": 9, "right-hip": 10,
          "left-knee": 11, "right-knee": 12, "left-ankle": 13, "right-ankle": 14, "left-big-toe-tip": 15, "left-heel": 17,
          "right-big-toe-tip": 18, "right-heel": 20, "right-wrist": 41, "left-wrist": 62, "neck": 69}
BONES = [("nose", "neck"), ("neck", "left-shoulder"), ("neck", "right-shoulder"), ("left-shoulder", "left-elbow"),
         ("left-elbow", "left-wrist"), ("right-shoulder", "right-elbow"), ("right-elbow", "right-wrist"),
         ("left-shoulder", "left-hip"), ("right-shoulder", "right-hip"), ("left-hip", "right-hip"),
         ("left-hip", "left-knee"), ("left-knee", "left-ankle"), ("right-hip", "right-knee"), ("right-knee", "right-ankle"),
         ("left-ankle", "left-heel"), ("left-ankle", "left-big-toe-tip"), ("right-ankle", "right-heel"), ("right-ankle", "right-big-toe-tip")]
BONE_INDICES = [[JOINTS[a], JOINTS[b]] for a, b in BONES]
TORSO = [JOINTS[name] for name in ("left-shoulder", "right-shoulder", "left-hip", "right-hip")]
HIPS = [JOINTS["left-hip"], JOINTS["right-hip"]]
FEET = [JOINTS[name] for name in ("left-ankle", "right-ankle", "left-heel", "right-heel", "left-big-toe-tip", "right-big-toe-tip")]
# Pelvis height above the lowest foot joint, in metres of the body model.
STANDING_PELVIS, SEATED_PELVIS = .75, .62


def frame_intrinsics(k: np.ndarray, image_to_depth: np.ndarray) -> np.ndarray:
    """VGGT intrinsics expressed in saved source-crop pixels, the coordinates of frame.png and masks."""
    return np.linalg.inv(image_to_depth) @ k


def person_instances(run: Path, segmentation: dict, concepts: list[str]) -> list[dict]:
    """Person masks in segmentation order; synonymous concepts with the same mask count once, as in layout."""
    from PIL import Image
    names, people = {concept.casefold() for concept in concepts}, []
    for item in segmentation["instances"]:
        if item["concept"].casefold() not in names:
            continue
        mask = np.asarray(Image.open(run / item["mask"]).convert("L")) > 127
        if any(np.logical_and(other["pixels"], mask).sum() / max(1, np.logical_or(other["pixels"], mask).sum()) > .85 for other in people):
            continue
        people.append({"item": item, "pixels": mask})
    return people


def reprojection(points: np.ndarray, intrinsics: np.ndarray, pixels: np.ndarray) -> float:
    projected = points @ intrinsics.T
    return float(np.median(np.linalg.norm(projected[:, :2] / projected[:, 2:3] - pixels, axis=-1)))


def record_people(people: list[dict], outputs: list[dict], intrinsics: np.ndarray, size: tuple[int, int]) -> list[dict]:
    """Model outputs to saved per-person joints. Camera joints are OpenCV camera coordinates in body-model metres."""
    if len(outputs) != len(people):
        raise RuntimeError("SAM 3D Body returned a different number of people than the prompted boxes.")
    width, height, saved = size[0], size[1], []
    for person, output in zip(people, outputs, strict=True):
        joints = np.asarray(output["pred_keypoints_3d"], dtype=float) + np.asarray(output["pred_cam_t"], dtype=float)
        pixels = np.asarray(output["pred_keypoints_2d"], dtype=float)
        if joints.shape != (70, 3) or pixels.shape != (70, 2) or not np.isfinite(joints).all() or not np.isfinite(pixels).all() or (joints[:, 2] <= 0).any():
            raise RuntimeError("SAM 3D Body returned invalid joints; nothing was saved for this frame.")
        item = person["item"]
        inside = (pixels[:, 0] >= 0) & (pixels[:, 0] < width) & (pixels[:, 1] >= 0) & (pixels[:, 1] < height)
        saved.append({"id": item["id"], "concept": item["concept"], "mask": item["mask"], "box": item["box"], "maskScore": item["score"],
                      "cameraJoints": np.round(joints, 6).tolist(), "imageJoints": np.round(pixels, 3).tolist(),
                      "focalLength": float(np.asarray(output["focal_length"]).reshape(-1)[0]),
                      "jointsInsideFrame": int(inside.sum()), "feetInsideFrame": bool(inside[FEET].all()),
                      # The model projects about the image centre; grounding re-anchors on the VGGT principal point.
                      "reprojectionMedianPixels": reprojection(joints, intrinsics, pixels)})
    return saved


def estimate(run: Path, concepts: list[str], min_free_gb: float) -> None:
    from PIL import Image
    frame = require_frame(run)
    segmentation = read_json(run / "segmentation.json")
    if segmentation.get("frameId") != frame["id"] or segmentation.get("status", "complete") != "complete":
        raise ValueError("Complete segmentation of this exact saved frame first.")
    if not (run / "geometry.json").exists():
        raise ValueError("Run depth first so bodies share the VGGT camera; no default camera was assumed.")
    if (run / "bodies.json").exists():
        raise RuntimeError("Bodies already exist for this run. Use a new run folder to remeasure.")
    geometry = read_json(run / "geometry.json")
    if geometry.get("frameId") != frame["id"]:
        raise ValueError("Depth belongs to a different saved frame.")
    with np.load(run / geometry["depthFile"], allow_pickle=False) as arrays:
        intrinsics = frame_intrinsics(arrays["intrinsics"], arrays["image_to_depth"])
    people = person_instances(run, segmentation, concepts)
    if not people:
        raise ValueError("No person masks in this frame; segment a person concept first. No body was guessed.")
    manifest = model_manifest()
    files = local_files("sam3dbody", manifest)
    with measurement_lock(run / "body.lock", "SAM 3D Body is already running for this run."), \
            measurement_lock(DATA / "sam3dbody-local.lock", "Another SAM 3D Body process holds the GPU. No additional model was started."):
        from models import cuda_guard
        torch = cuda_guard(min_free_gb)
        torch.cuda.reset_peak_memory_stats()
        sys.path.insert(0, str(source_path("sam3dbody", manifest)))
        from sam_3d_body import SAM3DBodyEstimator, load_sam_3d_body
        from sam_3d_body.metadata.mhr70 import mhr_names
        if any(mhr_names[index] != name for name, index in JOINTS.items()):
            raise RuntimeError("The prepared SAM 3D Body keypoint order differs from this module.")
        torch.manual_seed(0)
        started = time.perf_counter()
        print("Loading the prepared local SAM 3D Body checkpoint; no hosted inference.", flush=True)
        model, config = load_sam_3d_body(files["model.ckpt"], device="cuda", mhr_path=files["assets/mhr_model.pt"])
        estimator = SAM3DBodyEstimator(sam_3d_body_model=model, model_cfg=config)
        loaded = time.perf_counter()
        image = np.asarray(Image.open(run / "frame.png").convert("RGB"))
        boxes = np.array([person["item"]["box"] for person in people], dtype=np.float32)
        masks = np.stack([person["pixels"] for person in people]).astype(np.uint8)
        # Mask prompts skip the model's own detector and segmenter; the VGGT camera replaces its FOV estimate.
        outputs = estimator.process_one_image(image, bboxes=boxes, masks=masks,
                                              cam_int=torch.tensor(intrinsics[None], dtype=torch.float32))
        runtime = {"device": torch.cuda.get_device_name(0), "torch": torch.__version__, "cuda": torch.version.cuda,
                   "loadSeconds": loaded - started, "inferenceSeconds": time.perf_counter() - loaded,
                   "peakVramGiB": torch.cuda.max_memory_allocated() / 1024**3, "provider": "local"}
    write_json(run / "bodies.json", {
        "format": FORMAT, "version": 1, "frameId": frame["id"], "status": "complete", "model": manifest["sam3dbody"], "runtime": runtime,
        "camera": {"intrinsics": intrinsics.tolist(), "source": "VGGT, source-crop pixels", "geometryFrameId": geometry["frameId"]},
        "jointFormat": "MHR70", "joints": JOINTS, "bones": BONE_INDICES,
        "people": record_people(people, outputs, intrinsics, (frame["width"], frame["height"])),
        "assumptions": ["Single image per person; occluded and out-of-frame joints are model predictions, not observations.",
                        "Camera joints use the body model's metric scale; the layout step rescales them to the VGGT depth."]})
    print(f"Saved {len(people)} body estimate(s). Run layout to place them in the scene.", flush=True)


def ground_body(person: dict, surface_depth: float, intrinsics: np.ndarray, extrinsics: np.ndarray,
                origin: np.ndarray, basis: np.ndarray, scale: float) -> dict:
    """Place one saved skeleton in the layout's ground frame (Y up, floor at 0).

    The torso is moved onto the rays through its observed pixels under the VGGT camera,
    then the whole skeleton is scaled about the camera centre so the torso depth matches
    the VGGT surface depth of the person's mask. Scaling about the camera centre keeps
    every joint's projection unchanged.
    """
    joints = np.asarray(person["cameraJoints"], dtype=float)
    pixels = np.asarray(person["imageJoints"], dtype=float)
    # Each torso joint moved onto its own pixel ray at its own depth; the mean shift is applied to every joint.
    rays = np.column_stack((pixels[TORSO], np.ones(len(TORSO)))) @ np.linalg.inv(intrinsics).T
    anchored = joints + (rays * joints[TORSO, 2:3] - joints[TORSO]).mean(axis=0)
    torso_depth = float(np.median(anchored[TORSO, 2]))
    if not (math.isfinite(surface_depth) and surface_depth > 0 and torso_depth > 0):
        raise ValueError("Body and surface depth must be positive.")
    factor = surface_depth / torso_depth
    world = (anchored * factor - extrinsics[:, 3]) @ extrinsics[:, :3]
    aligned = (world - origin) @ basis.T * scale
    units = factor * scale  # layout units per body-model metre
    left = aligned[[JOINTS["left-shoulder"], JOINTS["left-hip"]]].mean(axis=0)
    right = aligned[[JOINTS["right-shoulder"], JOINTS["right-hip"]]].mean(axis=0)
    across = (left - right) * np.array([1., 0., 1.])
    if np.linalg.norm(across) < 1e-9 * max(1., units):
        raise ValueError("Shoulders and hips are vertically aligned; facing is undefined.")
    # Facing +Z with Y up puts the person's left side at +X, so forward = left x up.
    forward = np.cross(across / np.linalg.norm(across), [0., 1., 0.])
    toes = (aligned[[JOINTS["left-big-toe-tip"], JOINTS["right-big-toe-tip"]]].mean(axis=0)
            - aligned[[JOINTS["left-heel"], JOINTS["right-heel"]]].mean(axis=0)) * np.array([1., 0., 1.])
    agreement = float(np.dot(forward, toes / np.linalg.norm(toes))) if np.linalg.norm(toes) > 1e-9 else None
    root = aligned[HIPS].mean(axis=0)
    foot = float(aligned[FEET, 1].min())
    pelvis_height = (root[1] - foot) / units
    posture = "standing" if pelvis_height >= STANDING_PELVIS else "seated or crouching" if pelvis_height <= SEATED_PELVIS else "unclear"
    assumptions = ["Torso joints lie inside the body while VGGT measures its visible surface; depth may be biased by about the body's half thickness."]
    if not person["feetInsideFrame"]:
        assumptions.append("Feet are outside the frame; ground contact comes from the predicted skeleton.")
    if agreement is not None and agreement < .3:
        assumptions.append("Torso and feet point in different directions; facing follows the torso.")
    return {"id": person["id"], "joints": np.round(aligned, 6).tolist(), "root": root.tolist(), "groundPoint": [float(root[0]), foot, float(root[2])],
            "facingYaw": math.degrees(math.atan2(forward[0], forward[2])), "facingAgreementWithFeet": agreement,
            "unitsPerMetre": units, "pelvisHeightMetres": float(pelvis_height), "posture": posture,
            "surfaceDepth": surface_depth, "torsoDepth": torso_depth, "assumptions": assumptions}


def metric_hint(bodies: list[dict], units: str) -> dict | None:
    """Human-size scale suggestion for relative layouts; never applied automatically."""
    if units != "relative" or not bodies:
        return None
    values = np.array([body["unitsPerMetre"] for body in bodies])
    return {"layoutUnitsPerMetre": float(np.median(values)), "spread": [float(values.min()), float(values.max())], "people": len(values),
            "note": "SAM 3D Body predicts adult-plausible body size. This is a suggestion; use --known-height for a verified scale."}
