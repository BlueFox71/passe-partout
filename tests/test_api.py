import json

import pytest

from app.store import VaultStore
from tests.conftest import Clock, FakeClip, FakeDialogs, make_api, sample_vault  # noqa: F401 (réexportés)
from tests.fixtures.make_xlsx import make_xlsx


def acc_dict(**kw):
    d = {"id": None, "name": "Steam", "category": "Jeu", "login": "jg", "password": "pw",
         "login_mask": None, "password_mask": None, "image": None, "favorite": False, "profiles": ["p1"]}
    d.update(kw)
    return d


# ---------- état et verrou ----------
def test_premier_lancement(tmp_path, fake_clip, clock, dialogs):
    api = make_api(tmp_path, fake_clip, clock, dialogs)
    s = api.get_state()
    assert s["has_data"] is False and s["locked"] is False and s["lock_mode"] == "none"
    api.start_empty("Jules")
    s = api.get_state()
    assert s["has_data"] is True and [p["name"] for p in s["profiles"]] == ["Jules"]


def test_relance_verrouillee(api_locked):
    s = api_locked.get_state()
    assert s["locked"] is True and s["lock_mode"] == "pin"
    with pytest.raises(PermissionError):
        api_locked.list_accounts(None)


def test_unlock_mauvais_code_delai(api_locked, clock):
    r = api_locked.unlock("000000")
    assert r == {"ok": False, "wait_seconds": 1, "error": "bad_code"}
    r = api_locked.unlock("123456")  # encore dans le délai : refusé même avec le bon code
    assert r["ok"] is False and r["wait_seconds"] >= 1
    clock.advance(2)
    assert api_locked.unlock("123456")["ok"] is True
    assert api_locked.get_state()["locked"] is False


def test_lock_efface_donnees(api_locked, clock):
    api_locked.unlock("123456")
    api_locked.lock()
    assert api_locked.get_state()["locked"] is True
    with pytest.raises(PermissionError):
        api_locked.list_accounts(None)


def test_lock_sans_verrou_sans_effet(api_unlocked):
    api_unlocked.lock()
    assert api_unlocked.get_state()["locked"] is False


def test_fichier_corrompu(tmp_path, fake_clip, clock, dialogs):
    (tmp_path / "vault.json").write_text("{abîmé", encoding="utf-8")
    api = make_api(tmp_path, fake_clip, clock, dialogs)
    assert api.get_state()["corrupt"] is True


def test_restore_backup_quand_corrompu(tmp_path, fake_clip, clock, dialogs):
    s = VaultStore(tmp_path / "vault.json")
    s.save(sample_vault())
    s.save(sample_vault())
    (tmp_path / "vault.json").write_text("{abîmé", encoding="utf-8")
    api = make_api(tmp_path, fake_clip, clock, dialogs)
    name = api.list_backups()[0]["name"]
    api.restore_backup(name)
    st = api.get_state()
    assert st["corrupt"] is False and st["locked"] is False
    assert len(api.list_accounts(None)) == 2


def test_set_lock_puis_retrait(api_unlocked, tmp_path):
    api_unlocked.set_lock("password", "motdepasse")
    assert (tmp_path / "vault.json").read_bytes().startswith(b"GMDP1")
    assert api_unlocked.get_state()["lock_mode"] == "password"
    api_unlocked.set_lock("none", None)
    assert api_unlocked.get_state()["lock_mode"] == "none"
    assert json.loads((tmp_path / "vault.json").read_text(encoding="utf-8"))["accounts"]


# ---------- presse-papiers ----------
def test_copy_secret_efface_30s(api_unlocked, fake_clip, clock):
    api_unlocked.copy_secret("pw")
    assert fake_clip.text == "pw"
    clock.advance(29)
    api_unlocked.tick()
    assert fake_clip.text == "pw"
    clock.advance(1)
    api_unlocked.tick()
    assert fake_clip.text == ""


def test_copy_secret_n_efface_pas_autre_chose(api_unlocked, fake_clip, clock):
    api_unlocked.copy_secret("pw")
    fake_clip.text = "autre"
    clock.advance(30)
    api_unlocked.tick()
    assert fake_clip.text == "autre"


def test_copy_plain_reste(api_unlocked, fake_clip, clock):
    api_unlocked.copy_plain("1234567890123")
    clock.advance(60)
    api_unlocked.tick()
    assert fake_clip.text == "1234567890123"


def test_lock_vide_le_secret_copie(api_locked, fake_clip, clock):
    api_locked.unlock("123456")
    api_locked.copy_secret("pw")
    api_locked.lock()
    assert fake_clip.text == ""


# ---------- comptes ----------
def test_favoris_en_tete(api_unlocked):
    a = api_unlocked.list_accounts(None)
    api_unlocked.save_account({**a[1], "favorite": True})
    assert api_unlocked.list_accounts(None)[0]["name"] == a[1]["name"]


def test_filtre_profil(api_unlocked):
    assert [a["name"] for a in api_unlocked.list_accounts("p2")] == ["Netflix"]
    assert len(api_unlocked.list_accounts(None)) == 2


def test_save_account_nouveau(api_unlocked, tmp_path):
    saved = api_unlocked.save_account(acc_dict())
    assert saved["id"] and saved["created"]
    reloaded = VaultStore(tmp_path / "vault.json").load(None)
    assert any(a.name == "Steam" for a in reloaded.accounts)


def test_save_account_exige_un_profil(api_unlocked):
    with pytest.raises(ValueError):
        api_unlocked.save_account(acc_dict(profiles=[]))


def test_save_account_exige_un_nom(api_unlocked):
    with pytest.raises(ValueError):
        api_unlocked.save_account(acc_dict(name="  "))


def test_delete_account(api_unlocked):
    a = api_unlocked.list_accounts(None)[0]
    api_unlocked.delete_account(a["id"])
    assert a["id"] not in [x["id"] for x in api_unlocked.list_accounts(None)]


def test_bulk_update(api_unlocked):
    ids = [a["id"] for a in api_unlocked.list_accounts(None)]
    api_unlocked.bulk_update(ids, {"category": "Divers", "add_profiles": ["p2"], "remove_profiles": ["p1"]})
    for a in api_unlocked.list_accounts(None):
        assert a["category"] == "Divers" and a["profiles"] == ["p2"]


def test_bulk_retrait_garde_un_profil(api_unlocked):
    ids = [a["id"] for a in api_unlocked.list_accounts(None)]
    api_unlocked.bulk_update(ids, {"remove_profiles": ["p1", "p2"]})
    assert all(a["profiles"] for a in api_unlocked.list_accounts(None))


# ---------- profils ----------
def test_profil_supprime_reassigne(api_unlocked):
    api_unlocked.bulk_update([a["id"] for a in api_unlocked.list_accounts("p2")], {"remove_profiles": ["p1"]})
    api_unlocked.delete_profile("p2", "p1")
    assert len(api_unlocked.list_accounts(None)) == 2
    assert all(a["profiles"] == ["p1"] for a in api_unlocked.list_accounts(None))
    assert [p["id"] for p in api_unlocked.get_state()["profiles"]] == ["p1"]


def test_dernier_profil_non_supprimable(api_unlocked):
    api_unlocked.delete_profile("p2", "p1")
    with pytest.raises(ValueError):
        api_unlocked.delete_profile("p1", "p1")


# ---------- cartes cadeaux ----------
def test_spend(api_unlocked):
    g = api_unlocked.spend("g1", 12.5)
    assert g["remaining"] == 37.5 and len(g["history"]) == 1
    with pytest.raises(ValueError):
        api_unlocked.spend("g1", 1000)


def test_save_giftcard(api_unlocked):
    g = api_unlocked.save_giftcard({"id": None, "name": "Decathlon", "code": "X", "pin": "", "initial": 80,
                                    "remaining": 80, "end_date": None, "image": None, "profiles": ["p1"], "history": []})
    assert any(x["id"] == g["id"] for x in api_unlocked.list_giftcards("p1"))


# ---------- import / export ----------
def test_import_premier_lancement(tmp_path, fake_clip, clock, dialogs):
    dialogs.file = str(make_xlsx(tmp_path / "mdps.xlsx"))
    api = make_api(tmp_path, fake_clip, clock, dialogs)
    r = api.import_excel(None, "Jules")
    assert r["added"] > 0 and api.get_state()["has_data"] is True


def test_import_annule(tmp_path, fake_clip, clock, dialogs):
    api = make_api(tmp_path, fake_clip, clock, dialogs)
    assert api.import_excel(None, "Jules") is None
    assert api.get_state()["has_data"] is False


def test_export_txt(api_unlocked, dialogs, tmp_path):
    out = tmp_path / "export"
    out.mkdir()
    dialogs.folder = str(out)
    ids = [a["id"] for a in api_unlocked.list_accounts("p2")]
    r = api_unlocked.export("txt", ids, ["g1"])
    text = (out / r["files"][0].split("\\")[-1].split("/")[-1]).read_text(encoding="utf-8-sig")
    assert "Netflix" in text and "Boursorama" not in text and "Fnac" in text


def test_export_annule(api_unlocked):
    assert api_unlocked.export("png", [], []) is None


def test_normalize_image_refuse_texte(api_unlocked):
    with pytest.raises(ValueError):
        api_unlocked.normalize_image("data:text/plain;base64,Ym9uam91cg==")


class BlockingCheckDialogs(FakeDialogs):
    """Pendant que la « boîte de dialogue » est ouverte, un autre thread appelle l'API."""

    def __init__(self):
        super().__init__()
        self.api = None
        self.other_thread_ok = None

    def _probe(self):
        import threading
        done = threading.Event()
        threading.Thread(target=lambda: (self.api.get_state(), self.api.tick(), done.set()), daemon=True).start()
        self.other_thread_ok = done.wait(1.0)

    def open_file(self, kind):
        self._probe()
        return None

    def pick_folder(self):
        self._probe()
        return None


@pytest.mark.parametrize("call", ["pick_image", "import_excel", "export"])
def test_dialogue_ne_bloque_pas_l_api(tmp_path, fake_clip, clock, call):
    VaultStore(tmp_path / "vault.json").save(sample_vault())
    dlg = BlockingCheckDialogs()
    api = make_api(tmp_path, fake_clip, clock, dlg)
    dlg.api = api
    {"pick_image": lambda: api.pick_image(),
     "import_excel": lambda: api.import_excel(None, "Jules"),
     "export": lambda: api.export("txt", [], [])}[call]()
    assert dlg.other_thread_ok is True


def test_apercu_reimport_sans_modifier(api_unlocked, dialogs, tmp_path):
    dialogs.file = str(make_xlsx(tmp_path / "mdps.xlsx"))
    avant = (tmp_path / "vault.json").read_bytes()
    n = len(api_unlocked.list_accounts(None))
    r = api_unlocked.preview_import(None)
    assert r["path"] == dialogs.file and r["added"] > 0 and r["skipped"] == 0
    assert len(api_unlocked.list_accounts(None)) == n
    assert (tmp_path / "vault.json").read_bytes() == avant
    assert api_unlocked.import_excel(r["path"], "Jules")["added"] == r["added"]


def test_apercu_annule(api_unlocked):
    assert api_unlocked.preview_import(None) is None
