"""Explicit local geometry commands. No command starts inference implicitly."""
from __future__ import annotations

import argparse
import base64
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import uuid

from files import DATA, ROOT, read_json, require_frame, write_json


def extract(args) -> None:
    from PIL import Image
    import numpy as np
    run = args.run
    if run.exists() and any(run.iterdir()):
        raise ValueError("Choose an empty run directory; existing measurements are preserved.")
    run.mkdir(parents=True, exist_ok=True)
    if args.image:
        with Image.open(args.image) as image:
            image.convert("RGB").save(run / "original.png")
        source = {"path": str(args.image.resolve()), "kind": "image"}
    else:
        probe = json.loads(subprocess.check_output([
            "ffprobe", "-v", "error", "-select_streams", "v:0", "-show_frames",
            "-show_entries", "frame=best_effort_timestamp_time", "-of", "json", str(args.video),
        ], text=True))
        times = [float(frame["best_effort_timestamp_time"]) for frame in probe["frames"]]
        index = args.frame_index
        if index < 0 or index >= len(times):
            raise ValueError("Frame index is outside the source clip.")
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(args.video),
                        "-vf", f"select=eq(n\\,{index})", "-fps_mode", "vfr", "-frames:v", "1", str(run / "original.png")], check=True)
        source = {"path": str(args.video.resolve()), "kind": "video", "frameIndex": index, "time": times[index]}
    image = Image.open(run / "original.png").convert("RGB")
    width, height = image.size
    left = top = 0
    right, bottom = width, height
    if not args.keep_borders:
        dark = np.asarray(image).max(axis=-1) <= 3
        while left < width // 4 and dark[:, left].mean() >= .995:
            left += 1
        while right > width * .75 and dark[:, right - 1].mean() >= .995:
            right -= 1
        while top < height // 4 and dark[top, left:right].mean() >= .995:
            top += 1
        while bottom > height * .75 and dark[bottom - 1, left:right].mean() >= .995:
            bottom -= 1
    image.crop((left, top, right, bottom)).save(run / "frame.png")
    write_json(run / "frame.json", {"format": "LittleTake.reference-frame", "version": 1, "id": str(uuid.uuid4()),
               "source": source, "originalSize": [width, height], "width": right - left, "height": bottom - top,
               "crop": [left, top, right - left, bottom - top], "frameBounds": [left / width, top / height, right / width, bottom / height],
               "borderRule": "retained" if args.keep_borders else "near-black edge consensus; original pixels retained separately"})
    print(f"Source frame saved: {run}", flush=True)


def make_report(run: Path) -> None:
    shutil.copyfile(Path(__file__).with_name("report.html"), run / "report.html")


def serve(run: Path, port: int) -> None:
    """Loopback report only; this server never imports or invokes a model."""
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from urllib.parse import unquote, urlsplit
    from PIL import Image
    import mimetypes
    run = run.resolve()
    layout = read_json(run / "layout.json") if (run / "layout.json").exists() else None
    index = "index.html" if (run / "benchmark.json").exists() else "report.html" if layout is not None else "segmentation.html"
    if not (run / index).is_file():
        raise ValueError("Complete segmentation or layout before opening a report.")
    vendor = {"three.module.js": ROOT / "node_modules/three/build/three.module.js",
              "three.core.js": ROOT / "node_modules/three/build/three.core.js",
              "OrbitControls.js": ROOT / "node_modules/three/examples/jsm/controls/OrbitControls.js"}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            route = unquote(urlsplit(self.path).path)
            if route.startswith("/vendor/"):
                file = vendor.get(route.removeprefix("/vendor/"))
            else:
                file = (run / (route.lstrip("/") or index)).resolve()
                if not file.is_relative_to(run):
                    file = None
            if file is None or not file.is_file():
                self.send_error(404)
                return
            content = file.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", mimetypes.guess_type(file)[0] or "application/octet-stream")
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(content)

        def do_POST(self):
            origin = self.headers.get("Origin")
            if origin and origin != f"http://127.0.0.1:{port}":
                self.send_error(403)
                return
            route = (run / unquote(urlsplit(self.path).path).lstrip("/")).resolve()
            capture_run = route.parent
            if route.name != "capture" or not capture_run.is_relative_to(run) or not (capture_run / "layout.json").is_file() or not 0 < int(self.headers.get("Content-Length", "0")) <= 12_000_000:
                self.send_error(400)
                return
            try:
                data = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                current_layout = read_json(capture_run / "layout.json")
                if data.get("layoutId") != current_layout["id"]:
                    raise ValueError("This capture belongs to an outdated layout.")
                for key, filename in (("restored", "restored.png"), ("topDown", "top-down.png")):
                    prefix = "data:image/png;base64,"
                    if not isinstance(data.get(key), str) or not data[key].startswith(prefix):
                        raise ValueError("Expected a PNG capture.")
                    pixels = base64.b64decode(data[key][len(prefix):], validate=True)
                    image = Image.open(io.BytesIO(pixels))
                    if image.format != "PNG" or list(image.size) != current_layout["sourceSize"]:
                        raise ValueError("Capture dimensions differ from the source frame.")
                    image.verify()
                ids = {obj["id"] for obj in current_layout["objects"]}
                metrics = data["measurements"]
                if not isinstance(metrics, list) or {item["id"] for item in metrics} != ids:
                    raise ValueError("Visibility measurements differ from the reconstructed objects.")
                for key, filename in (("restored", "restored.png"), ("topDown", "top-down.png")):
                    (capture_run / filename).write_bytes(base64.b64decode(data[key].split(",", 1)[1], validate=True))
                write_json(capture_run / "rendered-measurements.json", {"layoutId": current_layout["id"], "renderer": "Three.js WebGL depth-tested object IDs", "objects": metrics,
                           "status": "unreviewed", "note": "Metrics describe proxy agreement; they do not establish reconstruction quality."})
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{"saved":true}')
            except (ValueError, KeyError, TypeError):
                self.send_error(400)

        def log_message(self, format, *values):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"Report: http://127.0.0.1:{port}/  (Ctrl+C stops; opening the page renders WebGL)", flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()


def parser() -> argparse.ArgumentParser:
    cli = argparse.ArgumentParser(description="Reference geometry: cloud/local SAM, local VGGT and SAM 3D Body, explicit inspection.")
    commands = cli.add_subparsers(dest="command", required=True)
    prepare = commands.add_parser("prepare", help="Download pinned source and weights, without loading models")
    prepare.add_argument("--model", choices=["sam3", "vggt", "sam3dbody", "all"], default="vggt", help="Default cloud SAM needs no local weights")
    prepare.add_argument("--vggt-repo", choices=["facebook/VGGT-1B", "facebook/VGGT-1B-Commercial"], default="facebook/VGGT-1B")
    source = commands.add_parser("extract", help="Save an exact reference frame and source mapping")
    source.add_argument("--run", type=Path, required=True)
    media = source.add_mutually_exclusive_group(required=True)
    media.add_argument("--image", type=Path)
    media.add_argument("--video", type=Path)
    source.add_argument("--frame-index", type=int, default=0)
    source.add_argument("--keep-borders", action="store_true")
    for name in ("segment", "depth", "body", "layout", "all", "serve"):
        command = commands.add_parser(name)
        command.add_argument("--run", type=Path, required=True)
        if name in ("segment", "all"):
            command.add_argument("--sam-provider", choices=["cloud", "local"], default=os.environ.get("SAM_PROVIDER") or "cloud")
            command.add_argument("--concepts", nargs="+", required=True, help="Short noun phrases, including the visible floor")
            command.add_argument("--threshold", type=float, default=.5)
            command.add_argument("--max-api-calls", type=int, default=8, help="Persistent SAM request cap for this run, including failures")
        if name in ("depth", "all"):
            command.add_argument("--depth-device", choices=["cuda", "cpu"], default="cuda")
        if name == "depth":
            command.add_argument("--context-runs", nargs="+", type=Path, help="Additional views of the same scene; saves joint geometry in every new run folder")
        if name in ("segment", "depth", "body", "all"):
            command.add_argument("--min-free-vram-gb", type=float, default=16)
        if name in ("body", "all"):
            command.add_argument("--person-concepts", nargs="+", default=["person"], help="Segmentation concepts that name people")
        if name == "all":
            command.add_argument("--body", action="store_true", help="Also estimate full-body joints with local SAM 3D Body before layout")
        if name in ("layout", "all"):
            command.add_argument("--floor-concepts", nargs="+", default=["floor"])
            command.add_argument("--known-height", help="Explicit unoccluded dimension constraint, e.g. p00-o1:1.8; never inferred automatically")
        if name == "serve":
            command.add_argument("--port", type=int, default=4184)
    return cli


def main() -> None:
    args = parser().parse_args()
    if hasattr(args, "run"):
        args.run = args.run.resolve()
    started = time.time()
    attempt_id = str(uuid.uuid4())
    outcome = {"phase": args.command, "status": "complete"}
    try:
        if args.command == "prepare":
            from prepare import prepare
            prepare(args.vggt_repo, args.model)
        elif args.command == "extract":
            extract(args)
        elif args.command == "all":
            require_frame(args.run)
            base = [sys.executable, str(Path(__file__).resolve())]
            subprocess.run(base + ["segment", "--run", str(args.run), "--sam-provider", args.sam_provider, "--threshold", str(args.threshold), "--max-api-calls", str(args.max_api_calls), "--min-free-vram-gb", str(args.min_free_vram_gb), "--concepts", *args.concepts], check=True)
            if not (args.run / "geometry.json").exists():
                subprocess.run(base + ["depth", "--run", str(args.run), "--depth-device", args.depth_device, "--min-free-vram-gb", str(args.min_free_vram_gb)], check=True)
            if args.body and not (args.run / "bodies.json").exists():
                subprocess.run(base + ["body", "--run", str(args.run), "--min-free-vram-gb", str(args.min_free_vram_gb), "--person-concepts", *args.person_concepts], check=True)
            command = base + ["layout", "--run", str(args.run), "--floor-concepts", *args.floor_concepts]
            if args.known_height:
                command += ["--known-height", args.known_height]
            subprocess.run(command, check=True)
        elif args.command == "segment":
            if not 0 <= args.threshold <= 1 or not all(0 < len(value.strip()) <= 100 for value in args.concepts):
                raise ValueError("Use short concepts and a probability threshold between 0 and 1.")
            if args.sam_provider == "cloud":
                from sam_api import segment
                segment(args.run, args.concepts, args.threshold, args.max_api_calls)
            elif args.sam_provider == "local":
                from sam_local import segment
                segment(args.run, args.concepts, args.threshold, args.min_free_vram_gb)
            else:
                raise ValueError("SAM_PROVIDER must be cloud or local.")
        elif args.command == "depth":
            os.environ["HF_HUB_OFFLINE"] = "1"
            os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
            from models import depth
            depth(args.run, args.depth_device, args.min_free_vram_gb, args.context_runs)
        elif args.command == "body":
            os.environ["HF_HUB_OFFLINE"] = "1"
            os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
            from body import estimate
            estimate(args.run, args.person_concepts, args.min_free_vram_gb)
        elif args.command == "layout":
            from layout import reconstruct
            anchor = None
            if args.known_height:
                object_id, value = args.known_height.rsplit(":", 1)
                anchor = (object_id, float(value))
            reconstruct(args.run, args.floor_concepts, anchor)
            make_report(args.run)
            print(f"Layout saved. Inspect with: python run.py serve --run \"{args.run}\"", flush=True)
        elif args.command == "serve":
            serve(args.run, args.port)
    except BaseException as error:
        outcome.update(status="interrupted" if isinstance(error, KeyboardInterrupt) else "failed", errorType=type(error).__name__, message=str(error))
        raise
    finally:
        if hasattr(args, "run") and args.run.is_dir() and args.command != "serve":
            outcome["elapsedSeconds"] = time.time() - started
            write_json(args.run / f"{args.command}-status.json", outcome)
            # Keep every invocation, including failures, instead of replacing its evidence on retry.
            write_json(args.run / "attempts" / f"{attempt_id}.json", {**outcome, "id": attempt_id,
                       "startedAtUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(started)),
                       "request": json.loads(json.dumps(vars(args), default=str))})


if __name__ == "__main__":
    main()
