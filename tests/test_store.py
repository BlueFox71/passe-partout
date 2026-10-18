import os

import pytest

from app.crypto import CryptoError
from app.model import Vault
from app.store import VaultCorrupt, VaultStore
from tests.conftest import sample_vault


def test_absent(tmp_path):
    assert VaultStore(tmp_path / "vault.json").exists() is False


def test_clair_aller_retour(tmp_path):
    s = VaultStore(tmp_path / "vault.json")
    v = sample_vault()
    s.save(v)
    assert VaultStore(tmp_path / "vault.json").load(None).to_dict() == v.to_dict()


def test_chiffre_illisible_sur_disque(tmp_path):
    s = VaultStore(tmp_path / "vault.json")
    s.save(sample_vault())
    s.set_lock("123456")
    raw = (tmp_path / "vault.json").read_bytes()
    assert raw.startswith(b"GMDP1") and b"Boursorama" not in raw
    s2 = VaultStore(tmp_path / "vault.json")
    assert s2.is_encrypted()
    assert s2.load("123456").accounts[0].name == "Boursorama"


def test_chiffre_sans_code_refuse(tmp_path):
    s = VaultStore(tmp_path / "vault.json")
    s.save(sample_vault())
    s.set_lock("123456")
    with pytest.raises(CryptoError):
        VaultStore(tmp_path / "vault.json").load(None)
    with pytest.raises(CryptoError):
        VaultStore(tmp_path / "vault.json").load("000000")


def test_save_apres_load_reste_chiffre(tmp_path):
    VaultStore(tmp_path / "vault.json").save(sample_vault())
    s = VaultStore(tmp_path / "vault.json")
    s.load(None)
    s.set_lock("c")
    s2 = VaultStore(tmp_path / "vault.json")
    v = s2.load("c")
    v.accounts.pop()
    s2.save(v)
    assert (tmp_path / "vault.json").read_bytes().startswith(b"GMDP1")
    assert len(VaultStore(tmp_path / "vault.json").load("c").accounts) == 1


def test_backups_max_5_et_chiffres(tmp_path):
    s = VaultStore(tmp_path / "vault.json")
    s.save(sample_vault())
    s.set_lock("c")
    for _ in range(8):
        s.save(sample_vault())
    bk = s.list_backups()
    assert len(bk) == 5
    assert all(b.read_bytes().startswith(b"GMDP1") for b in bk)


def test_coupure_pendant_save(tmp_path, monkeypatch):
    s = VaultStore(tmp_path / "vault.json")
    s.save(sample_vault())

    def coupure(*a):
        raise OSError("coupure")

    monkeypatch.setattr(os, "replace", coupure)
    with pytest.raises(OSError):
        s.save(Vault())
    monkeypatch.undo()
    assert len(VaultStore(tmp_path / "vault.json").load(None).accounts) == 2


def test_fichier_corrompu(tmp_path):
    (tmp_path / "vault.json").write_text("{pas du json")
    with pytest.raises(VaultCorrupt):
        VaultStore(tmp_path / "vault.json").load(None)


def test_fichier_chiffre_tronque(tmp_path):
    (tmp_path / "vault.json").write_bytes(b"GMDP1\x0e abc")
    with pytest.raises(VaultCorrupt):
        VaultStore(tmp_path / "vault.json").load("c")


def test_restore(tmp_path):
    s = VaultStore(tmp_path / "vault.json")
    a = sample_vault()
    s.save(a)
    b = sample_vault()
    b.accounts = []
    s.save(b)
    s.restore(s.list_backups()[0])
    assert VaultStore(tmp_path / "vault.json").load(None).to_dict() == a.to_dict()
    # l'état d'avant restauration est lui-même sauvegardé
    assert any(VaultStore(p).load(None).accounts == [] for p in s.list_backups())


def test_retirer_verrou(tmp_path):
    s = VaultStore(tmp_path / "vault.json")
    s.save(sample_vault())
    s.set_lock("c")
    s.save(sample_vault())  # crée une sauvegarde chiffrée
    s.set_lock(None)
    assert not (tmp_path / "vault.json").read_bytes().startswith(b"GMDP1")
    assert s.list_backups() and all(not b.read_bytes().startswith(b"GMDP1") for b in s.list_backups())


def test_changer_code_rechiffre_les_backups(tmp_path):
    s = VaultStore(tmp_path / "vault.json")
    s.save(sample_vault())
    s.set_lock("c")
    s.save(sample_vault())
    s.set_lock("d")
    for b in s.list_backups():
        assert len(VaultStore(b).load("d").accounts) == 2


def test_forget_key(tmp_path):
    s = VaultStore(tmp_path / "vault.json")
    s.save(sample_vault())
    s.set_lock("c")
    s.forget_key()
    with pytest.raises(PermissionError):
        s.save(sample_vault())


def test_reload_avec_cle_en_memoire(tmp_path):
    s = VaultStore(tmp_path / "vault.json")
    s.save(sample_vault())
    s.set_lock("c")
    v = s.vault
    v.accounts = []
    s.save(v)
    s.restore(s.list_backups()[0])
    assert len(s.reload().accounts) == 2


def test_reload_autre_cle_refuse(tmp_path):
    s = VaultStore(tmp_path / "vault.json")
    s.save(sample_vault())
    s.set_lock("c")
    s.save(sample_vault())
    s.set_lock("d")  # les sauvegardes sont re-chiffrées : on simule une sauvegarde d'un autre code
    other = VaultStore(tmp_path / "autre" / "vault.json")
    other.save(sample_vault())
    other.set_lock("zzz")
    (tmp_path / "vault.json").write_bytes((tmp_path / "autre" / "vault.json").read_bytes())
    with pytest.raises(CryptoError):
        s.reload()


def test_restaurations_repetees_gardent_la_derniere_version(tmp_path):
    s = VaultStore(tmp_path / "vault.json")
    for i in range(7):  # 7 versions différentes
        v = sample_vault()
        v.accounts[0].name = f"version{i}"
        s.save(v)
    for _ in range(6):  # restaurer sans cesse la plus ancienne sauvegarde
        s.restore(s.list_backups()[-1])
    fichiers = [*s.list_backups(), tmp_path / "vault.json"]
    noms = {VaultStore(b).load(None).accounts[0].name for b in fichiers}
    assert "version6" in noms  # la dernière version enregistrée n'a pas été perdue
    assert len(s.list_backups()) == 5
