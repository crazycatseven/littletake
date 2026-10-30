"""Explicit local SAM 3.1 execution; offline weights, resumable masks, no API fallback."""
from __future__ import annotations

import gc
import inspect
import os
import sys
import time
from contextlib import redirect_stdout
from pathlib import Path

from files import DATA, measurement_lock, local_checkpoint, model_manifest, read_json, require_frame, source_path, write_json


def _segment(run: Path, prompts: list[str], threshold: float, min_free_gb: float) -> None:
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    from models import cuda_guard
    import numpy as np
    from PIL import Image
    frame = require_frame(run)
    requested = {"prompts": prompts, "threshold": threshold}
    manifest = model_manifest()
    if "sam3" not in manifest:
        raise RuntimeError("Local SAM weights are not prepared. Run prepare --model sam3 explicitly.")
    saved = read_json(run / "segmentation.json") if (run / "segmentation.json").exists() else None
    if saved and (saved["frameId"] != frame["id"] or saved["request"] != requested or saved["model"] != manifest["sam3"]):
        raise RuntimeError("Existing masks use different source/model/prompts. Choose a new run folder.")
    if saved and saved["status"] == "complete":
        from segmentation import render_masks
        render_masks(run)
        print("Saved SAM measurements reused; no model loaded.", flush=True)
        return
    instances, calls = (saved["instances"], saved["calls"]) if saved else ([], [])
    record = {"format": "LittleTake.reference-masks", "version": 1, "frameId": frame["id"], "status": "running",
              "width": frame["width"], "height": frame["height"], "pixelCoordinates": "source-crop; half-open boxes",
              "model": manifest["sam3"], "request": requested, "calls": calls, "instances": instances}
    checkpoint = local_checkpoint("sam3", manifest)
    torch = cuda_guard(min_free_gb)
    torch.cuda.reset_peak_memory_stats()
    free, total = torch.cuda.mem_get_info()
    record["runtime"] = {"device": torch.cuda.get_device_name(0), "torch": torch.__version__, "cuda": torch.version.cuda,
                         "freeVramBeforeGiB": free / 1024**3, "totalVramGiB": total / 1024**3,
                         "provider": "local", "automaticRetries": 0, "flashAttention3": False, "compile": False, "maxObjectsPerConcept": 16}
    sys.path.insert(0, str(source_path("sam3", manifest)))
    from sam3.model_builder import build_sam3_multiplex_video_predictor
    torch.manual_seed(0)
    started = time.perf_counter()
    print("Loading the prepared local SAM 3.1 checkpoint; no hosted inference.", flush=True)
    load_log = run / f"model-load-{time.time_ns()}.log"
    record["loadLog"] = load_log.name
    with load_log.open("w", encoding="utf-8") as log, redirect_stdout(log):
        predictor = build_sam3_multiplex_video_predictor(
            checkpoint_path=checkpoint, use_fa3=False, use_rope_real=True,
            compile=False, warm_up=False, async_loading_frames=False,
            default_output_prob_thresh=threshold,
        )
    # The pinned upstream base predictor forwards this option even though the
    # multiplex model does not accept it. False means no offload; do not drop True.
    init_state = predictor.model.init_state
    if "offload_state_to_cpu" not in inspect.signature(init_state).parameters:
        def init_without_state_offload(*args, offload_state_to_cpu=False, **kwargs):
            if offload_state_to_cpu:
                raise NotImplementedError("SAM 3.1 multiplex does not support state offloading.")
            return init_state(*args, **kwargs)
        predictor.model.init_state = init_without_state_offload
        record["runtime"]["compatibilityFixes"] = ["unsupported false offload_state_to_cpu forwarded by upstream base predictor"]
    record["loadSeconds"] = time.perf_counter() - started
    masks_dir = run / "masks"
    masks_dir.mkdir(exist_ok=True)
    try:
        # One clean source image is a supported image-only SAM 3.1 resource.
        # A fresh session per concept prevents state/identity leaking between prompts.
        for prompt_index, prompt in enumerate(prompts):
            if any(call["promptIndex"] == prompt_index for call in calls):
                continue
            print(f"SAM 3.1 {prompt_index + 1}/{len(prompts)}: {prompt}", flush=True)
            prompt_started = time.perf_counter()
            session = predictor.handle_request({"type": "start_session", "resource_path": str(run / "frame.png"), "offload_video_to_cpu": True})["session_id"]
            try:
                response = predictor.handle_request({"type": "add_prompt", "session_id": session, "frame_index": 0, "text": prompt, "output_prob_thresh": threshold})
                output = response["outputs"]
                masks = output["out_binary_masks"]
                masks = masks.detach().cpu().numpy() if hasattr(masks, "detach") else np.asarray(masks)
                ids = output["out_obj_ids"]
                ids = (ids.detach().cpu().numpy() if hasattr(ids, "detach") else np.asarray(ids)).reshape(-1)
                scores = output.get("out_probs")
                if scores is not None:
                    scores = scores.detach().float().cpu().numpy() if hasattr(scores, "detach") else np.asarray(scores)
                    scores = scores.reshape(-1)
                if masks.ndim == 4 and masks.shape[1] == 1:
                    masks = masks[:, 0]
                if masks.shape != (len(ids), frame["height"], frame["width"]):
                    raise RuntimeError("SAM returned masks outside the source image coordinate system.")
                if scores is not None and len(scores) != len(ids):
                    raise RuntimeError("SAM returned inconsistent object scores.")
                pending = []
                for index, (sam_id, mask) in enumerate(zip(ids, masks, strict=True)):
                    y, x = np.where(mask)
                    if not len(x):
                        continue
                    object_id = f"p{prompt_index:02d}-o{int(sam_id)}"
                    filename = f"masks/{object_id}.png"
                    Image.fromarray(mask.astype(np.uint8) * 255).save(run / filename)
                    pending.append({"id": object_id, "concept": prompt, "samId": int(sam_id), "mask": filename,
                                    "box": [int(x.min()), int(y.min()), int(x.max()) + 1, int(y.max()) + 1],
                                    "boxNormalized": [float(x.min()) / frame["width"], float(y.min()) / frame["height"],
                                                      (float(x.max()) + 1) / frame["width"], (float(y.max()) + 1) / frame["height"]],
                                    "pixels": len(x), "imageAreaFraction": len(x) / (frame["width"] * frame["height"]),
                                    "score": float(scores[index]) if scores is not None else None})
                instances.extend(pending)
                calls.append({"promptIndex": prompt_index, "prompt": prompt, "instanceCount": len(ids), "frameIndex": response["frame_index"],
                              "elapsedSeconds": time.perf_counter() - prompt_started})
                write_json(run / "segmentation.json", record)
            finally:
                predictor.handle_request({"type": "close_session", "session_id": session})
    except BaseException:
        record["status"] = "interrupted"
        write_json(run / "segmentation.json", record)
        raise
    finally:
        # The official multiplex predictor enters its own autocast context.
        context = getattr(predictor, "bf16_context", None)
        if context is not None:
            context.__exit__(None, None, None)
        predictor.shutdown()
        del predictor
        gc.collect()
        torch.cuda.empty_cache()
    record.update(status="complete", elapsedSeconds=time.perf_counter() - started,
                  peakAllocatedGiB=torch.cuda.max_memory_allocated() / 1024**3,
                  peakReservedGiB=torch.cuda.max_memory_reserved() / 1024**3)
    write_json(run / "segmentation.json", record)
    from segmentation import render_masks
    render_masks(run)


def segment(run: Path, prompts: list[str], threshold: float, min_free_gb: float = 16) -> None:
    with measurement_lock(run / "sam.lock"), measurement_lock(DATA / "sam-local.lock"):
        _segment(run, prompts, threshold, min_free_gb)
