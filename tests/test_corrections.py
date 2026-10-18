"""Corrections des points mineurs de la relecture finale."""
import io
import json

import pytest
from PIL import Image

from app import images
from app.api import Api
from app.exporter import export_png, export_text
from app.images import normalize_image
from app.model import Account
from app.store import VaultStore
from app.textutil import normalize, search
from tests.conftest import make_account, sample_vault
from tests.test_api import Clock, FakeClip, FakeDialogs


def make_api(tmp_path, clip=None, clock=None, dialogs=None):
    clock = clock or Clock()
    return Api(VaultStore(tmp_path / "vault.json"), clip or FakeClip(), clock=clock, wall_clock=clock,
               dialogs=dialogs or FakeDialogs(), schedule=lambda s, f: None)


# k. ligatures et catégories
def test_normalize_ligatures():
    assert normalize("Cœur") == "coeur" and normalize("Æsir") == "aesir"


def test_recherche_coeur():
    assert [a.name for a in search([make_account("Cœur de pirate")], "coeur")] == ["Cœur de pirate"]


def test_categorie_reutilise_le_libelle_existant(tmp_path):
    VaultStore(tmp_path / "vault.json").save(sample_vault())
    api = make_api(tmp_path)
    saved = api.save_account({"id": None, "name": "LCL", "category": "  banque ", "profiles": ["p1"]})
    assert saved["category"] == "Banque"


# a. import échoué : aucun reste
def test_import_echoue_ne_laisse_rien(tmp_path, monkeypatch):
    VaultStore(tmp_path / "vault.json").save(sample_vault())
    api = make_api(tmp_path)

    def boom(path, vault, pid):
        vault.accounts.append(make_account("Moitié"))
        raise RuntimeError("fichier abîmé")

    monkeypatch.setattr("app.api.import_xlsx", boom)
    with pytest.raises(ValueError):
        api.import_excel("x.xlsx", "Nouveau profil")
    assert [a["name"] for a in api.list_accounts(None)] == ["Boursorama", "Netflix"]
    assert [p["name"] for p in api.get_state()["profiles"]] == ["Jules", "Alexis"]


# b. changement de code : l'écriture du coffre passe avant celle des sauvegardes
def test_set_lock_echec_ecriture_garde_tout_coherent(tmp_path, monkeypatch):
    import os
    s = VaultStore(tmp_path / "vault.json")
    s.save(sample_vault())
    s.set_lock("ancien")
    s.save(sample_vault())  # une sauvegarde chiffrée avec « ancien »
    real_replace = os.replace

    def replace(src, dst):
        if str(dst).endswith("vault.json"):
            raise OSError("fichier verrouillé par l'antivirus")
        return real_replace(src, dst)

    monkeypatch.setattr(os, "replace", replace)
    with pytest.raises(OSError):
        s.set_lock("nouveau")
    monkeypatch.undo()
    assert len(VaultStore(tmp_path / "vault.json").load("ancien").accounts) == 2
    for b in s.list_backups():
        VaultStore(b).load("ancien")


# c. config.json perdu
def test_config_perdue_mode_inconnu(tmp_path):
    api = make_api(tmp_path)
    api.start_empty("Jules")
    api.set_lock("pin", "123456")
    (tmp_path / "config.json").unlink()
    assert make_api(tmp_path).get_state()["lock_mode"] == "unknown"


# d. presse-papiers occupé au moment de l'effacement
class BusyClip(FakeClip):
    busy = False

    def get(self):
        return None if self.busy else self.text


def test_effacement_reessaye_si_presse_papiers_occupe(tmp_path):
    VaultStore(tmp_path / "vault.json").save(sample_vault())
    clip, clock = BusyClip(), Clock()
    api = make_api(tmp_path, clip, clock)
    api.copy_secret("pw")
    clock.advance(30)
    clip.busy = True
    api.tick()
    assert clip.text == "pw"
    clip.busy = False
    clock.advance(1)
    api.tick()
    assert clip.text == ""


def test_geometrie_fenetre_enregistree(tmp_path):
    api = make_api(tmp_path)
    api.start_empty("Jules")
    api.save_window({"width": 1300, "height": 820, "x": 10, "y": 20})
    assert json.loads((tmp_path / "config.json").read_text(encoding="utf-8"))["window"]["width"] == 1300


# e. délai anti-essais conservé après redémarrage
def test_delai_conserve_apres_redemarrage(tmp_path):
    clock = Clock()
    api = make_api(tmp_path, clock=clock)
    api.start_empty("Jules")
    api.set_lock("pin", "123456")
    api.lock()
    for _ in range(4):
        r = api.unlock("000000")
        clock.advance(r["wait_seconds"])  # on attend juste la fin du délai avant de réessayer
    api.unlock("000000")  # 5e échec : 16 s d'attente
    relance = make_api(tmp_path, clock=clock)
    r = relance.unlock("123456")
    assert r["ok"] is False and r["wait_seconds"] > 0


# g. couleur de profil validée
def test_couleur_profil_invalide_remplacee(tmp_path):
    VaultStore(tmp_path / "vault.json").save(sample_vault())
    api = make_api(tmp_path)
    p = api.save_profile({"id": None, "name": "X", "color": '#fff" onmouseover="alert(1)'})
    assert p["color"].startswith("#") and len(p["color"]) == 7


# i. images : rotation EXIF, images démesurées
def test_rotation_exif():
    im = Image.new("RGB", (40, 20), (255, 0, 0))
    exif = im.getexif()
    exif[0x0112] = 6  # rotation 90°
    buf = io.BytesIO()
    im.save(buf, "JPEG", exif=exif)
    import base64
    out = Image.open(io.BytesIO(base64.b64decode(normalize_image(buf.getvalue()).split(",", 1)[1])))
    assert out.size == (20, 40)


def test_image_demesuree_refusee(monkeypatch):
    monkeypatch.setattr(images, "MAX_PIXELS", 1000)
    buf = io.BytesIO()
    Image.new("RGB", (100, 100)).save(buf, "PNG")
    with pytest.raises(ValueError, match="trop grande"):
        normalize_image(buf.getvalue())


# j. exports successifs sans écrasement
def test_exports_successifs_sans_ecrasement(tmp_path):
    accs = [Account(id="a", name="A", category="Jeu", login="x", password="y")]
    t1, t2 = export_text(accs, [], tmp_path), export_text(accs, [], tmp_path)
    p1, p2 = export_png(accs, [], tmp_path), export_png(accs, [], tmp_path)
    assert t1 != t2 and t1.exists() and t2.exists()
    assert set(p1).isdisjoint(p2) and all(p.exists() for p in p1 + p2)


# l. ouvrir le dossier des sauvegardes
def test_ouvrir_dossier_sauvegardes(tmp_path, monkeypatch):
    VaultStore(tmp_path / "vault.json").save(sample_vault())
    api = make_api(tmp_path)
    opened = []
    monkeypatch.setattr("app.api._open_folder", lambda p: opened.append(p))
    api.open_backups_folder()
    assert opened and opened[0].endswith("backups")


# logos posés en masse : un seul enregistrement, sans écraser une image existante
def test_set_images_en_un_enregistrement(tmp_path):
    VaultStore(tmp_path / "vault.json").save(sample_vault())
    api = make_api(tmp_path)
    accs = api.list_accounts(None)
    api.save_account({**accs[0], "image": "data:image/png;base64,AAAA"})
    backups_avant = len(VaultStore(tmp_path / "vault.json").list_backups())
    n = api.set_images({a["id"]: "data:image/png;base64,BBBB" for a in accs}, {"g1": "data:image/png;base64,CCCC"})
    assert n == 2  # 1 compte sans image + 1 carte
    imgs = {a["name"]: a["image"] for a in api.list_accounts(None)}
    assert imgs[accs[0]["name"]].endswith("AAAA") and imgs[accs[1]["name"]].endswith("BBBB")
    assert api.list_giftcards(None)[0]["image"].endswith("CCCC")
    assert len(VaultStore(tmp_path / "vault.json").list_backups()) == backups_avant + 1


def test_set_images_refuse_autre_chose_qu_une_image(tmp_path):
    VaultStore(tmp_path / "vault.json").save(sample_vault())
    api = make_api(tmp_path)
    a = api.list_accounts(None)[1]
    assert api.set_images({a["id"]: "javascript:alert(1)"}, {}) == 0


# validation automatique du PIN : longueur connue
def test_longueur_pin_retenue(tmp_path):
    api = make_api(tmp_path)
    api.start_empty("Jules")
    api.set_lock("pin", "246810")
    assert make_api(tmp_path).get_state()["pin_length"] == 6


def test_longueur_pin_apprise_au_deverrouillage(tmp_path):
    api = make_api(tmp_path)
    api.start_empty("Jules")
    api.set_lock("pin", "1357")
    cfg = json.loads((tmp_path / "config.json").read_text(encoding="utf-8"))
    cfg.pop("pin_length")  # coffre créé avant la fonctionnalité
    (tmp_path / "config.json").write_text(json.dumps(cfg), encoding="utf-8")
    relance = make_api(tmp_path)
    assert relance.get_state()["pin_length"] is None
    assert relance.unlock("1357")["ok"] is True
    assert make_api(tmp_path).get_state()["pin_length"] == 4


def test_pas_de_longueur_pour_un_mot_de_passe(tmp_path):
    api = make_api(tmp_path)
    api.start_empty("Jules")
    api.set_lock("pin", "1357")
    api.set_lock("password", "motdepasse")
    assert make_api(tmp_path).get_state()["pin_length"] is None


def test_vue_liste_ou_grille_enregistree(tmp_path):
    VaultStore(tmp_path / "vault.json").save(sample_vault())
    api = make_api(tmp_path)
    assert api.get_settings()["view"] == "list"
    assert api.save_settings({"view": "grid"})["view"] == "grid"
    assert make_api(tmp_path).get_settings()["view"] == "grid"
    assert api.save_settings({"view": "n'importe quoi"})["view"] == "grid"
