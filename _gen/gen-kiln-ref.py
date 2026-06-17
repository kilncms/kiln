#!/usr/bin/env python3
"""Regenerate Kiln scene art to MATCH a reference image (style, palette, character).
Run with the hermes venv python:
  ~/.hermes/hermes-agent/venv/bin/python _gen/gen-kiln-ref.py <reference-image.png> [hero]
Outputs PNGs into site/assets/img/ (then process_img.py -> webp).
Uses gpt-image-2 via Codex OAuth (zero API cost), with the reference image as input.
"""
import sys, pathlib
sys.path.insert(0, str(pathlib.Path.home() / "repos/muskratandrorke/src"))
from pipeline.codex_image import generate_with_reference

ref = pathlib.Path(sys.argv[1]).expanduser().resolve()
do_hero = len(sys.argv) > 2 and sys.argv[2] == "hero"
OUT = pathlib.Path(__file__).resolve().parent.parent / "site/assets/img"

STYLE = (
    " Match the EXACT art style, linework, color palette, lighting and mood of the reference image: "
    "a detailed clean comic-ink illustration, cool muted palette of dusty periwinkle-blue and muted "
    "green with warm orange and terracotta accents, flat cel shading, calm evening light, a faint paper "
    "border. Where a person appears, keep the same character: a Black man with a knit beanie and white "
    "over-ear headphones. No text, letters, numbers, logos or watermark anywhere in the image."
)

SCENES = {
    "orphaned": "A finished simple website shown on an open laptop sitting alone on a side table in a quiet dim room at night, the seat empty, a cold mug of coffee and a small note beside it, a potted plant, cool moonlight through a window. A lonely, still mood, a project nobody can touch."
    + STYLE,
    "handoff": "Two people in a room: one calmly handing a single small key to the other across an open laptop on a low table, both relaxed and friendly, coffee mugs and a leafy potted plant nearby. A warm, trusting, collaborative mood."
    + STYLE,
    "craft": "A cozy corner of a home studio: a wooden shelf of handmade ceramic mugs and bowls in muted tones beside a small pottery kiln glowing softly warm, a trailing potted plant, evening light and gentle shadows. A calm, crafted, made-to-last feeling."
    + STYLE,
}
if do_hero:
    SCENES["hero"] = (
        "A young man relaxing on a couch with an open laptop, a knit beanie and white over-ear "
        "headphones around his neck, a mug of coffee with a thin wisp of steam on a side table, "
        "potted plants, a small framed picture on the wall, calm evening light. Relaxed, content mood, "
        "with comfortable negative space." + STYLE
    )

for name, prompt in SCENES.items():
    print(f">>> {name}", flush=True)
    try:
        img = generate_with_reference(prompt=prompt, reference_image_path=ref,
                                      aspect="square", quality="high",
                                      background="opaque", timeout_sec=300)
        (OUT / f"{name}.png").write_bytes(img)
        print(f"OK  {OUT / (name + '.png')}", flush=True)
    except Exception as e:
        print(f"FAIL {name}: {e}", flush=True)
print("DONE")
