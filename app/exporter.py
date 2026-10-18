"""Exports pour consultation sur téléphone : fichier texte et images PNG au style néon."""
from __future__ import annotations

import base64
import io
import re
from datetime import date
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

from app.model import Account, GiftCard
from app.textutil import apply_mask, normalize

PER_IMAGE = 12
WIDTH = 1080
PALETTE = ["#ff3d9a", "#7c3aed", "#00b8d9", "#f97316", "#22c55e", "#e11d48", "#6366f1", "#14b8a6", "#eab308", "#a855f7"]
FONT_DIR = Path("C:/Windows/Fonts")


def money(v: float) -> str:
    return f"{v:,.2f}".replace(",", " ").replace(".", ",") + " €"


def date_fr(iso: str | None) -> str:
    return "/".join(reversed(iso.split("-"))) if iso else ""


def unique_path(path: Path) -> Path:
    """Ajoute « (2) », « (3) »… si le fichier existe déjà : un export n'écrase jamais le précédent."""
    if not path.exists():
        return path
    n = 2
    while (candidate := path.with_name(f"{path.stem} ({n}){path.suffix}")).exists():
        n += 1
    return candidate


def _by_category(accounts: list[Account]) -> list[tuple[str, list[Account]]]:
    groups: dict[str, list[Account]] = {}
    for a in accounts:
        groups.setdefault(a.category or "Sans catégorie", []).append(a)
    return [(c, sorted(groups[c], key=lambda a: normalize(a.name)))
            for c in sorted(groups, key=normalize)]


# ---------------------------------------------------------------- texte
def export_text(accounts: list[Account], giftcards: list[GiftCard], out_dir: Path) -> Path:
    lines = [f"PASSE-PARTOUT — export du {date.today().strftime('%d/%m/%Y')}",
             "Attention : ce fichier n'est pas protégé.", ""]
    for cat, items in _by_category(accounts):
        lines += [f"== {cat} ==", ""]
        for a in items:
            lines.append(a.name)
            lines.append(f"  Identifiant : {apply_mask(a.login, a.login_mask)}")
            lines.append(f"  Mot de passe : {apply_mask(a.password, a.password_mask)}")
            lines.append("")
    if giftcards:
        lines += ["== Cartes cadeaux ==", ""]
        for g in sorted(giftcards, key=lambda g: normalize(g.name)):
            lines.append(f"{g.name} — {money(g.remaining)}")
            lines.append(f"  Code : {g.code}")
            if g.pin:
                lines.append(f"  PIN : {g.pin}")
            if g.end_date:
                lines.append(f"  Date de fin : {date_fr(g.end_date)}")
            lines.append("")
    out = unique_path(Path(out_dir) / f"mots-de-passe-{date.today().isoformat()}.txt")
    out.write_text("\n".join(lines), encoding="utf-8-sig")
    return out


# ---------------------------------------------------------------- images
def _font(name: str, size: int):
    try:
        return ImageFont.truetype(str(FONT_DIR / name), size)
    except OSError:
        return ImageFont.load_default(size)


def _hex(c: str) -> tuple[int, int, int]:
    return tuple(int(c[i:i + 2], 16) for i in (1, 3, 5))


def _color_for(name: str) -> str:
    h = 0
    for ch in normalize(name):
        h = (h * 31 + ord(ch)) & 0xFFFFFFFF
    return PALETTE[h % len(PALETTE)]


def _wrap(draw, text: str, font, max_w: int) -> list[str]:
    """Coupe au caractère près : un secret n'est jamais tronqué."""
    lines, cur = [], ""
    for ch in text:
        if draw.textlength(cur + ch, font=font) > max_w and cur:
            lines.append(cur)
            cur = ch
        else:
            cur += ch
    return lines + [cur] if cur or not lines else lines


def _safe_name(s: str) -> str:
    s = re.sub(r'[\\/:*?"<>|]', "", s).strip().rstrip(".")
    return s or "Sans nom"


def _background(h: int) -> Image.Image:
    top, bottom = _hex("#3b0f5c"), _hex("#0b0716")
    grad = Image.new("RGB", (1, 256))
    for y in range(256):
        t = min(1.0, y / 255 * 1.6)
        grad.putpixel((0, y), tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)))
    bg = grad.resize((WIDTH, h)).convert("RGBA")
    glow = Image.new("RGBA", (WIDTH, h), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse((WIDTH - 520, -320, WIDTH + 260, 380), fill=(255, 61, 154, 70))
    return Image.alpha_composite(bg, glow.filter(ImageFilter.GaussianBlur(120)))


def _logo(name: str, image: str | None, size: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=size // 4, fill=255)
    tile = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    if image:
        try:
            im = Image.open(io.BytesIO(base64.b64decode(image.split(",", 1)[1]))).convert("RGBA")
            im.thumbnail((size - 10, size - 10))
            base = Image.new("RGBA", (size, size), (255, 255, 255, 240))
            base.alpha_composite(im, ((size - im.width) // 2, (size - im.height) // 2))
            tile.paste(base, (0, 0), mask)
            return tile
        except Exception:
            pass
    c = _hex(_color_for(name))
    base = Image.new("RGBA", (size, size), c + (255,))
    shade = Image.new("RGBA", (size, size), tuple(int(v * 0.55) for v in c) + (255,))
    diag = Image.new("L", (64, 64))
    diag.putdata([int((x + y) / 126 * 255) for y in range(64) for x in range(64)])
    diag = diag.resize((size, size))
    base = Image.composite(shade, base, diag)
    d = ImageDraw.Draw(base)
    f = _font("segoeuib.ttf", int(size * 0.5))
    letter = (name.strip()[:1] or "?").upper()
    d.text((size / 2, size / 2), letter, font=f, fill="white", anchor="mm")
    tile.paste(base, (0, 0), mask)
    return tile


def _render_page(title: str, subtitle: str, cards: list[tuple[str, str | None, list[tuple[str, str]]]], path: Path):
    """cards : (nom, image, [(libellé, valeur), …])."""
    f_title = _font("segoeuib.ttf", 64)
    f_sub = _font("segoeui.ttf", 30)
    f_name = _font("segoeuib.ttf", 40)
    f_label = _font("segoeuib.ttf", 22)
    f_val = _font("consola.ttf", 34)
    pad, logo = 48, 96
    text_x = pad + 36 + logo + 30
    max_w = WIDTH - text_x - pad - 36

    probe = ImageDraw.Draw(Image.new("RGB", (1, 1)))
    layouts, total = [], 260
    for name, image, fields in cards:
        rows = [(lab, _wrap(probe, val or "—", f_val, max_w)) for lab, val in fields]
        h = 36 + 52 + sum(32 + 44 * len(ls) + 10 for _, ls in rows) + 26
        h = max(h, logo + 72)
        layouts.append((name, image, rows, h))
        total += h + 24
    total += 90

    img = _background(total)
    glow = Image.new("RGBA", img.size, (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    d = ImageDraw.Draw(img)
    d.text((pad, 70), "PASSE-PARTOUT", font=_font("segoeuib.ttf", 28), fill=(255, 195, 225))
    gd.text((pad, 110), title, font=f_title, fill=(255, 61, 154, 200))
    y = 260
    for name, image, rows, h in layouts:
        box = (pad, y, WIDTH - pad, y + h)
        gd.rounded_rectangle(box, radius=34, outline=(255, 61, 154, 90), width=6)
        y += h + 24
    img = Image.alpha_composite(img, glow.filter(ImageFilter.GaussianBlur(14)))
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    ld = ImageDraw.Draw(layer)
    y = 260
    for name, image, rows, h in layouts:
        ld.rounded_rectangle((pad, y, WIDTH - pad, y + h), radius=34, fill=(255, 255, 255, 18), outline=(255, 255, 255, 45), width=2)
        y += h + 24
    img = Image.alpha_composite(img, layer)
    d = ImageDraw.Draw(img)
    d.text((pad, 110), title, font=f_title, fill="white")
    d.text((pad, 192), subtitle, font=f_sub, fill=(185, 166, 217))
    y = 260
    for name, image, rows, h in layouts:
        img.alpha_composite(_logo(name, image, logo), (pad + 36, y + 36))
        d.text((text_x, y + 30), name, font=f_name, fill="white")
        ty = y + 36 + 52
        for lab, ls in rows:
            d.text((text_x, ty), lab.upper(), font=f_label, fill=(138, 119, 173))
            ty += 32
            for line in ls:
                d.text((text_x, ty), line, font=f_val, fill=(230, 253, 255))
                ty += 44
            ty += 10
        y += h + 24
    d.text((WIDTH / 2, total - 50), "Fichier non protégé — à garder en lieu sûr", font=_font("segoeui.ttf", 24),
           fill=(138, 119, 173), anchor="mm")
    img.convert("RGB").save(path, "PNG", optimize=True)


def export_png(accounts: list[Account], giftcards: list[GiftCard], out_dir: Path) -> list[Path]:
    out_dir = Path(out_dir)
    today = date.today().strftime("%d/%m/%Y")
    pages: list[tuple[str, list]] = []
    for cat, items in _by_category(accounts):
        cards = [(a.name, a.image, [("Identifiant", apply_mask(a.login, a.login_mask)),
                                    ("Mot de passe", apply_mask(a.password, a.password_mask))]) for a in items]
        pages.append((cat, cards))
    if giftcards:
        cards = []
        for g in sorted(giftcards, key=lambda g: normalize(g.name)):
            fields = [("Solde", money(g.remaining)), ("Code", g.code)]
            if g.pin:
                fields.append(("PIN", g.pin))
            if g.end_date:
                fields.append(("Date de fin", date_fr(g.end_date)))
            cards.append((g.name, g.image, fields))
        pages.append(("Cartes cadeaux", cards))

    files = []
    for title, cards in pages:
        chunks = [cards[i:i + PER_IMAGE] for i in range(0, len(cards), PER_IMAGE)]
        for n, chunk in enumerate(chunks, start=1):
            sub = f"{len(cards)} élément{'s' if len(cards) > 1 else ''} · {today}"
            if len(chunks) > 1:
                sub += f" · page {n}/{len(chunks)}"
            path = unique_path(out_dir / f"{_safe_name(title)}-{n}.png")
            _render_page(title, sub, chunk, path)
            files.append(path)
    return files
