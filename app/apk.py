"""APK Android embarqué dans l'exe (ou construit dans le dépôt) : emplacement et empreinte."""
from __future__ import annotations

import hashlib
import sys
from pathlib import Path

from app.version import VERSION

APK_NAME = "passe-partout.apk"
REPO_ROOT = Path(__file__).resolve().parent.parent
# Les tests (et outils) peuvent pointer vers un autre fichier : find_apk() le renvoie tel quel.
APK_OVERRIDE: Path | None = None

_cache: dict[tuple[str, int, int], str] = {}


def find_apk() -> Path | None:
    """Exe gelé → <_MEIPASS>/apk/passe-partout.apk ; sinon mobile/dist/passe-partout.apk du dépôt ; sinon None."""
    if APK_OVERRIDE is not None:
        p = Path(APK_OVERRIDE)
    elif getattr(sys, "frozen", False):
        p = Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent)) / "apk" / APK_NAME
    else:
        p = REPO_ROOT / "mobile" / "dist" / APK_NAME
    return p if p.is_file() else None


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for bloc in iter(lambda: f.read(1024 * 1024), b""):
            h.update(bloc)
    return h.hexdigest()


def apk_info(path: Path | None) -> dict | None:
    """Version, taille, SHA-256 (calculé une fois par chemin+taille+date) et nom de fichier proposé."""
    if path is None:
        return None
    try:
        st = Path(path).stat()
    except OSError:
        return None
    cle = (str(Path(path).resolve()), st.st_size, st.st_mtime_ns)
    sha = _cache.get(cle)
    if sha is None:
        sha = _cache[cle] = _sha256_file(Path(path))
    return {"version": VERSION, "size": st.st_size, "sha256": sha, "filename": f"passe-partout-{VERSION}.apk"}
