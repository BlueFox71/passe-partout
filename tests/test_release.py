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


def test_publish_creates_release_and_uploads(monkeypatch, tmp_path):
    exe = tmp_path / "Passe-Partout-1.0.0.exe"
    exe.write_bytes(b"EXE")
    calls = []

    def fake(req, timeout=None):
        calls.append(req)
        if req.get_method() == "GET":
            return _Resp([])
        if "/releases/" in req.full_url and "/assets" in req.full_url:
            return _Resp({"name": "x"})
        return _Resp({"id": 42})

    monkeypatch.setattr(urllib.request, "urlopen", fake)
    publish("1.0.0", exe, "corps", "tok")
    create = [c for c in calls if c.get_method() == "POST" and c.full_url.endswith("/releases")][0]
    body = json.loads(create.data)
    assert body == {"tag_name": "v1.0.0", "name": "1.0.0", "body": "corps", "draft": False, "prerelease": False}
    assert create.get_header("Authorization") == "Bearer tok"
    up = calls[-1]
    assert up.full_url == "https://uploads.github.com/repos/BlueFox71/passe-partout/releases/42/assets?name=Passe-Partout-1.0.0.exe"
    assert up.get_header("Content-type") == "application/octet-stream"
    assert up.data == b"EXE"


def test_publish_refuses_existing_release(monkeypatch, tmp_path):
    exe = tmp_path / "e.exe"
    exe.write_bytes(b"x")
    monkeypatch.setattr(urllib.request, "urlopen", lambda req, timeout=None: _Resp([{"tag_name": "v1.0.0", "id": 1}]))
    with pytest.raises(RuntimeError, match="existe déjà"):
        publish("1.0.0", exe, "n", "tok")
