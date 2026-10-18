import pytest

from app.importer import import_xlsx
from app.model import Profile, Vault
from tests.fixtures.make_xlsx import ROWS, make_xlsx


@pytest.fixture
def xlsx(tmp_path):
    return make_xlsx(tmp_path / "mdps.xlsx")


@pytest.fixture
def vault():
    return Vault(profiles=[Profile(id="p1", name="Jules")])


def by_name(vault, name):
    return next(a for a in vault.accounts if a.name == name)


def test_import_basique(xlsx, vault):
    added, skipped = import_xlsx(xlsx, vault, "p1")
    assert (added, skipped) == (len(ROWS) + 1, 0)  # + 1 carte cadeau
    a = by_name(vault, "Boursorama")
    assert a.category == "Banque" and a.login == "jules.x" and a.profiles == ["p1"]


def test_cellules_numeriques_en_texte(xlsx, vault):
    import_xlsx(xlsx, vault, "p1")
    assert by_name(vault, "Code CB").password == "29017110"
    assert by_name(vault, "Zero").password == "06092597"
    assert by_name(vault, "Flottant").password == "133511"
    assert by_name(vault, "Format").password == "06092597"  # nombre au format 00000000
    assert by_name(vault, "Date").password == "04/03/2021"


def test_fusion_categories(xlsx, vault):
    import_xlsx(xlsx, vault, "p1")
    cats = {a.category for a in vault.accounts}
    assert {"Réseau social", "Plateforme de jeu"} <= cats
    assert "Réseau Social" not in cats and "Plateforme  de jeu" not in cats


def test_mailto_texte_affiche(xlsx, vault):
    import_xlsx(xlsx, vault, "p1")
    assert by_name(vault, "Facebook").login == "alexis@exemple.fr"


def test_image_ancre_unique(xlsx, vault):
    import_xlsx(xlsx, vault, "p1")
    assert by_name(vault, "Boursorama").image.startswith("data:image/png")
    assert by_name(vault, "Ligne5").image is None
    assert by_name(vault, "Code CB").image is None


def test_cartes_cadeaux(xlsx, vault):
    import_xlsx(xlsx, vault, "p1")
    g = vault.giftcards[0]
    assert (g.name, g.code, g.pin, g.remaining, g.end_date, g.profiles) == ("Fnac", "ABC123", "4321", 25.5, "2027-01-31", ["p1"])


def test_reimport_n_ajoute_que_les_absents(xlsx, vault):
    import_xlsx(xlsx, vault, "p1")
    by_name(vault, "Boursorama").password = "change"
    added, skipped = import_xlsx(xlsx, vault, "p1")
    assert by_name(vault, "Boursorama").password == "change"
    assert (added, skipped) == (1, len(ROWS))
