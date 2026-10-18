"""Construit la bibliothèque de logos ui/logos.js à partir de Simple Icons (CC0).

Usage : python tools/build_logos.py <dossier simple-icons récent> [<dossier simple-icons ancien> ...]
Chaque dossier est le contenu « package » d'un paquet npm simple-icons. Les anciennes versions
complètent les marques retirées depuis (Amazon, LinkedIn, Outlook…).

Format de sortie : window.PP_LOGOS = [[titre, couleur, chemin SVG 24×24 | null, [alias], populaire, sigle | null], …]
"""
from __future__ import annotations

import json
import re
import sys
import unicodedata
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "ui" / "logos.js"


def norm(s: str) -> str:
    s = s.replace("œ", "oe").replace("Œ", "oe").replace("æ", "ae").replace("ß", "ss")
    s = unicodedata.normalize("NFD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"\s+", " ", s).strip().lower()


# Alias supplémentaires (noms tels qu'on les tape) → titre Simple Icons
ALIASES = {
    "Battle.net": ["Battle", "Blizzard Battle.net"],
    "Booking.com": ["Booking"],
    "Burger King": ["Burger Kings", "BK"],
    "McDonald's": ["Macdonald's", "McDonalds", "Mc Do", "McDo"],
    "LinkedIn": ["Linkdl", "Linkedin", "Linked In"],
    "League of Legends": ["LOL", "LoL"],
    "X": ["Twitter", "Twitter / X", "Twitter X"],
    "GOG.com": ["GOG", "GOG Galaxy"],
    "iTunes": ["Itunes"],
    "HP": ["Imprimante HP", "Imprimante HP Smart", "HP Smart"],
    "LG": ["LG ThinQ", "Lg Thinq"],
    "McAfee": ["McAfee portable"],
    "Renault": ["MyRenault", "My Renault"],
    "Synology": ["NAS Synology"],
    "Microsoft Outlook": ["Outlook", "Hotmail", "Live"],
    "Paradox Interactive": ["Paradox"],
    "E.Leclerc": ["Leclerc"],
    "IKEA": ["Ikéa"],
    "EA": ["Electronic Arts", "EA app"],
    "Origin": ["EA Origin"],
    "PayPal": ["Paypal"],
    "Snapchat": ["SnapChat"],
    "Google": ["Gmail", "Compte Google"],
    "Apple": ["iCloud", "Apple ID", "Apple turquie"],
    "AliExpress": ["Aliexpress"],
    "Steelseries": ["SteelSeries"],
    "Uber Eats": ["UberEats"],
    "Meta": ["Oculus", "Ocullus", "Meta Quest"],
    "Nintendo": ["Nintendo Switch", "Compte Nintendo"],
    "Samsung": ["Samsung Account"],
    "Discord": [],
}

# Marques absentes de Simple Icons : pastille aux couleurs de la marque avec un sigle.
MONOGRAMS = [  # titre, couleur, sigle, alias
    ("BoursoBank", "D6006F", "B", ["Boursorama", "Boursorama Banque"]),
    ("Ameli", "0C419A", "am", ["ameli.fr", "Assurance Maladie", "CPAM"]),
    ("CAF", "0068B4", "CAF", ["Caisse d'allocations familiales", "caf.fr"]),
    ("ANTS", "000091", "ANTS", ["Agence Nationale des titres sécurisés", "Permis", "Carte grise"]),
    ("Impôts.gouv", "000091", "€", ["Impots", "Impôts", "impots.gouv.fr", "Impôts.gouv - ALEXIS", "Impôts.gouv - JULES", "DGFiP"]),
    ("Service Public", "000091", "SP", ["service-public.fr", "FranceConnect"]),
    ("MDPH", "1D4F91", "MDPH", []),
    ("CGOS", "E2001A", "CGOS", []),
    ("La Poste", "FFC800", "LP", ["laposte", "La Banque Postale", "Colissimo"]),
    ("Leboncoin", "EC5A13", "lbc", ["Le bon coin", "leboncoin.fr"]),
    ("Free", "CD1E25", "free", ["Freebox", "Free Mobile", "Free PUK", "Freebox à chalon", "Freebox à gigny"]),
    ("SFR", "E2001A", "SFR", ["SFR Mobile", "RED by SFR"]),
    ("Bouygues Telecom", "009DCC", "BT", ["Bouygues", "B&You"]),
    ("Amazon Prime Video", "00A8E1", "PV", ["Prime Video"]),
    ("Disney+", "113CCF", "D+", ["Disney Plus", "Disney"]),
    ("Disneyland Paris", "1B3C8C", "DLP", ["Disneyland", "Disneyland paris"]),
    ("Doctolib", "107ACA", "D", ["doctolib.fr"]),
    ("AXA", "00008F", "AXA", ["Axa Assurance", "AXA Assurance"]),
    ("Macif", "E2001A", "M", ["Macif avantages", "Macif Assurances"]),
    ("MAIF", "C4002B", "MAIF", []),
    ("MAAF", "E30613", "MAAF", []),
    ("Matmut", "D2002E", "M", []),
    ("Groupama", "007A53", "G", []),
    ("Crédit Agricole", "009597", "CA", ["Credit Agricole"]),
    ("Société Générale", "E60028", "SG", ["Societe Generale"]),
    ("BNP Paribas", "00915A", "BNP", ["BNP"]),
    ("LCL", "1A3B8C", "LCL", []),
    ("Caisse d'Épargne", "E2001A", "CE", ["Caisse d'Epargne"]),
    ("Banque Populaire", "0055A4", "BP", ["Banque Pop"]),
    ("Crédit Mutuel", "E2001A", "CM", ["Credit Mutuel"]),
    ("Banque de France", "13286F", "BDF", ["Compte BFC"]),
    ("Cofidis", "009A93", "C", []),
    ("Oney", "81BC00", "oney", []),
    ("Amundi Épargne Salariale", "002060", "A", ["Amundi", "Amundi-ee", "Amundi EE"]),
    ("Natixis Interépargne", "5C2D91", "N", ["Els épargne entreprise", "Interepargne"]),
    ("ANCV", "E4003A", "ANCV", ["Chèques-Vacances", "Cheques vacances"]),
    ("Edenred", "F72717", "e", ["Carte Edenred", "Carte Endered", "Ticket Restaurant"]),
    ("Swile", "6B3AF7", "S", []),
    ("TotalEnergies", "ED0000", "TE", ["Total", "Total Energies"]),
    ("EDF", "FE5815", "EDF", []),
    ("Engie", "00AAFF", "E", []),
    ("Decathlon", "0082C3", "D", []),
    ("Boulanger", "EB5A0C", "B", []),
    ("Darty", "E30613", "D", []),
    ("BUT", "E3004F", "BUT", []),
    ("Conforama", "E30613", "C", []),
    ("Castorama", "0058A3", "C", []),
    ("Leroy Merlin", "78BE20", "LM", []),
    ("Maisons du Monde", "1D1D1B", "MdM", ["Maisons du monde"]),
    ("Celio", "1D1D1B", "celio", []),
    ("Yves Rocher", "006A4E", "YR", []),
    ("Sephora", "000000", "S", []),
    ("Feu Vert", "009640", "FV", ["Feu vert"]),
    ("Norauto", "E30613", "N", []),
    ("Carrefour", "004E9F", "C", []),
    ("Auchan", "E2001A", "A", []),
    ("Intermarché", "E2001A", "I", ["Intermarche"]),
    ("Lidl", "0050AA", "L", []),
    ("KFC", "A3080C", "KFC", []),
    ("Speed Burger", "E30613", "SB", []),
    ("Molotov", "1C1C1C", "M", ["Molotov TV"]),
    ("M6+", "1E2A78", "M6+", ["6play", "M6"]),
    ("Gulli", "F39200", "G", ["gulli"]),
    ("Salto", "1F1F1F", "S", []),
    ("Instant Gaming", "FF5400", "IG", ["Instant gaming"]),
    ("Nexus Mods", "D98F40", "N", ["Nexus mods"]),
    ("Dead by Daylight", "1F1F1F", "DbD", []),
    ("Final Fantasy", "1F2D5C", "FF", ["Final Fantasy XIV", "FFXIV"]),
    ("Forge of Empires", "8B5A2B", "FoE", ["Forge Of Empire"]),
    ("UNiDAYS", "1A1A1A", "U", ["Unidays"]),
    ("Unilabs", "00A3E0", "U", ["unilabs"]),
    ("Wonderbox", "E4007C", "W", []),
    ("Fitness Park", "E30613", "FP", []),
    ("Hypnia", "1E3A5F", "H", []),
    ("Emma", "00AEEF", "E", ["Emma matelas"]),
    ("Poulpeo", "F5A623", "P", []),
    ("Displate", "1A1A1A", "D", ["Displates"]),
    ("Coffreo", "2E7D32", "C", []),
    ("EdocPerso", "00A0DF", "e", []),
    ("Ulys", "00A651", "U", ["Bip&Go"]),
    ("EFFIA", "E30613", "E", []),
    ("SNCF Connect", "0C131F", "SNCF", ["Oui.sncf", "Ouigo"]),
    ("RATP", "00A88F", "RATP", []),
    ("Blablacar", "054752", "B", []),
    ("Vinted", "09B1BA", "V", []),
    ("Cdiscount", "0055A5", "C", []),
    ("Veepee", "E5007D", "V", ["Vente Privée", "vente-privee"]),
    ("Shein", "000000", "S", []),
    ("Temu", "FB7701", "T", []),
    ("Chibi Akihabara", "E4007C", "CA", []),
    ("A&E", "1A1A1A", "A&E", ["A & E"]),
    ("Shop Pharmacie", "00A651", "+", ["Pharmacie"]),
    ("Mele", "6B3AF7", "M", []),
    ("Lolivier", "6B8E23", "L", ["L'olivier assurance"]),
    ("Rakuten", "BF0000", "R", []),
    ("MaCarteCadeau", "E4007C", "MCC", ["Ma carte cadeau"]),
    ("Zalando", "FF6900", "Z", []),
    ("Hotels.com", "D32F2F", "H", []),
    ("Larian Launcher", "1F1F1F", "L", ["LariLauncher"]),
]

# Marques grand public mises en avant dans les suggestions (en plus des alias ci-dessus).
POPULAR = {
    "Netflix", "Spotify", "Deezer", "YouTube", "Twitch", "Discord", "Steam", "Epic Games", "Ubisoft", "PlayStation",
    "Xbox", "Nintendo", "Battle.net", "Riot Games", "League of Legends", "Valorant", "Fortnite", "Minecraft", "Roblox",
    "GOG.com", "EA", "Origin", "Crunchyroll", "Apple", "Google", "Microsoft", "Microsoft Outlook", "Gmail", "Proton Mail",
    "Yahoo!", "AOL", "Facebook", "Instagram", "WhatsApp", "Messenger", "Snapchat", "TikTok", "X", "LinkedIn", "Reddit",
    "Pinterest", "Telegram", "Signal", "Amazon", "eBay", "AliExpress", "PayPal", "Revolut", "N26", "Lydia", "Visa",
    "Mastercard", "Booking.com", "Airbnb", "Hotels.com", "Uber", "Uber Eats", "Deliveroo", "Just Eat", "McDonald's",
    "Burger King", "KFC", "Starbucks", "IKEA", "Adidas", "Nike", "Puma", "Zara", "H&M", "Samsung", "Sony", "LG", "HP",
    "Dell", "Lenovo", "Asus", "Acer", "Synology", "Dropbox", "GitHub", "GitLab", "Canva", "Adobe", "Zoom", "Skype",
    "Disney+", "Prime Video", "Renault", "Peugeot", "Citroën", "Tesla", "Toyota", "Volkswagen", "SNCF", "Orange",
    "McAfee", "Norton", "Kaspersky", "Avast", "Bitdefender", "Steelseries", "Razer", "Logitech", "Corsair", "Oculus",
    "Meta", "Paradox Interactive", "Rakuten", "Fnac", "Carrefour", "E.Leclerc", "Castorama", "Zalando", "UPS", "DHL",
    "FedEx", "Chronopost", "iTunes", "Boulanger",
}


def svg_path(icons_dir: Path, slug: str) -> str | None:
    f = icons_dir / f"{slug}.svg"
    if not f.exists():
        return None
    m = re.search(r'<path d="([^"]+)"', f.read_text(encoding="utf-8"))
    return m.group(1) if m else None


def load(pkg: Path) -> list[dict]:
    for rel in ("data/simple-icons.json", "_data/simple-icons.json"):
        if (pkg / rel).exists():
            d = json.loads((pkg / rel).read_text(encoding="utf-8"))
            return d["icons"] if isinstance(d, dict) else d
    raise FileNotFoundError(pkg)


def slugify(title: str) -> str:
    # règle de nommage de Simple Icons (suffisante pour les anciennes versions sans champ slug)
    t = title.replace("+", "plus").replace(".", "dot").replace("&", "and")
    t = unicodedata.normalize("NFD", t)
    return re.sub(r"[^a-z0-9]", "", "".join(c for c in t if not unicodedata.combining(c)).lower())


def main(pkgs: list[Path]) -> None:
    entries: dict[str, list] = {}
    for pkg in pkgs:
        for icon in load(pkg):
            title = icon["title"]
            key = norm(title)
            if key in entries:
                continue
            path = svg_path(pkg / "icons", icon.get("slug") or slugify(title))
            if not path:
                continue
            aka = list(icon.get("aliases", {}).get("aka", []))
            entries[key] = [title, icon["hex"].upper(), path, aka, 0, None]
    for title, color, letters, aliases in MONOGRAMS:
        key = norm(title)
        if key in entries:  # le vrai logo existe : on ne garde que les alias
            entries[key][3] += aliases
        else:
            entries[key] = [title, color, None, list(aliases), 1, letters]
    for title, aliases in ALIASES.items():
        e = entries.get(norm(title))
        if e:
            e[3] += aliases
            e[4] = 1
    for title in POPULAR:
        e = entries.get(norm(title))
        if e:
            e[4] = 1
    data = sorted(entries.values(), key=lambda e: norm(e[0]))
    for e in data:
        e[3] = sorted(set(e[3]))
    js = ("/* Bibliothèque de logos — générée par tools/build_logos.py à partir de Simple Icons (CC0). Ne pas modifier. */\n"
          "window.PP_LOGOS = " + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";\n")
    OUT.write_text(js, encoding="utf-8")
    print(f"{len(data)} logos ({sum(1 for e in data if e[2])} vectoriels, {sum(1 for e in data if not e[2])} sigles) -> {OUT}")


if __name__ == "__main__":
    main([Path(p) for p in sys.argv[1:]])
