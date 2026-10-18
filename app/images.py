"""Normalisation des images : PNG de 256 px de côté au plus, en data URL."""
from __future__ import annotations

import base64
import binascii
import io

from PIL import Image, ImageOps, UnidentifiedImageError

MAX_SIDE = 256
NOT_AN_IMAGE = "Ce n'est pas une image"
MAX_PIXELS = 80_000_000  # au-delà : refus (évite de décoder une image démesurée)


def normalize_image(data: bytes | str) -> str:
    if isinstance(data, str):
        if not data.startswith("data:") or "," not in data:
            raise ValueError(NOT_AN_IMAGE)
        try:
            data = base64.b64decode(data.split(",", 1)[1], validate=True)
        except (binascii.Error, ValueError) as e:
            raise ValueError(NOT_AN_IMAGE) from e
    try:
        im = Image.open(io.BytesIO(data))
        if im.width * im.height > MAX_PIXELS:
            raise ValueError("Image trop grande (plus de 80 millions de pixels)")
        im.draft("RGB", (MAX_SIDE * 4, MAX_SIDE * 4))  # JPEG : décodage directement réduit
        im.load()
        im = ImageOps.exif_transpose(im)  # photos de téléphone remises à l'endroit
    except (UnidentifiedImageError, Image.DecompressionBombError, OSError, SyntaxError) as e:
        raise ValueError(NOT_AN_IMAGE) from e
    im = im.convert("RGBA" if im.mode in ("RGBA", "LA", "P", "PA") or "transparency" in im.info else "RGB")
    im.thumbnail((MAX_SIDE, MAX_SIDE), Image.LANCZOS)
    out = io.BytesIO()
    im.save(out, "PNG", optimize=True)
    return "data:image/png;base64," + base64.b64encode(out.getvalue()).decode("ascii")
