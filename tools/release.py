"""Publication d'une version de Passe-Partout : vérifications et release GitHub.

Appelé par release.ps1 (le jeton GH_TOKEN est lu dans l'environnement, jamais en argument) :
    python tools/release.py check-notes <version> [RELEASE_NOTES.md]
    python tools/release.py sensitive            (fichiers suivis par git, un par ligne sur stdin)
    python tools/release.py publish <version> <exe> [--dry-run] [--notes RELEASE_NOTES.md]
"""
from __future__ import annotations

import fnmatch
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

REPO = "BlueFox71/passe-partout"
_MARKER = re.compile(r"^\s*<!--\s*version:\s*(\S+)\s*-->[ \t]*\r?\n?")


def read_notes(path: Path, version: str) -> str:
    """Notes de la release, sans le marqueur ; ValueError si absentes, périmées ou vides."""
    try:
        raw = Path(path).read_text(encoding="utf-8-sig")
    except OSError:
        raise ValueError(f"{Path(path).name} introuvable : rédige le rapport de la version {version}.")
    m = _MARKER.match(raw)
    if not m:
        raise ValueError(f"RELEASE_NOTES.md doit commencer par <!-- version: {version} -->.")
    if m.group(1) != version:
        raise ValueError(f"RELEASE_NOTES.md est le rapport de la {m.group(1)}, pas de la {version} : mets-le à jour.")
    body = raw[m.end():].strip()
    if not body:
        raise ValueError("RELEASE_NOTES.md est vide.")
    return body


_SENSITIVE_NAMES = ("*.jks", "*.keystore", "signing.properties", "vault.json", "*.xlsx", "*.xlsm", "*.env", "update-config.cjs")


def sensitive_tracked(files: list[str]) -> list[str]:
    """Chemins suivis par git qui ne devraient jamais l'être (clés, coffre, données)."""
    out = []
    for f in files:
        p = f.replace("\\", "/")
        name = p.rsplit("/", 1)[-1]
        if any(fnmatch.fnmatch(name, pat) for pat in _SENSITIVE_NAMES):
            out.append(f)
        elif name == "config.json" and not p.startswith("mobile/"):
            out.append(f)
    return out


def _request(url, token, method="GET", data=None, content_type=None):
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("X-GitHub-Api-Version", "2022-11-28")
    req.add_header("User-Agent", "passe-partout-release")
    if content_type:
        req.add_header("Content-Type", content_type)
    try:
        with urllib.request.urlopen(req, timeout=600) as resp:
            return json.loads(resp.read() or b"null")
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"GitHub a répondu HTTP {e.code} ({method} {url.split('?')[0]}).") from None
    except urllib.error.URLError as e:
        raise RuntimeError(f"GitHub injoignable : {e.reason}") from None


def publish(version, exe_path, notes, token, repo=REPO, dry_run=False):
    """Crée la release v<version> (tag déjà poussé) et y téléverse l'exe."""
    exe_path = Path(exe_path)
    tag = f"v{version}"
    if dry_run:
        print(f"[simulation] Créer la release {tag} (titre « {version} ») sur {repo}, {len(notes)} caractères de notes.")
        print(f"[simulation] Téléverser {exe_path.name} (application/octet-stream).")
        return
    api = f"https://api.github.com/repos/{repo}"
    existing = _request(f"{api}/releases?per_page=100", token) or []
    same = [r for r in existing if r.get("tag_name") == tag]
    if any(r.get("draft") for r in same):
        raise RuntimeError(f"Un brouillon de la version {tag} existe sur GitHub (reste d'un essai raté) : "
                           "supprime-le sur GitHub, puis relance.")
    if same:
        raise RuntimeError(f"La release {tag} existe déjà sur {repo} : rien n'est écrasé. Monte la version.")
    # Brouillon d'abord : la release n'est visible qu'une fois l'exe téléversé.
    release = _request(
        f"{api}/releases", token, "POST",
        json.dumps({"tag_name": tag, "name": version, "body": notes, "draft": True, "prerelease": False}).encode("utf-8"),
        "application/json",
    )
    rid = release["id"]
    url = f"https://uploads.github.com/repos/{repo}/releases/{rid}/assets?name={exe_path.name}"
    try:
        _request(url, token, "POST", exe_path.read_bytes(), "application/octet-stream")
        _request(f"{api}/releases/{rid}", token, "PATCH", json.dumps({"draft": False}).encode("utf-8"), "application/json")
    except RuntimeError as e:
        try:
            _request(f"{api}/releases/{rid}", token, "DELETE")
            nettoye = f"Le brouillon de la release {tag} a été supprimé ; relance après avoir retiré le tag (git push --delete origin {tag} ; git tag -d {tag})."
        except RuntimeError:
            nettoye = f"Supprime à la main le brouillon de la release {tag} sur GitHub, puis retire le tag (git push --delete origin {tag} ; git tag -d {tag})."
        raise RuntimeError(f"{e} {nettoye}") from None
    print(f"Release {tag} publiée sur {repo} avec {exe_path.name}.")


def main(argv):
    cmd = argv[0] if argv else ""
    try:
        if cmd == "check-notes":
            read_notes(Path(argv[2] if len(argv) > 2 else "RELEASE_NOTES.md"), argv[1])
            return 0
        if cmd == "sensitive":
            bad = sensitive_tracked([l.strip() for l in sys.stdin if l.strip()])
            for b in bad:
                print(b)
            return 1 if bad else 0
        if cmd == "publish":
            dry = "--dry-run" in argv
            args = [a for a in argv[1:] if a != "--dry-run"]
            notes_file = "RELEASE_NOTES.md"
            if "--notes" in args:
                i = args.index("--notes")
                notes_file = args[i + 1]
                del args[i:i + 2]
            version, exe = args[0], args[1]
            notes = read_notes(Path(notes_file), version)
            token = os.environ.get("GH_TOKEN", "")
            if not token and not dry:
                raise RuntimeError("Définis GH_TOKEN (jeton GitHub en écriture sur passe-partout) puis relance.")
            publish(version, exe, notes, token, dry_run=dry)
            return 0
        print(__doc__)
        return 2
    except (ValueError, RuntimeError) as e:
        print(f"ERREUR : {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
