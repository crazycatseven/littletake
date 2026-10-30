"""SAM API bridge and durable per-frame measurements; never imports a GPU model."""
from __future__ import annotations

import base64
import io
import json
from pathlib import Path
import subprocess
import time
import uuid

import numpy as np
from PIL import Image

from files import ROOT, measurement_lock, read_json, require_frame, write_json
from segmentation import render_masks

SOURCE = {"provider": "Meta Model API", "model": "sam-3.1", "parser": "@meta-sam/parser@0.1.0"}


def segment(run: Path, prompts: list[str], threshold: float, max_api_calls: int = 8) -> None:
    frame = require_frame(run)
    requested = {"prompts": prompts, "threshold": threshold}
    if not 1 <= max_api_calls <= 100:
        raise ValueError("Set an explicit SAM request budget from 1 to 100 calls for this run.")
    with measurement_lock(run / "sam.lock"):
        saved = read_json(run / "segmentation.json") if (run / "segmentation.json").exists() else None
        if saved and (saved["frameId"] != frame["id"] or saved["request"] != requested or saved["model"] != SOURCE):
            raise RuntimeError("Existing segmentation uses another source, request or local-model provider. Measurements were preserved; choose a new run for SAM API.")
        if saved and saved["status"] == "complete":
            render_masks(run)
            print("Saved SAM API measurements reused; no API call or GPU model loaded.", flush=True)
            return
        record = saved or {"format": "LittleTake.reference-masks", "version": 1, "frameId": frame["id"], "status": "running",
                 "width": frame["width"], "height": frame["height"], "pixelCoordinates": "source-crop; half-open boxes",
                 "model": SOURCE, "request": requested, "calls": [], "instances": [],
                 "runtime": {"provider": "Meta Model API", "localGpuRequired": False, "automaticRetries": 0}}
        budget_path = run / "sam-api-budget.json"
        budget = read_json(budget_path) if budget_path.exists() else {"limit": max_api_calls, "reservedAttempts": 0, "estimatedUsdPerImage": .0025}
        if budget["limit"] != max_api_calls:
            raise RuntimeError("The saved SAM call limit is immutable. Use its existing limit or a new run; no budget was reset.")
        pending = [index for index in range(len(prompts)) if not any(call["promptIndex"] == index for call in record["calls"])]
        if len(pending) > budget["limit"] - budget["reservedAttempts"]:
            raise RuntimeError(f"SAM needs {len(pending)} requests, but only {budget['limit'] - budget['reservedAttempts']} remain. No API call was made.")
        (run / "masks").mkdir(exist_ok=True)
        write_json(run / "segmentation.json", record)
        started = time.perf_counter()
        for prompt_index in pending:
            prompt, call_id = prompts[prompt_index], str(uuid.uuid4())
            request = {"imagePath": str((run / "frame.png").resolve()), "prompt": prompt, "threshold": threshold}
            call_path = run / "sam-api-calls" / f"{call_id}.json"
            attempt = {"id": call_id, "frameId": frame["id"], "promptIndex": prompt_index, "request": request, "model": SOURCE, "status": "reserved"}
            # Reserve durably BEFORE starting the one-request Node client.
            # Lost/failed/ambiguous requests still consume this conservative cap.
            budget["reservedAttempts"] += 1
            write_json(budget_path, budget)
            write_json(call_path, attempt)
            print(f"SAM API {prompt_index + 1}/{len(prompts)}: {prompt} (attempt {budget['reservedAttempts']}/{budget['limit']})", flush=True)
            call_started = time.perf_counter()
            try:
                process = subprocess.run(["node", "--import", "tsx", str(ROOT / "server/reference/sam/cli.ts")],
                                         cwd=ROOT, input=json.dumps(request), capture_output=True, text=True, encoding="utf-8", timeout=180)
                try:
                    payload = json.loads(process.stdout)
                except (ValueError, TypeError):
                    raise RuntimeError("The SAM API bridge did not return readable JSON. No automatic retry was made.") from None
                attempt["receipt"] = payload.get("result", {}).get("receipt") or payload.get("receipt")
                if process.returncode != 0 or not payload.get("ok"):
                    attempt["error"] = payload.get("error", {"code": "api_failed", "message": "SAM API failed."})
                    raise RuntimeError(attempt["error"]["code"] + ": " + attempt["error"]["message"])
                result = payload["result"]
                if result["source"] != SOURCE or [result["width"], result["height"]] != [frame["width"], frame["height"]]:
                    raise RuntimeError("SAM API response source dimensions or provider differ from this frame.")
                instances = []
                for item in result["instances"]:
                    x0, y0, x1, y1 = item["box"]
                    if not (0 <= x0 < x1 <= frame["width"] and 0 <= y0 < y1 <= frame["height"]):
                        raise RuntimeError("SAM API returned a box outside the source frame.")
                    with Image.open(io.BytesIO(base64.b64decode(item["mask"]["pngBase64"], validate=True))) as cropped:
                        if cropped.size != (x1 - x0, y1 - y0):
                            raise RuntimeError("SAM API mask dimensions do not match its half-open source box.")
                        mask = Image.new("L", (frame["width"], frame["height"]))
                        mask.paste(cropped.convert("L"), (x0, y0))
                    actual_box = mask.getbbox()
                    if actual_box is None:
                        continue
                    identifier = f"p{prompt_index:02d}-o{item['objectId']}"
                    filename = f"masks/{identifier}.png"
                    mask.save(run / filename)
                    pixels = int(np.count_nonzero(np.asarray(mask)))
                    instances.append({"id": identifier, "samId": item["objectId"], "concept": prompt, "score": item["score"],
                                      "mask": filename, "box": list(actual_box), "providerBox": item["box"], "pixels": pixels,
                                      "normalizedBox": [actual_box[0] / frame["width"], actual_box[1] / frame["height"], actual_box[2] / frame["width"], actual_box[3] / frame["height"]],
                                      "areaFraction": pixels / (frame["width"] * frame["height"])})
                record["instances"].extend(instances)
                record["calls"].append({"promptIndex": prompt_index, "prompt": prompt, "instanceCount": len(instances), "frameIndex": 0,
                                         "elapsedSeconds": time.perf_counter() - call_started, "apiSeconds": result["receipt"]["elapsedSeconds"],
                                         "attemptId": call_id, "responseId": result["receipt"].get("responseId")})
                attempt["status"] = "complete"
            except BaseException as error:
                attempt.update(status="interrupted" if isinstance(error, KeyboardInterrupt) else "failed", errorType=type(error).__name__, message=str(error))
                raise
            finally:
                attempt["elapsedSeconds"] = time.perf_counter() - call_started
                write_json(call_path, attempt)
                record["elapsedSeconds"] = time.perf_counter() - started
                write_json(run / "segmentation.json", record)
        record["status"] = "complete"
        write_json(run / "segmentation.json", record)
        render_masks(run)
