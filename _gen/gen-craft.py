#!/usr/bin/env python3
"""Regenerate ONLY the craft/kiln scene to match a reference image (cool palette)."""
import sys, pathlib
sys.path.insert(0, str(pathlib.Path.home() / "repos/muskratandrorke/src"))
from pipeline.codex_image import generate_with_reference
ref = pathlib.Path(sys.argv[1]).expanduser().resolve()
OUT = pathlib.Path(__file__).resolve().parent.parent / "site/assets/img/craft.png"
prompt = (
    "A cozy corner of a home ceramics studio: a wooden shelf of handmade mugs and bowls in muted "
    "tones beside a small pottery kiln glowing softly warm, a trailing potted plant in a terracotta "
    "pot, soft evening light. Calm, crafted, made-to-last feeling. "
    "Match the EXACT art style, linework, cool muted color palette (dusty periwinkle-blue and muted "
    "green with warm orange and terracotta accents), flat shading and calm mood of the reference image. "
    "No text, letters, numbers, logos or watermark anywhere."
)
img = generate_with_reference(prompt=prompt, reference_image_path=ref, aspect="square",
                              quality="high", background="opaque", timeout_sec=300)
OUT.write_bytes(img)
print("OK", OUT)
