"""Mask + numerical depth -> gravity-aligned, editable proxy bounds.

Depth measures visible surfaces. Boxes are explicit approximations of those surfaces;
they are never presented as recovered hidden geometry or verified metric dimensions.
"""
from __future__ import annotations

import math
from pathlib import Path
import uuid

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

from files import read_json, require_frame, write_json


def unproject(depth: np.ndarray, intrinsics: np.ndarray, extrinsics: np.ndarray) -> np.ndarray:
    """OpenCV z-depth, integer pixel centers, world-to-camera [R|t]."""
    height, width = depth.shape
    y, x = np.mgrid[:height, :width]
    rays = np.stack((x, y, np.ones_like(x)), axis=-1) @ np.linalg.inv(intrinsics).T
    camera = rays * depth[..., None]
    return (camera - extrinsics[:, 3]) @ extrinsics[:, :3]


def project(points: np.ndarray, intrinsics: np.ndarray, extrinsics: np.ndarray) -> np.ndarray:
    camera = points @ extrinsics[:, :3].T + extrinsics[:, 3]
    homogeneous = camera @ intrinsics.T
    return homogeneous[..., :2] / homogeneous[..., 2:3]


def sample_source(mask: np.ndarray, image_to_depth: np.ndarray, shape: tuple[int, int]) -> np.ndarray:
    """Pull a source raster onto the depth grid, preserving the crop/padding mapping."""
    y, x = np.mgrid[:shape[0], :shape[1]]
    source = np.stack((x, y, np.ones_like(x)), axis=-1) @ np.linalg.inv(image_to_depth).T
    sx, sy = np.floor(source[..., 0] + .5).astype(int), np.floor(source[..., 1] + .5).astype(int)
    valid = (sx >= 0) & (sy >= 0) & (sx < mask.shape[1]) & (sy < mask.shape[0])
    output = np.zeros(shape, dtype=mask.dtype)
    output[valid] = mask[sy[valid], sx[valid]]
    return output


def plane(points: np.ndarray, camera: np.ndarray, tolerance: float) -> tuple[np.ndarray, np.ndarray, float]:
    if len(points) < 100:
        raise ValueError("Not enough confident floor pixels to fit a ground plane.")
    rng = np.random.default_rng(0)
    sample = points[rng.choice(len(points), min(8000, len(points)), replace=False)]
    best = np.zeros(len(sample), dtype=bool)
    for _ in range(192):
        a, b, c = sample[rng.choice(len(sample), 3, replace=False)]
        normal = np.cross(b - a, c - a)
        length = np.linalg.norm(normal)
        if length < 1e-10:
            continue
        normal /= length
        hits = np.abs((sample - a) @ normal) < tolerance
        if hits.sum() > best.sum():
            best = hits
    if best.mean() < .55:
        raise ValueError("Floor depth is not sufficiently planar. Retain the evidence and inspect the floor mask/depth before fitting a scene.")
    support = sample[best]
    center = support.mean(axis=0)
    _, _, vectors = np.linalg.svd(support - center, full_matrices=False)
    normal = vectors[-1]
    if np.dot(normal, camera - center) < 0:
        normal = -normal
    inliers = np.abs((points - center) @ normal) < tolerance
    return normal, center, float(inliers.mean())


def ground_basis(normal: np.ndarray, extrinsics: np.ndarray) -> np.ndarray:
    forward = extrinsics[:, :3].T @ np.array([0., 0., 1.])
    z_axis = -(forward - np.dot(forward, normal) * normal)
    if np.linalg.norm(z_axis) < 1e-5:
        right = extrinsics[:, :3].T @ np.array([1., 0., 0.])
        x_axis = right - np.dot(right, normal) * normal
        x_axis /= np.linalg.norm(x_axis)
        z_axis = np.cross(x_axis, normal)
    else:
        z_axis /= np.linalg.norm(z_axis)
        x_axis = np.cross(normal, z_axis)
        x_axis /= np.linalg.norm(x_axis)
    return np.stack((x_axis, normal, z_axis))


def oriented_bounds(points: np.ndarray, minimum: float) -> dict:
    center = np.median(points[:, [0, 2]], axis=0)
    _, vectors = np.linalg.eigh(np.cov((points[:, [0, 2]] - center).T))
    axis = vectors[:, -1]
    if axis[0] < 0:
        axis = -axis
    across = np.array([-axis[1], axis[0]])
    local = np.column_stack((points[:, [0, 2]] @ axis, points[:, 1], points[:, [0, 2]] @ across))
    low, high = np.quantile(local, [.01, .99], axis=0)
    midpoint = (low + high) / 2
    xz = midpoint[0] * axis + midpoint[2] * across
    size = np.maximum(high - low, minimum)
    return {"position": [float(xz[0]), float(midpoint[1]), float(xz[1])],
            "rotation": [0., math.degrees(math.atan2(-axis[1], axis[0])), 0.], "scale": size.tolist()}


def xyz_euler(matrix: np.ndarray) -> list[float]:
    """Three.js intrinsic XYZ Euler convention, in degrees."""
    y = math.asin(float(np.clip(matrix[0, 2], -1, 1)))
    if abs(matrix[0, 2]) < .9999999:
        x, z = math.atan2(-matrix[1, 2], matrix[2, 2]), math.atan2(-matrix[0, 1], matrix[0, 0])
    else:
        x, z = math.atan2(matrix[2, 1], matrix[1, 1]), 0.
    return np.degrees([x, y, z]).tolist()


def _color(image: np.ndarray, mask: np.ndarray) -> str:
    pixels = image[mask]
    value = np.median(pixels, axis=0).astype(int)
    return "#" + "".join(f"{channel:02x}" for channel in value)


def reconstruct(run: Path, floor_concepts: list[str], anchor: tuple[str, float] | None = None,
                region_mode: str = "mask", object_depth: str = "dense") -> None:
    if region_mode not in ("mask", "box") or object_depth not in ("dense", "constant"):
        raise ValueError("Use mask/box regions and dense/constant object depth.")
    frame, segmentation, geometry = require_frame(run), read_json(run / "segmentation.json"), read_json(run / "geometry.json")
    if segmentation.get("frameId") != frame["id"] or geometry.get("frameId") != frame["id"]:
        raise ValueError("Masks and depth must belong to this exact saved source frame.")
    if segmentation.get("status", "complete") != "complete":
        raise ValueError("Segmentation is incomplete; no layout was generated.")
    if geometry.get("format") != "LittleTake.reference-geometry" or geometry.get("version") != 1:
        raise ValueError("Unsupported geometry measurement format.")
    if geometry.get("scale") not in ("relative", "metres"):
        raise ValueError("Geometry must explicitly identify relative or metric depth.")
    if (geometry.get("depthConvention"), geometry.get("cameraConvention"), geometry.get("intrinsicsUnits")) != ("camera-z", "opencv-world-to-camera", "pixels"):
        raise ValueError("Convert depth, camera direction and intrinsics units to the shared geometry convention first.")
    expected_size = [frame["width"], frame["height"]]
    if geometry["imageSize"] != expected_size or [segmentation["width"], segmentation["height"]] != expected_size:
        raise ValueError("Masks, depth and source frame must have identical source dimensions.")
    with np.load(run / geometry["depthFile"], allow_pickle=False) as arrays:
        depth, confidence = arrays["depth"].copy(), arrays["confidence"].copy()
        k, e, affine = arrays["intrinsics"].copy(), arrays["extrinsics"].copy(), arrays["image_to_depth"].copy()
    if depth.ndim != 2 or confidence.shape != depth.shape or k.shape != (3, 3) or e.shape != (3, 4) or affine.shape != (3, 3):
        raise ValueError("Invalid numeric geometry shapes.")
    if not all(np.isfinite(value).all() for value in (k, e, affine)) or not np.allclose(e[:, :3] @ e[:, :3].T, np.eye(3), atol=.01):
        raise ValueError("Camera parameters must be finite rigid transforms.")
    if k[0, 0] <= 0 or k[1, 1] <= 0 or not np.allclose(k[2], [0, 0, 1]) or not np.allclose(affine[2], [0, 0, 1]):
        raise ValueError("Expected pixel-space camera intrinsics and an affine source-to-depth mapping.")
    if not np.allclose(affine, geometry["imageToDepth"]):
        raise ValueError("Depth metadata and its numeric image mapping disagree.")
    image = np.asarray(Image.open(run / "frame.png").convert("RGB"))
    source_valid = sample_source(np.ones(image.shape[:2], dtype=bool), affine, depth.shape)
    valid = source_valid & np.isfinite(depth) & (depth > 0) & np.isfinite(confidence)
    if valid.sum() < 300:
        raise ValueError("Insufficient valid numerical depth.")
    valid &= confidence >= np.quantile(confidence[valid], .25)
    points = unproject(depth, k, e)
    valid &= np.isfinite(points).all(axis=-1)
    camera = -e[:, :3].T @ e[:, 3]
    median_depth = float(np.median(depth[valid]))
    # Controlled ablation: camera, confidence filtering and ground stay identical.
    # This removes foreground depth information, not the shared VGGT scaffold.
    flat_points = unproject(np.full_like(depth, median_depth), k, e) if object_depth == "constant" else None
    floor_names = {name.casefold() for name in floor_concepts}
    measurements, unplaced = [], []
    for item in segmentation["instances"]:
        mask_image = Image.open(run / item["mask"]).convert("L")
        if mask_image.size != tuple(expected_size):
            raise ValueError("A saved mask has incorrect source dimensions.")
        mask = np.asarray(mask_image) > 127
        region = mask.copy()
        is_floor = item["concept"].casefold() in floor_names
        if region_mode == "box" and not is_floor:
            region[:] = False
            x0, y0, x1, y1 = item["box"]
            region[y0:y1, x0:x1] = True
        eroded = np.asarray(Image.fromarray(region.astype(np.uint8) * 255).filter(ImageFilter.MinFilter(3))) > 127
        selection = sample_source(eroded, affine, depth.shape) & valid
        if selection.sum() < 24:
            selection = sample_source(region, affine, depth.shape) & valid
        if selection.sum() < 24:
            unplaced.append({"id": item["id"], "concept": item["concept"], "reason": "Too few reliable depth samples; no replacement placement was guessed."})
            continue
        # Identical masks from synonymous concepts are one observed instance.
        duplicate = next((previous for previous in measurements if np.logical_and(previous["mask"], mask).sum() / max(1, np.logical_or(previous["mask"], mask).sum()) > .85), None)
        if duplicate is not None:
            duplicate["aliases"].append(item["concept"])
            continue
        selected_points = points if is_floor or flat_points is None else flat_points
        measurements.append({"item": item, "aliases": [item["concept"]], "mask": mask, "region": region,
                             "selection": selection, "points": selected_points[selection]})
    floor_points = [value["points"] for value in measurements if any(alias.casefold() in floor_names for alias in value["aliases"])]
    if not floor_points:
        raise ValueError("No usable floor mask. Include an explicit floor concept when segmenting; no ground plane was invented.")
    normal, origin, plane_ratio = plane(np.concatenate(floor_points), camera, max(median_depth * .015, 1e-6))
    basis = ground_basis(normal, e)
    for measured in measurements:
        measured["aligned"] = (measured["points"] - origin) @ basis.T
    scale, scale_info = 1., {"units": geometry["scale"], "source": "model estimate; unknown global metric scale" if geometry["scale"] == "relative" else "model metric estimate; not a verified measurement"}
    if anchor:
        object_id, known_height = anchor
        measured = next((value for value in measurements if value["item"]["id"] == object_id), None)
        if measured is None:
            raise ValueError("Known-height anchor does not identify an observed object.")
        x0, y0, x1, y1 = measured["item"]["box"]
        if min(x0, y0) < 2 or x1 >= frame["width"] - 2 or y1 >= frame["height"] - 2:
            raise ValueError("A cropped object cannot establish a known full height.")
        height = np.diff(np.quantile(measured["aligned"][:, 1], [.01, .99]))[0]
        if height <= 1e-6 or known_height <= 0 or not math.isfinite(known_height):
            raise ValueError("Invalid known-height anchor.")
        scale = known_height / height
        scale_info = {"units": "metres", "source": "user-supplied visible-height constraint; requires an actually known, unoccluded object",
                      "anchorId": object_id, "height": known_height, "factor": float(scale)}
    camera_position = (camera - origin) @ basis.T * scale
    camera_rotation = basis @ e[:, :3].T @ np.diag([1., -1., -1.])
    crop_x, crop_y, _, _ = frame["crop"]
    full_k = np.array([[1, 0, crop_x], [0, 1, crop_y], [0, 0, 1]]) @ np.linalg.inv(affine) @ k
    minimum = max(median_depth * scale * .0025, 1e-6)
    objects, overlays = [], Image.open(run / "original.png").convert("RGBA")
    overlay = Image.new("RGBA", overlays.size)
    for value in measurements:
        item, positions = value["item"], value["aligned"] * scale
        is_floor = any(alias.casefold() in floor_names for alias in value["aliases"])
        bounds = oriented_bounds(positions, minimum)
        if is_floor:
            bounds["position"][1], bounds["scale"][1] = -minimum / 2, minimum
        color = _color(image, value["mask"])
        box = item["box"]
        assumptions = ["Visible-surface bounds; hidden volume and object pose are not independently recovered."]
        if box[0] < 2 or box[1] < 2 or box[2] >= frame["width"] - 2 or box[3] >= frame["height"] - 2:
            assumptions.append("Touches the source frame boundary; dimensions are incomplete.")
        if min(bounds["scale"]) <= minimum * 1.01 and not is_floor:
            assumptions.append("One dimension is not observable; minimum display thickness was used.")
        selected = sample_source(value["region"], affine, depth.shape) & source_valid
        objects.append({"id": item["id"], "name": f"{item['concept']} {item['samId']}", "concepts": value["aliases"],
                        "kind": "cube", "color": color, "transform": bounds, "mask": item["mask"], "sourceBox": box,
                        "isFloor": is_floor, "maskScore": item["score"], "depthCoverage": float(value["selection"].sum() / max(1, selected.sum())),
                        "visibleSurfaceCameraDepth": float((median_depth if object_depth == "constant" and not is_floor else np.median(depth[value["selection"]])) * scale), "assumptions": assumptions})
        rgba = Image.new("RGBA", (frame["width"], frame["height"]), color)
        rgba.putalpha(Image.fromarray(value["mask"].astype(np.uint8) * 90))
        overlay.alpha_composite(rgba, (crop_x, crop_y))
        draw = ImageDraw.Draw(overlay)
        draw.rectangle([box[0] + crop_x, box[1] + crop_y, box[2] + crop_x, box[3] + crop_y], outline=color, width=2)
        draw.text((box[0] + crop_x + 3, box[1] + crop_y + 2), item["id"] + " " + item["concept"], fill="white", stroke_width=1, stroke_fill="black")
    if not any(not item["isFloor"] for item in objects):
        raise ValueError("No objects have enough reliable depth to form a layout.")
    Image.alpha_composite(overlays, overlay).convert("RGB").save(run / "segmentation.png")
    full_width, full_height = frame["originalSize"]
    visible = frame["frameBounds"]
    fov = math.degrees(2 * math.atan(full_height / (2 * full_k[1, 1])))
    layout_id = str(uuid.uuid4())
    layout = {"format": "LittleTake.reference-layout", "version": 1, "id": layout_id, "frameId": frame["id"], "scale": scale_info,
              "sourceSize": [full_width, full_height], "crop": frame["crop"], "frameBounds": visible,
              "camera": {"intrinsics": full_k.tolist(), "position": camera_position.tolist(), "rotationMatrix": camera_rotation.tolist(),
                         "rotation": xyz_euler(camera_rotation), "fov": fov},
              "ground": {"inputNormal": normal.tolist(), "inputOrigin": origin.tolist(), "worldToGroundRotation": basis.tolist(), "inlierFraction": plane_ratio},
              "experiment": {"regionMode": region_mode, "objectDepth": object_depth,
                             "conditioning": "Camera, ground and candidate inventory held fixed; not an end-to-end no-SAM/no-VGGT baseline."},
              "objects": objects, "unplaced": unplaced,
              "sceneExport": {"projection": "Native centered vertical-FOV camera; exact full intrinsics remain available in this layout.",
                              "principalPointOffsetPixels": [float(full_k[0, 2] - (full_width - 1) / 2), float(full_k[1, 2] - (full_height - 1) / 2)]},
              "quality": {"status": "unreviewed", "note": "Numerical measurements do not establish visual reconstruction quality."},
              "assumptions": ["Single-view reconstruction; unseen surfaces remain unknown.", "Every proxy is a coarse box of the visible surface, not a generated detailed asset."]}
    write_json(run / "layout.json", layout)
    write_json(run / "rendered-measurements.json", {"layoutId": layout_id, "status": "pending-render", "note": "Existing capture PNGs, if present, belong to an earlier layout until this layout is rendered."})
    # Source/depth pixel correspondence is checked separately from visual quality.
    y, x = np.where(valid)
    subset = np.linspace(0, len(x) - 1, min(len(x), 12000), dtype=int)
    x, y = x[subset], y[subset]
    source_uv = np.column_stack((x, y, np.ones(len(x)))) @ np.linalg.inv(affine).T
    source_x = np.clip(np.rint(source_uv[:, 0]).astype(int), 0, image.shape[1] - 1)
    source_y = np.clip(np.rint(source_uv[:, 1]).astype(int), 0, image.shape[0] - 1)
    cloud = (points[y, x] - origin) @ basis.T * scale
    write_json(run / "cloud.json", {"positions": np.round(cloud, 6).reshape(-1).tolist(), "colors": image[source_y, source_x].reshape(-1).tolist()})
    reprojection = project(points[y, x], k, e)
    write_json(run / "numeric-checks.json", {"depthSamples": int(valid.sum()), "floorInlierFraction": plane_ratio,
               "unprojectionRoundTripMaxPixels": float(np.max(np.linalg.norm(reprojection - np.column_stack((x, y)), axis=-1))),
               "meaning": "Coordinate consistency only; source/render silhouette and occlusion are evaluated by the report's actual depth-tested ID render."})
    # A visualization has its min/max recorded; geometry always reads the float NPZ.
    low, high = np.quantile(depth[valid], [.02, .98])
    grayscale = np.rint(255 * np.nan_to_num(np.clip((depth - low) / max(float(high - low), 1e-9), 0, 1))).astype(np.uint8)
    sy, sx = np.mgrid[:frame["height"], :frame["width"]]
    model_uv = np.stack((sx, sy, np.ones_like(sx)), axis=-1) @ affine.T
    mx = np.clip(np.rint(model_uv[..., 0]).astype(int), 0, depth.shape[1] - 1)
    my = np.clip(np.rint(model_uv[..., 1]).astype(int), 0, depth.shape[0] - 1)
    depth_display = Image.new("L", tuple(frame["originalSize"]))
    depth_display.paste(Image.fromarray(grayscale[my, mx]), (crop_x, crop_y))
    depth_display.save(run / "depth.png")
    write_json(run / "depth-visualization.json", {"low": float(low), "high": float(high), "units": geometry["scale"], "note": "PNG is display-only; use geometry.npz for computation."})
    scene = {"format": "LittleTake.scene", "version": 3, "id": frame["id"], "name": "Reference geometry (" + scale_info["units"] + ")", "duration": 5,
             "objects": [{key: value for key, value in obj.items() if key in ("id", "name", "kind", "color", "transform")} | {"track": None} for obj in objects],
             "cameras": [{"id": "geometry-camera", "name": "Reference camera", "fov": fov, "transform": {"position": camera_position.tolist(), "rotation": xyz_euler(camera_rotation), "scale": [1, 1, 1]}, "track": None, "frameBounds": visible}],
             "shots": [{"id": "geometry-shot", "name": "Reference frame", "cameraId": "geometry-camera", "start": 0, "duration": 5}]}
    write_json(run / "scene.json", scene)
