"""Version unique de Passe-Partout, lue dans le fichier VERSION (racine du dépôt, ou dossier d'extraction de l'exe)."""
import sys
from pathlib import Path


def _chemin_version() -> Path:
    if getattr(sys, "frozen", False):
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent)) / "VERSION"
    return Path(__file__).resolve().parent.parent / "VERSION"


def parse_version(s: object) -> "tuple[int, int, int] | None":
    """« 1.2.3 » uniquement (trois entiers) ; toute autre forme donne None."""
    if not isinstance(s, str):
        return None
    parts = s.split(".")
    if len(parts) != 3 or not all(p.isascii() and p.isdigit() for p in parts):
        return None
    return int(parts[0]), int(parts[1]), int(parts[2])


def compare_versions(a: str, b: str) -> int:
    """-1, 0 ou 1 ; ValueError si l'une des versions est invalide."""
    pa, pb = parse_version(a), parse_version(b)
    if pa is None or pb is None:
        raise ValueError(f"version invalide : {a!r} / {b!r}")
    return (pa > pb) - (pa < pb)


def read_version_file(path: Path) -> str:
    """Contenu de VERSION, sans BOM ni espaces ; erreur explicite si le fichier manque."""
    try:
        return path.read_text(encoding="utf-8-sig").strip()
    except FileNotFoundError:
        raise RuntimeError(f"Fichier VERSION introuvable ({path}) : il doit être fourni avec l'application.") from None


VERSION = read_version_file(_chemin_version())
