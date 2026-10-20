"""Lecture de l'export CSV des mots de passe de Chrome (colonnes name, url, username, password, note).

Ne modifie rien : produit les lignes à proposer dans la fenêtre de revue de l'import.
Ne journalise jamais de mot de passe.
"""
from __future__ import annotations

import csv
import ipaddress
import re
from pathlib import Path
from urllib.parse import urlparse

from app.model import Vault
from app.textutil import normalize

# Suffixes à deux niveaux : le nom du site est la partie juste avant (impots.gouv.fr → impots).
_SECOND_LEVEL = {
    "gouv.fr", "asso.fr", "co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "co.jp", "co.nz", "com.br",
    "co.in", "com.cn", "github.io", "gitlab.io", "blogspot.com", "herokuapp.com", "netlify.app", "vercel.app",
}
_HOST = re.compile(r"^[\w-]+(\.[\w-]+)*$")


def squash(s: str) -> str:
    """Clé de comparaison des noms : sans casse, accents, espaces ni ponctuation (Le Bon Coin = leboncoin)."""
    return re.sub(r"[^a-z0-9]", "", normalize(s))


def _is_ip(host: str) -> bool:
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        return False


def _site_of_host(host: str) -> str:
    labels = [x for x in host.split(".") if x]
    if labels and labels[0] == "www":
        labels = labels[1:]
    if len(labels) >= 3 and ".".join(labels[-2:]) in _SECOND_LEVEL:
        base = labels[-3]
    elif len(labels) >= 2:
        # nom trop court pour être parlant : on garde l'extension (www.e.leclerc → E.leclerc)
        base = labels[-2] if len(labels[-2]) > 1 else ".".join(labels[-2:])
    else:
        base = labels[0] if labels else host
    base = base.replace("-", " ")  # yves-rocher → Yves rocher
    return base[:1].upper() + base[1:]


def simplify_name(name: str, url: str) -> str:
    """Nom lisible : « accounts.google.com » → Google, « AliExpress : shopping » (appli Android) → AliExpress."""
    name = (name or "").strip()
    u = urlparse(url or "")
    if not name or re.match(r"^https?://", name, re.I):
        name = urlparse(name).netloc if name else u.netloc
    host = name.lower()
    if _is_ip(host.split(":")[0]) or host.split(":")[0] in ("localhost", ""):
        return name  # adresse locale : on garde l'adresse complète, port compris
    if host.endswith(".local"):
        base = host[:-6].split(".")[-1]
        return base[:1].upper() + base[1:]
    if _HOST.match(host):
        if u.scheme == "android" and "." in host:
            # appli Android : le nom est le paquet à l'envers, le paquet donne la marque (com.myheritage.mobile)
            package = [x for x in u.netloc.rpartition("@")[2].split(".") if x]
            if package and package[0] == "air":
                package = package[1:]
            if len(package) >= 2:
                return package[1][:1].upper() + package[1][1:]
        return _site_of_host(host)
    return re.split(r"\s*:", name, maxsplit=1)[0].strip() or name


def read_chrome_csv(path: Path, vault: Vault) -> dict:
    """Renvoie {rows: [{name, login, password}], uptodate: n}.

    Lignes sans mot de passe (sites « jamais enregistrer ») ignorées ; lignes identiques après
    simplification du nom fusionnées ; nom remplacé par celui d'un compte existant équivalent
    (même nom aux espaces, accents et ponctuation près) ; lignes déjà présentes à l'identique dans le coffre
    (même nom, identifiant et mot de passe) retirées et comptées dans « uptodate ».
    """
    with open(path, encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        fields = {normalize(h) for h in reader.fieldnames or []}
        if not {"username", "password"} <= fields or not fields & {"name", "url"}:
            raise ValueError("Ce fichier n'est pas un export des mots de passe de Chrome")
        raw = [{normalize(k): (v or "") for k, v in r.items() if k} for r in reader]

    existing = {(squash(a.name), a.login.strip(), a.password) for a in vault.accounts}
    # un compte déjà présent sous un nom proche (« Le Bon Coin » pour leboncoin) donne son nom à la ligne
    names = {}
    for a in vault.accounts:
        names.setdefault(squash(a.name), a.name)
    seen, rows, uptodate = set(), [], 0
    for r in raw:
        password = r.get("password", "")
        if not password:
            continue
        name = simplify_name(r.get("name", ""), r.get("url", ""))
        name = names.get(squash(name), name)
        login = r.get("username", "").strip()
        key = (squash(name), login, password)
        if key in seen:
            continue
        seen.add(key)
        if key in existing:
            uptodate += 1
            continue
        rows.append({"name": name, "login": login, "password": password})
    rows.sort(key=lambda x: (normalize(x["name"]), normalize(x["login"])))
    return {"rows": rows, "uptodate": uptodate}
