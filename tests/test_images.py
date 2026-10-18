import base64
import io

import pytest
from PIL import Image

from app.images import normalize_image


def png_bytes(w, h, mode="RGB"):
    buf = io.BytesIO()
    Image.new(mode, (w, h), (200, 50, 120) if mode == "RGB" else (200, 50, 120, 128)).save(buf, "PNG")
    return buf.getvalue()


def to_data_url(b, mime="image/png"):
    return f"data:{mime};base64," + base64.b64encode(b).decode()


def decode(data_url):
    assert data_url.startswith("data:image/png;base64,")
    return Image.open(io.BytesIO(base64.b64decode(data_url.split(",", 1)[1])))


def test_reduit_grande_image():
    im = decode(normalize_image(png_bytes(6000, 4000)))
    assert im.size == (256, 171)


def test_petite_image_inchangee():
    assert decode(normalize_image(png_bytes(64, 64))).size == (64, 64)


def test_data_url_entree():
    assert normalize_image(to_data_url(png_bytes(10, 10))).startswith("data:image/png")


def test_jpeg_converti_en_png():
    buf = io.BytesIO()
    Image.new("RGB", (20, 10)).save(buf, "JPEG")
    assert decode(normalize_image(to_data_url(buf.getvalue(), "image/jpeg"))).size == (20, 10)


def test_transparence_gardee():
    assert decode(normalize_image(png_bytes(10, 10, "RGBA"))).mode == "RGBA"


def test_pas_une_image():
    with pytest.raises(ValueError):
        normalize_image(b"bonjour")


def test_data_url_invalide():
    with pytest.raises(ValueError):
        normalize_image("data:image/png;base64,@@@pas-du-base64")
