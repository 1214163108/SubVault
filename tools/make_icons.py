"""Generate SubVault icons (rounded gradient tile + padlock).

Usage:
    python tools/make_icons.py
"""

from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

SIZE = 1024
OUT = Path(__file__).resolve().parent.parent / "icons"


def gradient(size: int) -> Image.Image:
    top = np.array([79, 70, 229], dtype=np.float32)     # indigo
    bottom = np.array([124, 58, 237], dtype=np.float32)  # violet
    y, x = np.mgrid[0:size, 0:size].astype(np.float32)
    t = np.clip((x * 0.35 + y * 0.65) / (size - 1), 0, 1)
    rgb = top[None, None, :] * (1 - t[..., None]) + bottom[None, None, :] * t[..., None]
    return Image.fromarray(rgb.astype(np.uint8), "RGB").convert("RGBA")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    img = gradient(SIZE)

    mask = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, SIZE - 1, SIZE - 1), radius=230, fill=255)
    img.putalpha(mask)

    # Soft top highlight.
    shine = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shine)
    sd.ellipse((-260, -640, SIZE + 260, 420), fill=(255, 255, 255, 34))
    img = Image.alpha_composite(img, Image.composite(shine, Image.new("RGBA", img.size, (0, 0, 0, 0)), mask))

    draw = ImageDraw.Draw(img)

    # Padlock shackle.
    shackle = (382, 258, 642, 566)
    draw.arc(shackle, start=180, end=360, fill=(255, 255, 255, 255), width=92)
    draw.rectangle((382, 420, 474, 520), fill=(255, 255, 255, 255))
    draw.rectangle((550, 420, 642, 520), fill=(255, 255, 255, 255))

    # Padlock body.
    draw.rounded_rectangle((296, 468, 728, 806), radius=86, fill=(255, 255, 255, 255))

    # Keyhole.
    draw.ellipse((462, 550, 562, 650), fill=(88, 63, 232, 255))
    draw.polygon([(484, 626), (540, 626), (556, 722), (468, 722)], fill=(88, 63, 232, 255))

    for size in (128, 48, 32, 16):
        resized = img.resize((size, size), Image.Resampling.LANCZOS)
        resized.save(OUT / f"icon{size}.png", optimize=True)
        print(f"wrote icons/icon{size}.png")


if __name__ == "__main__":
    main()
