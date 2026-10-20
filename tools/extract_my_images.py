"""Extrait du coffre les images choisies pour les comptes et cartes cadeaux (nom + image seulement).

Sert à construire ui/logos-perso.js, les logos livrés avec l'appli. Le coffre est seulement lu.
Le code est demandé dans le terminal ; aucun identifiant ni mot de passe n'est écrit.

Usage : python tools/extract_my_images.py <fichier de sortie .json>
"""
from __future__ import annotations

import getpass
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.main import default_data_dir  # noqa: E402
from app.store import VaultStore  # noqa: E402


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    store = VaultStore(default_data_dir() / "vault.json")
    code = getpass.getpass("Code du coffre : ") if store.is_encrypted() else None
    vault = store.load(code)
    items = [{"name": x.name, "image": x.image, "updated": x.updated}
             for x in [*vault.accounts, *vault.giftcards] if x.image]
    Path(sys.argv[1]).write_text(json.dumps(items, ensure_ascii=False), encoding="utf-8")
    print(f"{len(items)} image(s) extraite(s) dans {sys.argv[1]}")


if __name__ == "__main__":
    main()
