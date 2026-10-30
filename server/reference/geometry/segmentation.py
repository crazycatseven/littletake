"""Mask inspection artifacts, independent of depth estimation or 3D rendering."""
from __future__ import annotations

from html import escape
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

from files import read_json, require_frame, write_json

COLORS = [(35, 180, 239), (255, 171, 55), (223, 92, 169), (67, 204, 129), (165, 128, 245), (242, 105, 82)]


def render_masks(run: Path) -> None:
    frame, masks = require_frame(run), read_json(run / "segmentation.json")
    if masks["frameId"] != frame["id"] or masks["status"] != "complete":
        raise ValueError("A completed segmentation of this exact frame is required.")
    original = Image.open(run / "original.png").convert("RGB")
    left, top, width, height = frame["crop"]
    font = ImageFont.truetype("C:/Windows/Fonts/arial.ttf", 19) if Path("C:/Windows/Fonts/arial.ttf").exists() else ImageFont.load_default(size=19)
    titles = masks["request"]["prompts"]
    by_concept = {title: [] for title in titles}
    for item in masks["instances"]:
        by_concept[item["concept"]].append(item)

    def overlay(items: list[dict]) -> Image.Image:
        output = original.convert("RGBA")
        for item in items:
            mask = Image.open(run / item["mask"]).convert("L")
            if mask.size != (width, height):
                raise ValueError("Mask dimensions differ from source-crop pixels.")
            color = COLORS[titles.index(item["concept"]) % len(COLORS)]
            layer = Image.new("RGBA", mask.size, color + (0,))
            layer.putalpha(mask.point(lambda value: round(value * .34)))
            output.alpha_composite(layer, (left, top))
            edge = Image.new("RGBA", mask.size, color + (0,))
            edge.putalpha(mask.filter(ImageFilter.FIND_EDGES))
            output.alpha_composite(edge, (left, top))
            draw = ImageDraw.Draw(output)
            x1, y1, x2, y2 = item["box"]
            box = (left + x1, top + y1, left + x2 - 1, top + y2 - 1)
            draw.rectangle(box, outline=color, width=2)
            label = f'{item["id"]} {item["concept"]}'
            label_box = draw.textbbox((box[0] + 3, box[1] + 3), label, font=font)
            draw.rectangle(label_box, fill=(20, 25, 33, 235))
            draw.text((box[0] + 3, box[1] + 3), label, font=font, fill=color)
        return output.convert("RGB")

    combined = overlay(masks["instances"])
    combined.save(run / "segmentation-overlay.png")
    tiles = [("REFERENCE - original pixels", original), ("ALL MASKS - false colors", combined)]
    tiles.extend((f'{title} - {len(by_concept[title])} instances', overlay(by_concept[title])) for title in titles)
    tile_width, tile_height = 640, round(640 * original.height / original.width)
    sheet = Image.new("RGB", (tile_width * 2, (tile_height + 38) * ((len(tiles) + 1) // 2)), "#171c25")
    draw = ImageDraw.Draw(sheet)
    for index, (title, pixels) in enumerate(tiles):
        x, y = (index % 2) * tile_width, (index // 2) * (tile_height + 38)
        draw.text((x + 12, y + 9), title, font=font, fill="white")
        sheet.paste(pixels.resize((tile_width, tile_height), Image.Resampling.LANCZOS), (x, y + 38))
    sheet.save(run / "segmentation-contact-sheet.jpg", quality=93)
    summary = {"frameId": frame["id"], "model": masks["model"], "status": "awaiting_visual_review",
               "note": "Masks and boxes are observations, not 3D geometry or validated scene reconstruction.",
               "concepts": [{"concept": concept, "count": len(items), "pixels": sum(item["pixels"] for item in items)} for concept, items in by_concept.items()],
               "totalInstances": len(masks["instances"]), "elapsedSeconds": masks.get("elapsedSeconds"),
               "measuredConceptSeconds": sum(call.get("elapsedSeconds", 0) for call in masks["calls"]),
               "timingScope": "elapsedSeconds/peak memory describe the last process; concept times retain completed work across resumed processes"}
    write_json(run / "segmentation-review.json", summary)
    rows = "".join(f'<tr><td>{escape(item["id"])}</td><td>{escape(item["concept"])}</td><td>{item["pixels"]}</td><td>{escape(str(item["score"]))}</td><td><a href="{escape(item["mask"], quote=True)}">Binary mask</a></td></tr>' for item in masks["instances"])
    review_html = ""
    if (run / "visual-review.json").exists():
        review = read_json(run / "visual-review.json")
        if review["frameId"] == frame["id"] and review["model"] == masks["model"] and review["request"] == masks["request"]:
            review_html = '<h2>Visual review</h2><p>' + escape(review["summary"]) + '</p><ul>' + ''.join('<li>' + escape(note) + '</li>' for note in review["findings"]) + '</ul>'
    comparison_html = '<h2>Same-frame prompt comparison</h2><img src="prompt-comparison.jpg">' if (run / "prompt-comparison.jpg").exists() else ''
    provider = "Meta API" if masks["model"].get("provider") == "Meta Model API" else "Local"
    document = f'''<!doctype html><html lang="en"><meta charset="utf-8"><title>SAM 3.1 segmentation · {provider}</title>
<style>body{{margin:24px;background:#171c25;color:#e6edf6;font:15px system-ui}}img{{max-width:100%;height:auto}}.pair{{display:grid;grid-template-columns:1fr 1fr;gap:16px}}figure{{margin:0}}h1{{font-size:24px}}td,th{{text-align:left;padding:8px 18px 8px 0}}a{{color:#79ccff}}</style>
<h1>SAM 3.1 segmentation · {provider}</h1><p>Original pixels and false-color masks. No depth or 3D reconstruction is shown.</p>
<div class="pair"><figure><figcaption>Reference</figcaption><img src="original.png"></figure><figure><figcaption>Segmentation</figcaption><img src="segmentation-overlay.png"></figure></div>
{review_html}<h2>Per-concept inspection</h2><img src="segmentation-contact-sheet.jpg">{comparison_html}<h2>Raw instances</h2>
<table><thead><tr><th>ID</th><th>Concept</th><th>Pixels</th><th>Model score</th><th>Evidence</th></tr></thead><tbody>{rows}</tbody></table>
<p><a href="segmentation.json">Full measurement</a> · <a href="segmentation-review.json">Review summary</a></p></html>'''
    (run / "segmentation.html").write_text(document, encoding="utf-8")
