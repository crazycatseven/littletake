"""Offline, conditional 2x2 geometry ablation from saved local measurements.

Candidate boxes, VGGT camera and visually annotated ground are shared. This tests
foreground mask precision and foreground depth, not an end-to-end Agent baseline.
"""
from __future__ import annotations

import argparse
from html import escape
import itertools
from pathlib import Path
import shutil
import time

import numpy as np
from PIL import Image, ImageDraw

from files import ROOT, read_json, require_frame, write_json
from layout import reconstruct
from run import make_report

ARMS = [(f"{region}-{depth}", region, depth) for region, depth in itertools.product(("box", "mask"), ("constant", "dense"))]


def box_iou(a, b) -> float:
    if a is None:
        return 0.
    intersection = max(0, min(a[2], b[2]) - max(a[0], b[0])) * max(0, min(a[3], b[3]) - max(a[1], b[1]))
    area = lambda box: max(0, box[2] - box[0]) * max(0, box[3] - box[1])
    return intersection / max(1, area(a) + area(b) - intersection)


def build(manifest: Path, output: Path) -> None:
    protocol = read_json(manifest)
    saved = output / "protocol.json"
    if saved.exists() and read_json(saved) != protocol:
        raise ValueError("This output belongs to a different protocol; choose a new directory.")
    write_json(saved, protocol)
    results = []
    for entry in protocol["frames"]:
        source = (ROOT / entry["sourceRun"]).resolve()
        frame, masks = require_frame(source), read_json(source / "segmentation.json")
        if entry["frameId"] != frame["id"] or masks["frameId"] != frame["id"] or masks["status"] != "complete":
            raise ValueError("Annotation and completed measurements must refer to the same frame.")
        source_geometry = read_json(source / "geometry.json")
        inventory = {item["id"]: item for item in masks["instances"]}
        for arm, region, depth in ARMS:
            run = output / entry["name"] / arm
            run.mkdir(parents=True, exist_ok=True)
            (run / "masks").mkdir(exist_ok=True)
            record = {"frame": entry["name"], "arm": arm, "path": run.relative_to(output).as_posix()}
            if (run / "result.json").exists():
                results.append(read_json(run / "result.json"))
                continue
            for filename in ("original.png", "frame.png", "frame.json", "geometry.json", "geometry.npz", "depth-input.png"):
                if (source / filename).exists():
                    shutil.copy2(source / filename, run / filename)
            selected = []
            for annotation in entry["objects"]:
                key = annotation.get("samId")
                if key is None:
                    continue
                if key not in inventory:
                    raise ValueError(f"Annotated SAM ID not found: {entry['name']}/{key}")
                item = inventory[key]
                shutil.copy2(source / item["mask"], run / item["mask"])
                selected.append(item)
            # Ground supervision is explicit and identical in all four arms.
            ground = Image.new("L", (frame["width"], frame["height"]))
            drawing = ImageDraw.Draw(ground)
            for polygon in entry["groundPolygons"]:
                drawing.polygon([tuple(point) for point in polygon], fill=255)
            ground.save(run / "masks/benchmark-ground.png")
            selected.append({"id": "benchmark-ground", "samId": -1, "concept": "floor", "mask": "masks/benchmark-ground.png",
                             "box": list(ground.getbbox()), "pixels": int(np.count_nonzero(np.asarray(ground))), "score": None})
            write_json(run / "segmentation.json", {**masks, "instances": selected,
                       "benchmarkSelection": "Fixed visible-object inventory; ground polygons visually annotated before depth inference."})
            started = time.perf_counter()
            try:
                reconstruct(run, ["floor"], region_mode=region, object_depth=depth)
                make_report(run)
                record.update(status="awaiting-render", reconstructionSeconds=time.perf_counter() - started)
            except (ValueError, RuntimeError) as error:
                record.update(status="failed", error=str(error), reconstructionSeconds=time.perf_counter() - started)
            record["geometryModel"] = source_geometry["model"]
            record["depthRuntime"] = source_geometry.get("runtime")
            write_json(run / "result.json", record)
            results.append(record)
    write_json(output / "benchmark.json", {"format": "LittleTake.geometry-ablation", "version": 1, "results": results})
    summarize(output)


def summarize(output: Path) -> dict:
    protocol, experiment = read_json(output / "protocol.json"), read_json(output / "benchmark.json")
    frames = {entry["name"]: entry for entry in protocol["frames"]}
    depth_checks = []
    for entry in protocol["frames"]:
        if not all("depthProbe" in obj for obj in entry["objects"]):
            continue
        source = ROOT / entry["sourceRun"]
        with np.load(source / "geometry.npz", allow_pickle=False) as arrays:
            depth, affine = arrays["depth"], arrays["image_to_depth"]
            probes = {}
            for obj in entry["objects"]:
                uv = affine @ [*obj["depthProbe"], 1]
                x, y = np.rint(uv[:2]).astype(int)
                patch = depth[max(0, y - 2):y + 3, max(0, x - 2):x + 3]
                valid = patch[np.isfinite(patch) & (patch > 0)]
                probes[obj["name"]] = float(np.median(valid)) if valid.size else None
            for near, far in entry["nearFarPairs"]:
                a, b = probes[near], probes[far]
                delta = (b - a) / max((a + b) / 2, 1e-9) if a is not None and b is not None else None
                state = "missing" if delta is None else "unresolved" if abs(delta) <= .02 else "correct" if delta > 0 else "wrong"
                depth_checks.append({"frame": entry["name"], "near": near, "far": far, "state": state,
                                     "nearDepth": a, "farDepth": b, "relativeDepthMargin": delta})
    results = []
    for original in experiment["results"]:
        record = {key: value for key, value in original.items() if key not in ("metrics",)}
        run, entry = output / record["path"], frames[record["frame"]]
        if record["status"] == "failed":
            results.append(record)
            continue
        layout, rendered = read_json(run / "layout.json"), read_json(run / "rendered-measurements.json")
        if rendered.get("layoutId") != layout["id"]:
            raise ValueError("Stale capture cannot be scored.")
        objects = {obj["id"]: obj for obj in layout["objects"]}
        visible = {obj["id"]: obj for obj in rendered.get("objects", [])}
        crop_x, crop_y = layout["crop"][:2]
        named, object_metrics = {}, []
        for annotation in entry["objects"]:
            obj = objects.get(annotation.get("samId"))
            capture = visible.get(annotation.get("samId"))
            named[annotation["name"]] = obj
            box = annotation["box"]
            expected = [box[0] + crop_x, box[1] + crop_y, box[2] + crop_x, box[3] + crop_y]
            metric = {"name": annotation["name"], "detected": obj is not None,
                      "visibleBoxIoU": box_iou(capture.get("visibleBox") if capture else None, expected),
                      "samSilhouetteIoU": capture.get("silhouetteIoU") if capture else None}
            if obj is not None and annotation.get("grounded"):
                transform = obj["transform"]
                metric["groundGapFractionOfHeight"] = abs(transform["position"][1] - transform["scale"][1] / 2) / max(transform["scale"][1], 1e-9)
            object_metrics.append(metric)
        pair_metrics = []
        for near, far in entry["nearFarPairs"]:
            a, b = named[near], named[far]
            state, delta = "missing", None
            if a is not None and b is not None:
                da, db = a["visibleSurfaceCameraDepth"], b["visibleSurfaceCameraDepth"]
                delta = (db - da) / max((da + db) / 2, 1e-9)
                state = "unresolved" if abs(delta) <= .02 else "correct" if delta > 0 else "wrong"
            pair_metrics.append({"near": near, "far": far, "state": state, "relativeDepthMargin": delta})
        record["metrics"] = {"objects": object_metrics, "pairs": pair_metrics,
                             "floorInlierFraction": layout["ground"]["inlierFraction"]}
        record["status"] = "rendered" if visible else "awaiting-render"
        results.append(record)
    aggregates = []
    for arm, _, _ in ARMS:
        complete = [record for record in results if record["arm"] == arm and record["status"] == "rendered"]
        object_metrics = [obj for record in complete for obj in record["metrics"]["objects"]]
        pairs = [pair for record in complete for pair in record["metrics"]["pairs"]]
        ground = [obj["groundGapFractionOfHeight"] for obj in object_metrics if "groundGapFractionOfHeight" in obj]
        silhouettes = [obj["samSilhouetteIoU"] for obj in object_metrics if obj["samSilhouetteIoU"] is not None]
        aggregates.append({"arm": arm, "renderedFrames": len(complete), "expectedFrames": len(frames),
                           "annotatedObjects": len(object_metrics), "detectedObjects": sum(obj["detected"] for obj in object_metrics),
                           "meanVisibleBoxIoU": float(np.mean([obj["visibleBoxIoU"] for obj in object_metrics])) if object_metrics else None,
                           "meanSamSilhouetteIoU": float(np.mean(silhouettes)) if silhouettes else None,
                           "ordinal": {state: sum(pair["state"] == state for pair in pairs) for state in ("correct", "wrong", "unresolved", "missing")},
                           "totalPairs": len(pairs), "medianGroundGapFractionOfHeight": float(np.median(ground)) if ground else None})
    result = {**experiment, "status": "complete" if all(record["status"] in ("rendered", "failed") for record in results) else "awaiting-render",
              "protocol": protocol["description"], "limitations": protocol["limitations"], "results": results, "aggregates": aggregates,
              "independentDepthProbes": {"totalPairs": len(depth_checks), "counts": {state: sum(pair["state"] == state for pair in depth_checks) for state in ("correct", "wrong", "unresolved", "missing")},
                                         "meaning": "VGGT depth at RGB-annotated interior points; independent of SAM detections, using 5x5 median depth and 2% ordinal tolerance.", "pairs": depth_checks}}
    if (output / "raw-pipeline.json").exists():
        result["rawPipeline"] = read_json(output / "raw-pipeline.json")
        for raw in result["rawPipeline"]:
            capture = output / raw["path"] / "rendered-measurements.json"
            if capture.exists() and read_json(capture).get("objects"):
                if read_json(capture)["layoutId"] != read_json(output / raw["path"] / "layout.json")["id"]:
                    raise ValueError("Stale raw-pipeline render cannot be used.")
                raw["status"] = "rendered"
    if (output / "joint/benchmark.json").exists():
        joint = read_json(output / "joint/benchmark.json")
        paired_frames = {item["frame"] for item in joint["results"]}
        def paired(data):
            objects = [obj for item in data["results"] if item["frame"] in paired_frames and item["arm"] == "mask-dense" and item["status"] == "rendered" for obj in item["metrics"]["objects"]]
            probes = [item for item in data["independentDepthProbes"]["pairs"] if item["frame"] in paired_frames]
            return {"meanVisibleBoxIoU": float(np.mean([obj["visibleBoxIoU"] for obj in objects])) if objects else None,
                    "correctDepthProbes": sum(item["state"] == "correct" for item in probes), "totalDepthProbes": len(probes)}
        result["jointComparison"] = {"frames": sorted(paired_frames), "single": paired(result), "joint": paired(joint),
                                     "note": "Paired same-frame comparison only; not mixed with the three-frame aggregate."}
        result["limitations"] = ["Two-view VGGT is a paired diagnostic; Agent refinement, metric 3D accuracy and a registered multi-view scene remain unverified."
                                 if item.startswith("Agent refinement and multi-view") else item for item in result["limitations"]]
    write_json(output / "benchmark.json", result)
    render_index(output, result, protocol)
    return result


def render_index(output: Path, result: dict, protocol: dict) -> None:
    fmt = lambda value: "pending" if value is None else f"{value:.3f}"
    labels = {"box-constant": "边界框 + 统一深度", "mask-constant": "精细 mask + 统一深度",
              "box-dense": "边界框 + VGGT 深度", "mask-dense": "精细 mask + VGGT 深度"}
    rows = []
    for aggregate in result["aggregates"]:
        ordinal = aggregate["ordinal"]
        rows.append(f"<tr><td>{labels[aggregate['arm']]}</td><td>{aggregate['renderedFrames']}/{aggregate['expectedFrames']}</td>"
                    f"<td>{aggregate['detectedObjects']}/{aggregate['annotatedObjects']}</td><td>{fmt(aggregate['meanVisibleBoxIoU'])}</td>"
                    f"<td>{ordinal['correct']}/{aggregate['totalPairs']}</td><td>{ordinal['wrong']}</td><td>{ordinal['unresolved']}</td>"
                    f"<td>{fmt(aggregate['medianGroundGapFractionOfHeight'])}</td></tr>")
    galleries = []
    for entry in protocol["frames"]:
        records = [record for record in result["results"] if record["frame"] == entry["name"]]
        first = records[0]["path"]
        tiles = [f'<figure><img src="{first}/original.png"><figcaption>原图</figcaption></figure>',
                 f'<figure><img src="{first}/depth.png"><figcaption>VGGT 相对深度：暗处近、亮处远</figcaption></figure>']
        for record in records:
            path = escape(record["path"])
            caption = escape(labels[record["arm"]] + (": " + record["error"] if record.get("error") else ""))
            tiles.append(f'<figure><a href="{path}/report.html"><img src="{path}/restored.png"><figcaption>{caption}</figcaption></a></figure>')
        galleries.append(f"<h2>{escape(entry['name'])}</h2><div class=gallery>{''.join(tiles)}</div>")
    limitations = "".join(f"<li>{escape(item)}</li>" for item in result["limitations"])
    probes = result["independentDepthProbes"]
    extra = ""
    if (output / "visual-review.json").exists():
        review = read_json(output / "visual-review.json")
        extra += "<h2>视觉检查</h2><p class=notice>深度观测已验证，当前粗代理仍有明显造型和遮挡问题，尚未达到片场还原要求。</p>"
        extra += "<ul>" + "".join(f"<li>{escape(item)}</li>" for item in review["findings"]) + "</ul><p><a href='visual-review.json'>视觉检查记录</a> · <a href='verification.json'>本地验证记录</a></p>"
    if result.get("jointComparison"):
        comparison = result["jointComparison"]
        single, joint = comparison["single"], comparison["joint"]
        extra += f"<h2>同镜头双帧对照</h2><p>只对比相同的两帧：可见框 IoU 单帧 {fmt(single['meanVisibleBoxIoU'])}，双帧 {fmt(joint['meanVisibleBoxIoU'])}；独立深度顺序单帧 {single['correctDepthProbes']}/{single['totalDepthProbes']}，双帧 {joint['correctDepthProbes']}/{joint['totalDepthProbes']}。不将双帧直接作为更优方案。</p><p><a href='joint/index.html'>打开双帧对照与原始数据</a></p>"
    if result.get("rawPipeline"):
        extra += "<h2>直接使用原始 SAM 地面</h2><p>以下流程没有使用标注地面。数值平面拟合通过不代表还原的造型和遮挡正确。</p><ul>"
        for item in result["rawPipeline"]:
            extra += f"<li><a href='{escape(item['path'])}/report.html'>{escape(item['frame'])}</a>：{escape(item['status'])}，{item.get('objectCount', 0)} 个粗代理</li>"
        extra += "</ul>"
    content = f'''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>LittleTake 几何消融验证</title>
<style>body{{font:15px/1.6 system-ui;background:#f6f7f2;color:#283020;margin:30px auto;max-width:1500px;padding:0 20px}}h1,h2{{font-weight:600}}table{{border-collapse:collapse;width:100%;background:white}}td,th{{text-align:left;padding:12px;border-bottom:1px solid #dde1d4}}a{{color:#456242}}.gallery{{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}}figure{{margin:0;background:white}}img{{width:100%;display:block}}figcaption{{padding:10px}}.notice{{padding:16px;background:#e8eddc;border-radius:8px}}@media(max-width:900px){{.gallery{{grid-template-columns:repeat(2,1fr)}}}}</style>
<h1>本地 SAM + VGGT 消融验证</h1><p class=notice>{len(protocol['frames'])} 帧离线诊断。所有组固定候选物体、VGGT 相机和标注地面，只改变前景采样范围与前景深度。本轮尚未测试 Agent 完整流程。</p>
<p>状态：{result['status']}。统一深度表示所有前景物体放在相同相机深度；逐像素深度来自 VGGT。边界框与 mask 只影响深度采样范围。框与前后顺序由 Codex 从原图粗标，尚未经人工复核。</p>
<p>独立深度探针：在原图预先标注的物体内部位置读取 VGGT 深度，不依赖 SAM 是否检出。前后正确 {probes['counts']['correct']}/{probes['totalPairs']}，错误 {probes['counts']['wrong']}，无法分辨 {probes['counts']['unresolved']}。</p>
<table><thead><tr><th>方法</th><th>已渲染帧</th><th>物体覆盖</th><th>可见框 IoU ↑</th><th>前后正确 ↑</th><th>前后错误 ↓</th><th>无法分辨 ↓</th><th>地面间隙 / 高度 ↓</th></tr></thead><tbody>{''.join(rows)}</tbody></table>
{extra}<ul>{limitations}</ul>{''.join(galleries)}<p><a href="benchmark.json">完整测量</a> · <a href="protocol.json">固定标注与协议</a></p></html>'''
    (output / "index.html").write_text(content, encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("build", "summarize"))
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument("--manifest", type=Path)
    args = parser.parse_args()
    if args.command == "build":
        if not args.manifest:
            parser.error("build requires --manifest")
        build(args.manifest, args.run.resolve())
    else:
        result = summarize(args.run.resolve())
        print(result["status"])
        for arm in result["aggregates"]:
            print(arm)
