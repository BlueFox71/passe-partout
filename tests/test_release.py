import io
import json
import urllib.error
import urllib.request

import pytest

from tools import release
from tools.release import publish, read_notes, sensitive_tracked


def _notes(tmp_path, text):
    p = tmp_path / "RELEASE_NOTES.md"
    p.write_text(text, encoding="utf-8")
    return p


def test_notes_ok_marker_removed(tmp_path):
    p = _notes(tmp_path, "<!-- version: 1.0.0 -->\n### Nouveautés\n- Truc\n")
    assert read_notes(p, "1.0.0") == "### Nouveautés\n- Truc"


def test_notes_marker_mismatch_refused(tmp_path):
    p = _notes(tmp_path, "<!-- version: 0.9.0 -->\n### Nouveautés\n- Truc\n")
    with pytest.raises(ValueError, match="rapport de la 0.9.0, pas de la 1.0.0"):
        read_notes(p, "1.0.0")


def test_notes_marker_removed(tmp_path):
    p = _notes(tmp_path, "### Nouveautés\n- Truc\n")
    with pytest.raises(ValueError):
        read_notes(p, "1.0.0")


def test_notes_empty_or_missing(tmp_path):
    with pytest.raises(ValueError):
        read_notes(_notes(tmp_path, "<!-- version: 1.0.0 -->\n  \n"), "1.0.0")
    with pytest.raises(ValueError):
        read_notes(tmp_path / "absent.md", "1.0.0")


def test_sensitive_tracked_file_refused():
    files = ["app/api.py", "x/passe-partout.jks", "data/vault.json"]
    assert sensitive_tracked(files) == ["x/passe-partout.jks", "data/vault.json"]


def test_sensitive_other_patterns():
    files = ["a.keystore", "mobile/android/signing.properties", "b.xlsx", "c.xlsm", "prod.env", "update-config.cjs", "ok.txt"]
    assert sensitive_tracked(files) == files[:-1]


def test_capacitor_config_not_sensitive():
    assert sensitive_tracked(["mobile/capacitor.config.json"]) == []
    assert sensitive_tracked(["mobile/config.json"]) == []
    assert sensitive_tracked(["config.json"]) == ["config.json"]
    assert sensitive_tracked(["data/config.json"]) == ["data/config.json"]


def test_publish_dry_run_makes_no_request(monkeypatch, tmp_path, capsys):
    def boom(*a, **k):
        raise AssertionError("réseau appelé")
    monkeypatch.setattr(urllib.request, "urlopen", boom)
    exe = tmp_path / "Passe-Partout-1.0.0.exe"
    exe.write_bytes(b"x")
    publish("1.0.0", exe, "notes", "secret-token", dry_run=True)
    out = capsys.readouterr().out
    assert "v1.0.0" in out and "Passe-Partout-1.0.0.exe" in out
    assert "secret-token" not in out


class _Resp:
    def __init__(self, data):
        self._d = json.dumps(data).encode()
    def read(self):
        return self._d
    def __enter__(self):
        return self
    def __exit__(self, *a):
        return False


def _fake_factory(calls, fail_upload=False):
    def fake(req, timeout=None):
        calls.append(req)
        if req.get_method() == "GET":
            return _Resp([])
        if "/assets" in req.full_url:
            if fail_upload:
                raise urllib.error.HTTPError(req.full_url, 502, "bad", {}, None)
            return _Resp({"name": "x"})
        if req.get_method() == "POST":
            return _Resp({"id": 42})
        return _Resp({})
    return fake


def test_publish_draft_upload_then_publish(monkeypatch, tmp_path):
    exe = tmp_path / "Passe-Partout-1.0.0.exe"
    exe.write_bytes(b"EXE")
    calls = []
    monkeypatch.setattr(urllib.request, "urlopen", _fake_factory(calls))
    publish("1.0.0", exe, "corps", "tok")
    create = [c for c in calls if c.get_method() == "POST" and c.full_url.endswith("/releases")][0]
    assert json.loads(create.data) == {"tag_name": "v1.0.0", "name": "1.0.0", "body": "corps", "draft": True, "prerelease": False}
    assert create.get_header("Authorization") == "Bearer tok"
    up = [c for c in calls if "/assets" in c.full_url][0]
    assert up.full_url == "https://uploads.github.com/repos/BlueFox71/passe-partout/releases/42/assets?name=Passe-Partout-1.0.0.exe"
    assert up.get_header("Content-type") == "application/octet-stream"
    assert up.data == b"EXE"
    last = calls[-1]
    assert last.get_method() == "PATCH" and last.full_url.endswith("/releases/42")
    assert json.loads(last.data) == {"draft": False}
    assert calls.index(up) < calls.index(last)


def test_publish_upload_failure_deletes_draft(monkeypatch, tmp_path):
    exe = tmp_path / "e.exe"
    exe.write_bytes(b"x")
    calls = []
    monkeypatch.setattr(urllib.request, "urlopen", _fake_factory(calls, fail_upload=True))
    with pytest.raises(RuntimeError, match="brouillon.*supprimé"):
        publish("1.0.0", exe, "n", "tok")
    assert calls[-1].get_method() == "DELETE" and calls[-1].full_url.endswith("/releases/42")
    assert not any(c.get_method() == "PATCH" for c in calls)


def test_publish_refuses_existing_release(monkeypatch, tmp_path):
    exe = tmp_path / "e.exe"
    exe.write_bytes(b"x")
    monkeypatch.setattr(urllib.request, "urlopen", lambda req, timeout=None: _Resp([{"tag_name": "v1.0.0", "id": 1}]))
    with pytest.raises(RuntimeError, match="existe déjà"):
        publish("1.0.0", exe, "n", "tok")


def test_publish_existing_draft_says_delete_it(monkeypatch, tmp_path):
    exe = tmp_path / "e.exe"
    exe.write_bytes(b"x")
    calls = []

    def fake(req, timeout=None):
        calls.append(req)
        return _Resp([{"tag_name": "v1.0.0", "id": 7, "draft": True}])
    monkeypatch.setattr(urllib.request, "urlopen", fake)
    with pytest.raises(RuntimeError) as e:
        publish("1.0.0", exe, "n", "tok")
    assert str(e.value) == ("Un brouillon de la version v1.0.0 existe sur GitHub (reste d'un essai raté) : "
                            "supprime-le sur GitHub, puis relance.")
    assert [c.get_method() for c in calls] == ["GET"]  # rien n'est créé ni supprimé
