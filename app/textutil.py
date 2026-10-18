"""Utilitaires texte : normalisation, format d'affichage, recherche, solidité.

Les mêmes règles sont dupliquées côté interface dans ui/app.js.
"""
from __future__ import annotations

import re
import unicodedata
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from app.model import Account


def normalize(s: str | None) -> str:
    """Minuscules, sans accents, espaces multiples réduits."""
    s = unicodedata.normalize("NFD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"\s+", " ", s).strip().lower()


def apply_mask(value: str | None, mask: str | None) -> str:
    """Chaque '#' du modèle consomme un caractère de la valeur, le reste est inséré tel quel.

    Le surplus de la valeur est ajouté à la suite ; l'affichage s'arrête quand la valeur est épuisée.
    """
    value = value or ""
    if not mask:
        return value
    out, i = [], 0
    for m in mask:
        if i >= len(value):
            break
        if m == "#":
            out.append(value[i])
            i += 1
        else:
            out.append(m)
    return "".join(out) + value[i:]


def raw_value(value: str | None) -> str:
    """Valeur à copier : la valeur stockée, sans le formatage d'affichage."""
    return value or ""


def strength(pw: str | None) -> int:
    """Score de solidité de 0 à 4 (longueur et variété des caractères)."""
    pw = pw or ""
    if not pw:
        return 0
    classes = sum(bool(re.search(p, pw)) for p in (r"[a-z]", r"[A-Z]", r"[0-9]", r"[^A-Za-z0-9]"))
    score = (len(pw) >= 8) + (len(pw) >= 12) + max(0, classes - 1)
    return min(4, score)


def search(accounts: list["Account"], query: str | None) -> list["Account"]:
    """Filtre sur nom, identifiant et catégorie (jamais sur le mot de passe)."""
    q = normalize(query)
    if not q:
        return accounts
    return [a for a in accounts if q in normalize(f"{a.name} {a.login} {a.category}")]
