import hashlib
import os

from app import apk
from app.apk import apk_info, find_apk
from app.version import VERSION


def test_find_apk_absent_returns_none(tmp_path, monkeypatch):
    monkeypatch.setattr(apk, "REPO_ROOT", tmp_path)
    assert find_apk() is None


def test_find_apk_depot(tmp_path, monkeypatch):
    f = tmp_path / "mobile" / "dist" / "passe-partout.apk"
    f.parent.mkdir(parents=True)
    f.write_bytes(b"PK")
    monkeypatch.setattr(apk, "REPO_ROOT", tmp_path)
    assert find_apk() == f


def test_find_apk_override(tmp_path, monkeypatch):
    f = tmp_path / "faux.apk"
    f.write_bytes(b"PK")
    monkeypatch.setattr(apk, "APK_OVERRIDE", f)
    assert find_apk() == f


def test_find_apk_exe_gele(tmp_path, monkeypatch):
    f = tmp_path / "apk" / "passe-partout.apk"
    f.parent.mkdir()
    f.write_bytes(b"PK")
    monkeypatch.setattr(apk.sys, "frozen", True, raising=False)
    monkeypatch.setattr(apk.sys, "_MEIPASS", str(tmp_path), raising=False)
    assert find_apk() == f


def test_apk_info_size_and_sha(tmp_path):
    contenu = os.urandom(70_000)
    f = tmp_path / "passe-partout.apk"
    f.write_bytes(contenu)
    info = apk_info(f)
    assert info == {
        "version": VERSION,
        "size": len(contenu),
        "sha256": hashlib.sha256(contenu).hexdigest(),
        "filename": f"passe-partout-{VERSION}.apk",
    }


def test_apk_info_none(tmp_path):
    assert apk_info(None) is None
    assert apk_info(tmp_path / "absent.apk") is None


def test_apk_info_cache_suit_le_fichier(tmp_path, monkeypatch):
    f = tmp_path / "a.apk"
    f.write_bytes(b"un")
    appels = []
    vrai = apk._sha256_file
    monkeypatch.setattr(apk, "_sha256_file", lambda p: appels.append(p) or vrai(p))
    apk_info(f)
    apk_info(f)
    assert len(appels) == 1  # calculé une seule fois
    f.write_bytes(b"deux!")
    assert apk_info(f)["sha256"] == hashlib.sha256(b"deux!").hexdigest()
    assert len(appels) == 2
