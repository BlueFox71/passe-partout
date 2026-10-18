"""Génère ui/assets/icon.ico (clé blanche, contour néon rose→violet) — rendu Pillow de ui/assets/icon.svg."""
from PIL import Image, ImageChops, ImageDraw, ImageFilter

S = 1024  # travail en haute définition puis réduction
k = S / 64


def key_layer():
    im = Image.new("L", (S, S), 0)
    d = ImageDraw.Draw(im)
    R = lambda *v: [x * k for x in v]  # noqa: E731
    d.ellipse(R(7, 21, 29, 43), fill=255)
    d.ellipse(R(14, 28, 22, 36), fill=0)
    d.rounded_rectangle(R(27.5, 29, 52.5, 35), radius=2 * k, fill=255)
    d.rounded_rectangle(R(41, 33.5, 45.5, 41.5), radius=1.4 * k, fill=255)
    d.rounded_rectangle(R(47.5, 33.5, 52, 39), radius=1.4 * k, fill=255)
    return im.rotate(-45, resample=Image.BICUBIC, center=(S / 2, S / 2))


def gradient():
    g = Image.new("RGB", (64, 64))
    a, b = (0xFF, 0x3D, 0x9A), (0x7C, 0x3A, 0xED)
    g.putdata([tuple(int(a[i] + (b[i] - a[i]) * (x + y) / 126) for i in range(3)) for y in range(64) for x in range(64)])
    return g.resize((S, S), Image.BICUBIC)


def main():
    base = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    box = [5 * k, 5 * k, 59 * k, 59 * k]
    fill = Image.new("L", (S, S), 0)
    ImageDraw.Draw(fill).rounded_rectangle(box, radius=15 * k, fill=255)
    base.paste((0x14, 0x0A, 0x26, 255), (0, 0), fill)
    ring = Image.new("L", (S, S), 0)
    ImageDraw.Draw(ring).rounded_rectangle(box, radius=15 * k, outline=255, width=int(3.5 * k))
    glow = ring.filter(ImageFilter.GaussianBlur(2 * k))
    grad = gradient()
    base = Image.alpha_composite(base, Image.merge("RGBA", (*grad.split(), glow)))
    base = Image.alpha_composite(base, Image.merge("RGBA", (*grad.split(), ring)))
    key = key_layer()
    halo = key.filter(ImageFilter.GaussianBlur(1.2 * k)).point(lambda v: int(v * 0.7))
    base = Image.alpha_composite(base, Image.merge("RGBA", (*Image.new("RGB", (S, S), (0xFF, 0x8F, 0xCA)).split(), halo)))
    base = Image.alpha_composite(base, Image.merge("RGBA", (*Image.new("RGB", (S, S), (255, 255, 255)).split(), key)))
    base.save("ui/assets/icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    base.resize((256, 256), Image.LANCZOS).save("ui/assets/icon.png")


if __name__ == "__main__":
    main()
