"""Add a 52pojie watermark band to screenshots used in the forum post."""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
FONT = Path("C:/Windows/Fonts/msyh.ttc")
TEXT = "吾爱破解论坛  ·  52pojie.cn  ·  亲测截图"
ITEMS = [
    ("popover.png", "52pojie-popover.png", 24, 48),
    ("sync-import-gate.png", "52pojie-sync.png", 26, 52),
    ("popup-setup.png", "52pojie-popup.png", 12, 34),
    ("save-banner.png", "52pojie-save.png", 24, 48),
    ("save-banner-center.png", "52pojie-save-center.png", 24, 48),
]


def main() -> None:
    for source, target, size, band in ITEMS:
        image = Image.open(DOCS / source).convert("RGBA")
        overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
        draw = ImageDraw.Draw(overlay)
        draw.rectangle(
            (0, image.height - band, image.width, image.height),
            fill=(15, 23, 42, 220),
        )
        font = ImageFont.truetype(str(FONT), size)
        box = draw.textbbox((0, 0), TEXT, font=font)
        x = (image.width - (box[2] - box[0])) / 2
        y = image.height - band + (band - (box[3] - box[1])) / 2 - 1
        draw.text((x, y), TEXT, font=font, fill=(248, 250, 252, 255))
        Image.alpha_composite(image, overlay).convert("RGB").save(DOCS / target)
        print(f"wrote {DOCS / target}")


if __name__ == "__main__":
    main()
