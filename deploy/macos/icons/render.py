# /// script
# dependencies = ["pillow", "resvg-py"]
# ///
"""Render the SwiftBar menu bar glyphs from planet.svg.

Run from the app repo: `uv run deploy/macos/icons/render.py`. Writes monochrome
template PNGs (macOS tints them to match the menu bar) at 2x for a 22x18pt slot.
"""
import io
from pathlib import Path

import resvg_py
from PIL import Image, ImageDraw

HERE = Path(__file__).parent
W, H = 44, 36  # 22x18pt @2x; the planet is wider than tall
PAD_X, MAX_H = 2, 28
SS = 8  # supersample factor so edges and badges come out clean

png = bytes(resvg_py.svg_to_bytes(svg_path=str(HERE / "planet.svg"), width=1600))
art = Image.open(io.BytesIO(png)).getchannel("A")
art = art.crop(art.getbbox())
scale = min((W - 2 * PAD_X) * SS / art.width, MAX_H * SS / art.height)
art = art.resize((round(art.width * scale), round(art.height * scale)), Image.LANCZOS)
base = Image.new("L", (W * SS, H * SS), 0)
base.paste(art, ((base.width - art.width) // 2, (base.height - art.height) // 2))


def badge(alpha: Image.Image, hollow: bool) -> Image.Image:
    """Knock a gap out of the bottom-right corner and drop a dot or ring in it."""
    out = alpha.copy()
    cx, cy = (W - 6.5) * SS, (H - 6.5) * SS
    gap, dot, ring = 7 * SS, 5 * SS, 1.8 * SS
    d = ImageDraw.Draw(out)
    d.ellipse((cx - gap, cy - gap, cx + gap, cy + gap), fill=0)
    d.ellipse((cx - dot, cy - dot, cx + dot, cy + dot), fill=255)
    if hollow:
        r = dot - ring
        d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=0)
    return out


variants = {
    "ok": base,
    "warn": badge(base, hollow=False),
    "busy": badge(base, hollow=True),
    "down": base.point(lambda v: round(v * 0.4)),
}
for name, alpha in variants.items():
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    img.putalpha(alpha.resize((W, H), Image.LANCZOS))
    img.save(HERE / f"planet-{name}.png", dpi=(144, 144))
    print(HERE / f"planet-{name}.png")
