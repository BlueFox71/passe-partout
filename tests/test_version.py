from pathlib import Path

from app.version import VERSION, compare_versions, parse_version

import pytest


def test_parse_version():
    assert parse_version("1.0.0") == (1, 0, 0)
    for bad in ("1.0", "v1.0.0", "1.0.0-beta", "", None, 1):
        assert parse_version(bad) is None


def test_compare_versions():
    assert compare_versions("1.0.0", "1.0.0") == 0
    assert compare_versions("0.1.0", "1.0.0") == -1
    assert compare_versions("1.10.0", "1.9.9") == 1


def test_compare_versions_invalide():
    with pytest.raises(ValueError):
        compare_versions("1.0", "1.0.0")
    with pytest.raises(ValueError):
        compare_versions("1.0.0", "x")


def test_version_file_matches_constant():
    racine = Path(__file__).resolve().parent.parent
    assert VERSION == (racine / "VERSION").read_text(encoding="utf-8").strip() == "1.1.0"


def test_lecture_version_ignore_le_bom(tmp_path):
    from app.version import read_version_file
    f = tmp_path / "VERSION"
    f.write_bytes(b"\xef\xbb\xbf2.3.4\r\n")
    assert read_version_file(f) == "2.3.4"


def test_lecture_version_absente_message_clair(tmp_path):
    from app.version import read_version_file
    with pytest.raises(RuntimeError, match="VERSION"):
        read_version_file(tmp_path / "VERSION")
