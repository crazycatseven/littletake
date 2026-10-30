"""One synthetic contract regression; no model import, network, CUDA or inference.

This verifies saved coordinates/scale/scene export, not reconstruction quality.
"""
import math
import json
import base64
import io
import sys
import subprocess
import os
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
from PIL import Image

from files import read_json, write_json, source_path
from layout import project, reconstruct, sample_source, unproject
from segmentation import render_masks
from benchmark import build, summarize
from sam_api import segment as segment_api, SOURCE as SAM_API_SOURCE


class GeometryContract(unittest.TestCase):
    def test_saved_measurements_to_layout_and_metric_anchor(self):
        with tempfile.TemporaryDirectory() as folder:
            run = Path(folder)
            width, height, size = 320, 240, 252
            crop = [80, 30, width, height]
            frame = {"format": "LittleTake.reference-frame", "version": 1, "id": "synthetic-source",
                     "originalSize": [480, 300], "width": width, "height": height, "crop": crop,
                     "frameBounds": [80 / 480, .1, 400 / 480, .9], "source": {"kind": "synthetic-test"}}
            write_json(run / "frame.json", frame)
            camera = np.array([0., 1.5, 4.])
            forward = np.array([0., -.5, -4.]); forward /= np.linalg.norm(forward)
            right = np.cross(forward, [0., 1., 0.]); right /= np.linalg.norm(right)
            down = np.cross(forward, right)
            rotation = np.stack((right, down, forward))
            e = np.column_stack((rotation, -rotation @ camera))
            k = np.array([[250., 0, width / 2], [0, 250., height / 2], [0, 0, 1.]])
            definitions = [(np.array([-1., 0., -.5]), np.array([-.3, 1., .3])),
                           (np.array([.4, 0., -1.4]), np.array([1.2, .9, -.6]))]

            def raycast(w, h, intrinsics):
                y, x = np.mgrid[:h, :w]
                rays = np.stack((x, y, np.ones_like(x)), axis=-1) @ np.linalg.inv(intrinsics).T @ rotation
                depth = np.full((h, w), 30.)
                owner = np.zeros((h, w), dtype=np.uint8)
                floor = -camera[1] / np.where(np.abs(rays[..., 1]) > 1e-8, rays[..., 1], 1e-8)
                visible = floor > 0
                depth[visible] = floor[visible]; owner[visible] = 1
                for number, (low, high) in enumerate(definitions, 2):
                    safe = np.where(np.abs(rays) > 1e-8, rays, 1e-8)
                    a, b = (low - camera) / safe, (high - camera) / safe
                    enter, leave = np.minimum(a, b).max(axis=-1), np.maximum(a, b).min(axis=-1)
                    hit = (enter > 0) & (leave >= enter) & (enter < depth)
                    depth[hit], owner[hit] = enter[hit], number
                return depth, owner

            _, source_owner = raycast(width, height, k)
            palette = np.array([[60, 65, 65], [170, 70, 60], [90, 40, 120], [170, 140, 70]], dtype=np.uint8)
            image = Image.fromarray(palette[source_owner]); image.save(run / "frame.png")
            original = Image.new("RGB", tuple(frame["originalSize"])); original.paste(image, tuple(crop[:2])); original.save(run / "original.png")
            instances = []
            (run / "masks").mkdir()
            for number, concept in enumerate(("floor", "counter", "cabinet"), 1):
                mask = source_owner == number
                y, x = np.where(mask)
                filename = f"masks/object-{number}.png"
                Image.fromarray(mask.astype(np.uint8) * 255).save(run / filename)
                instances.append({"id": f"object-{number}", "samId": number, "concept": concept, "mask": filename,
                                  "box": [int(x.min()), int(y.min()), int(x.max()) + 1, int(y.max()) + 1], "pixels": len(x), "score": .95})
            write_json(run / "segmentation.json", {"format": "LittleTake.reference-masks", "version": 1, "frameId": frame["id"], "status": "complete", "width": width, "height": height, "instances": instances,
                       "model": {"repo": "synthetic-contract-test"}, "calls": [], "request": {"prompts": ["floor", "counter", "cabinet", "absent"]}})
            if os.name == "nt":
                # Reproduce the real reader-versus-checkpoint sharing violation.
                saved = read_json(run / "segmentation.json")
                with ThreadPoolExecutor(max_workers=1) as pool:
                    with (run / "segmentation.json").open("r", encoding="utf-8") as reader:
                        future = pool.submit(write_json, run / "segmentation.json", saved)
                        time.sleep(.1)
                        self.assertIn("synthetic-source", reader.read())
                    future.result(timeout=3)
                self.assertEqual(read_json(run / "segmentation.json"), saved)
            render_masks(run)
            with Image.open(run / "segmentation-overlay.png") as overlay:
                self.assertEqual(overlay.size, tuple(frame["originalSize"]))
                self.assertEqual(overlay.getpixel((0, 0)), (0, 0, 0))
            self.assertEqual(read_json(run / "segmentation-review.json")["concepts"][-1]["count"], 0)
            scale = size / width
            affine = np.array([[scale, 0, scale * .5 - .5], [0, scale, scale * (40 + .5) - .5], [0, 0, 1.]])
            model_k = affine @ k
            depth, _ = raycast(size, size, model_k)
            # VGGT geometry is deliberately rescaled: the initial layout cannot claim metres.
            relative = .4
            relative_e = e.copy(); relative_e[:, 3] *= relative
            np.savez_compressed(run / "geometry.npz", depth=depth * relative, confidence=np.ones_like(depth), intrinsics=model_k,
                                extrinsics=relative_e, image_to_depth=affine)
            write_json(run / "geometry.json", {"format": "LittleTake.reference-geometry", "version": 1, "frameId": frame["id"],
                       "model": {"repo": "synthetic-contract-test"},
                       "imageSize": [width, height], "imageToDepth": affine.tolist(), "depthFile": "geometry.npz", "scale": "relative",
                       "cameraConvention": "opencv-world-to-camera", "depthConvention": "camera-z", "intrinsicsUnits": "pixels"})
            points = unproject(depth * relative, model_k, relative_e)
            reprojection = project(points, model_k, relative_e)
            y, x = np.mgrid[:size, :size]
            np.testing.assert_allclose(reprojection, np.stack((x, y), axis=-1), atol=1e-8)
            sample = sample_source(source_owner, affine, (size, size))
            self.assertTrue(np.any(sample == 2) and np.any(sample == 3))
            reconstruct(run, ["floor"])
            layout = read_json(run / "layout.json")
            self.assertEqual(layout["scale"]["units"], "relative")
            self.assertEqual(len(layout["objects"]), 3)
            self.assertGreater(layout["ground"]["inlierFraction"], .95)
            self.assertLess(read_json(run / "numeric-checks.json")["unprojectionRoundTripMaxPixels"], 1e-7)
            scene = read_json(run / "scene.json")
            self.assertEqual((scene["format"], scene["version"]), ("LittleTake.scene", 3))
            self.assertEqual(scene["cameras"][0]["frameBounds"], frame["frameBounds"])
            np.testing.assert_allclose(np.array(layout["camera"]["intrinsics"]), np.array([[1, 0, 80], [0, 1, 30], [0, 0, 1]]) @ k, atol=1e-8)
            a, b, c = np.radians(scene["cameras"][0]["transform"]["rotation"])
            rx = np.array([[1, 0, 0], [0, math.cos(a), -math.sin(a)], [0, math.sin(a), math.cos(a)]])
            ry = np.array([[math.cos(b), 0, math.sin(b)], [0, 1, 0], [-math.sin(b), 0, math.cos(b)]])
            rz = np.array([[math.cos(c), -math.sin(c), 0], [math.sin(c), math.cos(c), 0], [0, 0, 1]])
            np.testing.assert_allclose(rx @ ry @ rz, layout["camera"]["rotationMatrix"], atol=1e-7)
            previous_id = layout["id"]
            # Exercise the same saved measurements through the conditional 2x2
            # benchmark, including missing detections and stale render receipts.
            protocol = {"description": "Synthetic geometry interface contract", "limitations": ["Synthetic fixture, not model accuracy."],
                        "frames": [{"name": "synthetic", "sourceRun": str(run), "frameId": frame["id"],
                                    "groundPolygons": [[[0, 210], [319, 210], [319, 239], [0, 239]]],
                                    "objects": [{"name": item["concept"], "samId": item["id"], "box": item["box"], "grounded": True,
                                                 "depthProbe": [(item["box"][0] + item["box"][2]) // 2, (item["box"][1] + item["box"][3]) // 2]} for item in instances[1:]] +
                                               [{"name": "missing", "samId": None, "box": [0, 0, 10, 10], "depthProbe": [4, 4]}],
                                    "nearFarPairs": [["counter", "cabinet"], ["counter", "missing"]]}]}
            write_json(run / "protocol-input.json", protocol)
            benchmark_run = run / "ablation"
            build(run / "protocol-input.json", benchmark_run)
            benchmark = read_json(benchmark_run / "benchmark.json")
            self.assertEqual(len(benchmark["results"]), 4)
            for record in benchmark["results"]:
                self.assertEqual(record["status"], "awaiting-render")
                arm_run = benchmark_run / record["path"]
                candidate = read_json(arm_run / "layout.json")
                # All conditions use exactly the same ground fit.
                if record is benchmark["results"][0]:
                    fixed_ground = candidate["ground"]
                self.assertEqual(candidate["ground"], fixed_ground)
                fake_capture = {"layoutId": candidate["id"], "renderer": "synthetic-contract-only",
                                "objects": [{"id": item["id"], "visibleBox": [80, 30, 100, 60], "silhouetteIoU": .2} for item in candidate["objects"]]}
                write_json(arm_run / "rendered-measurements.json", fake_capture)
            summary = summarize(benchmark_run)
            self.assertEqual(summary["status"], "complete")
            self.assertEqual(summary["independentDepthProbes"]["totalPairs"], 2)
            self.assertEqual(summary["independentDepthProbes"]["counts"]["missing"], 0)
            for aggregate in summary["aggregates"]:
                self.assertEqual((aggregate["detectedObjects"], aggregate["annotatedObjects"]), (2, 3))
                self.assertEqual(aggregate["ordinal"]["missing"], 1)
                if aggregate["arm"].endswith("constant"):
                    self.assertEqual(aggregate["ordinal"]["unresolved"], 1)
            capture = arm_run / "rendered-measurements.json"
            stale = read_json(capture); stale["layoutId"] = "old-layout"; write_json(capture, stale)
            with self.assertRaisesRegex(ValueError, "Stale capture"):
                summarize(benchmark_run)
            # Real VGGT bring-up regressions: namespace-package source detection
            # and CLI diagnostics containing a list of Path arguments.
            vendor = run / "vendor"
            (vendor / "vggt/vggt/models").mkdir(parents=True)
            (vendor / "vggt/vggt/models/vggt.py").write_text("# namespace fixture", encoding="utf-8")
            with patch("files.VENDOR", vendor), patch("subprocess.check_output", return_value="fixture-revision"):
                self.assertEqual(source_path("vggt", {"vggt": {"sourceRevision": "fixture-revision"}}), vendor / "vggt")
            import run as cli
            cli_run = run / "cli-diagnostics"; cli_run.mkdir()
            with patch("sys.argv", ["run.py", "depth", "--run", str(cli_run), "--context-runs", str(run)]), patch("models.depth") as inference:
                cli.main()
                inference.assert_called_once()
            receipt = read_json(next((cli_run / "attempts").glob("*.json")))
            self.assertEqual(receipt["request"]["context_runs"], [str(run)])
            self.assertEqual(receipt["status"], "complete")
            # Paid SAM bridge: partial success survives a provider failure,
            # resumption does not repay completed concepts, cache works offline.
            api_run = run / "sam-api"; api_run.mkdir()
            for filename in ("frame.json", "frame.png", "original.png"):
                (api_run / filename).write_bytes((run / filename).read_bytes())
            calls = []
            crop_mask = Image.new("L", (3, 2), 255); crop_mask.putpixel((1, 0), 0)
            png_bytes = io.BytesIO(); crop_mask.save(png_bytes, format="PNG")
            wire_instance = {"objectId": "7", "box": [50, 60, 53, 62], "score": .9,
                             "mask": {"width": 3, "height": 2, "pngBase64": base64.b64encode(png_bytes.getvalue()).decode()}}
            def api_bridge(command, **options):
                request = json.loads(options["input"]); calls.append(request["prompt"])
                if len(calls) == 2:
                    return subprocess.CompletedProcess(command, 1, json.dumps({"ok": False, "error": {"code": "rate_limited", "message": "Retry explicitly later."}, "receipt": {"rawOutput": "partial", "status": "rate_limited"}}), "")
                result = {"source": SAM_API_SOURCE, "width": width, "height": height,
                          "instances": [] if request["prompt"] == "absent" else [wire_instance],
                          "receipt": {"rawOutput": "fixture", "elapsedSeconds": .01, "responseId": "test"}}
                return subprocess.CompletedProcess(command, 0, json.dumps({"ok": True, "result": result}), "")
            with patch("sam_api.subprocess.run", side_effect=api_bridge):
                with self.assertRaisesRegex(RuntimeError, "rate_limited"):
                    segment_api(api_run, ["counter", "absent", "cabinet"], .5, 4)
                self.assertEqual(len(read_json(api_run / "segmentation.json")["calls"]), 1)
                self.assertEqual(read_json(api_run / "sam-api-budget.json")["reservedAttempts"], 2)
                with self.assertRaisesRegex(RuntimeError, "immutable"):
                    segment_api(api_run, ["counter", "absent", "cabinet"], .5, 5)
                segment_api(api_run, ["counter", "absent", "cabinet"], .5, 4)
            self.assertEqual(calls, ["counter", "absent", "absent", "cabinet"])
            api_result = read_json(api_run / "segmentation.json")
            self.assertEqual(api_result["status"], "complete")
            self.assertEqual(len(api_result["instances"]), 2)
            self.assertEqual(api_result["instances"][0]["box"], [50, 60, 53, 62])
            with Image.open(api_run / api_result["instances"][0]["mask"]) as full_mask:
                self.assertEqual(full_mask.size, (width, height))
                self.assertEqual(full_mask.getpixel((50, 60)), 255)
                self.assertEqual(full_mask.getpixel((51, 60)), 0)
                self.assertEqual(full_mask.getpixel((0, 0)), 0)
            with patch("sam_api.subprocess.run", side_effect=AssertionError("Cache must not start a client")):
                segment_api(api_run, ["counter", "absent", "cabinet"], .5, 4)
            self.assertEqual(read_json(api_run / "sam-api-budget.json")["reservedAttempts"], 4)
            self.assertEqual(len(list((api_run / "sam-api-calls").glob("*.json"))), 4)
            self.assertNotIn("torch", sys.modules)
            # The CLI dispatches one chosen provider, never substitutes another,
            # and preserves the selected provider when running the full pipeline.
            with patch.dict(os.environ, {}, clear=True):
                self.assertEqual(cli.parser().parse_args(["segment", "--run", str(api_run), "--concepts", "counter"]).sam_provider, "cloud")
            with patch.dict(os.environ, {"SAM_PROVIDER": "local"}):
                self.assertEqual(cli.parser().parse_args(["segment", "--run", str(api_run), "--concepts", "counter"]).sam_provider, "local")
                self.assertEqual(cli.parser().parse_args(["segment", "--sam-provider", "cloud", "--run", str(api_run), "--concepts", "counter"]).sam_provider, "cloud")
            for provider, module in (("cloud", "sam_api"), ("local", "sam_local")):
                with patch("sys.argv", ["run.py", "segment", "--sam-provider", provider, "--run", str(api_run), "--concepts", "counter"]), patch(module + ".segment") as chosen:
                    cli.main()
                    chosen.assert_called_once()
                    self.assertEqual(chosen.call_args.args[-1], 8 if provider == "cloud" else 16)
            from sam_local import segment as segment_local
            local_run = run / "sam-local"; local_run.mkdir()
            for filename in ("frame.json", "frame.png", "original.png"):
                (local_run / filename).write_bytes((run / filename).read_bytes())
            local_result = json.loads(json.dumps(api_result))
            local_model = {"repo": "facebook/sam3.1", "filename": "fixture.pt", "revision": "fixture", "sourceRevision": "fixture-source"}
            local_result["model"] = local_model
            (local_run / "masks").mkdir()
            for item in local_result["instances"]:
                (local_run / item["mask"]).write_bytes((api_run / item["mask"]).read_bytes())
            write_json(local_run / "segmentation.json", local_result)
            with patch("sam_local.model_manifest", return_value={"sam3": local_model}), patch("models.cuda_guard", side_effect=AssertionError("Cache must not initialize CUDA")), patch("sam_local.DATA", run / "local-models"):
                segment_local(local_run, local_result["request"]["prompts"], .5)
                with self.assertRaisesRegex(RuntimeError, "different source/model/prompts"):
                    segment_local(api_run, local_result["request"]["prompts"], .5)
            with patch("sam_api.subprocess.run", side_effect=AssertionError("Provider mismatch must not call cloud")):
                with self.assertRaisesRegex(RuntimeError, "another source"):
                    segment_api(local_run, local_result["request"]["prompts"], .5)
            from files import measurement_lock
            with measurement_lock(run / "same-run.lock"):
                with self.assertRaisesRegex(RuntimeError, "already running"):
                    with measurement_lock(run / "same-run.lock"):
                        self.fail("Concurrent inference must be rejected")
            self.assertNotIn("torch", sys.modules)
            reconstruct(run, ["floor"], ("object-2", 1.))
            metric = read_json(run / "layout.json")
            self.assertEqual(metric["scale"]["units"], "metres")
            self.assertNotEqual(metric["id"], previous_id)
            self.assertGreater(metric["scale"]["factor"], 2.)
            self.assertEqual(read_json(run / "rendered-measurements.json")["status"], "pending-render")
            with Image.open(run / "depth.png") as depth_image:
                self.assertEqual(depth_image.size, tuple(frame["originalSize"]))
            masks = read_json(run / "segmentation.json"); masks["frameId"] = "different-source"; write_json(run / "segmentation.json", masks)
            with self.assertRaisesRegex(ValueError, "exact saved source"):
                reconstruct(run, ["floor"])


if __name__ == "__main__":
    unittest.main()
