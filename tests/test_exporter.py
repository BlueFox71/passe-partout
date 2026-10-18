from datetime import date

from PIL import Image

from app.exporter import export_png, export_text
from app.model import Account, GiftCard


def acc(name, category, login, password="pw", mask=None):
    return Account(id=name, name=name, category=category, login=login, password=password, login_mask=mask)


def gc(name, code="", pin="", remaining=0.0, end=None):
    return GiftCard(id=name, name=name, code=code, pin=pin, remaining=remaining, end_date=end)


def test_export_texte(tmp_path):
    p = export_text([acc("Impots", "Etat", "1234567890123", mask="## ## ### ### ###")],
                    [gc("Fnac", code="X1", pin="12", remaining=20, end="2027-01-31")], tmp_path)
    t = p.read_text(encoding="utf-8-sig")
    assert p.name == f"mots-de-passe-{date.today().isoformat()}.txt"
    assert "== Etat ==" in t and "Impots" in t and "12 34 567 890 123" in t and "Mot de passe : pw" in t
    assert "== Cartes cadeaux ==" in t and "Fnac" in t and "20,00 €" in t and "31/01/2027" in t


def test_export_texte_trie(tmp_path):
    t = export_text([acc("Zeta", "B", "z"), acc("alpha", "B", "a"), acc("Mid", "A", "m")], [], tmp_path).read_text(encoding="utf-8-sig")
    assert t.index("== A ==") < t.index("== B ==") and t.index("alpha") < t.index("Zeta")


def test_export_png_decoupage(tmp_path):
    files = export_png([acc(f"C{i}", "Jeu", "x") for i in range(13)] + [acc("B", "Banque", "y")], [], tmp_path)
    assert sorted(f.name for f in files) == ["Banque-1.png", "Jeu-1.png", "Jeu-2.png"]
    assert all(Image.open(f).width == 1080 for f in files)


def test_export_png_nom_assaini_et_cartes(tmp_path):
    files = export_png([acc("A", 'Site/Web:"x"', "y")], [gc("Fnac", code="1", remaining=5)], tmp_path)
    assert sorted(f.name for f in files) == ["Cartes cadeaux-1.png", "SiteWebx-1.png"]
