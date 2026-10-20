"""Logique des cartes bancaires : expiration, repérage et conversion des comptes qui sont des cartes."""
from __future__ import annotations

import re

from app.model import Account, BankCard, Vault, tombstone

EXPIRY_RE = re.compile(r"^(0[1-9]|1[0-2])/\d{2}$")
_CARD_NUMBER_RE = re.compile(r"^\d{13,19}$")


def check_expiry(expiry: str) -> str:
    """« 1228 », « 12-28 », « 12/2028 » → « 12/28 » ; vide accepté ; ValueError sinon."""
    s = re.sub(r"\s+", "", str(expiry or ""))
    if not s:
        return ""
    m = re.fullmatch(r"(\d{1,2})[/\-.]?(\d{2}|\d{4})", s)
    if m:
        s = f"{int(m.group(1)):02d}/{m.group(2)[-2:]}"
    if not EXPIRY_RE.match(s):
        raise ValueError("Date d'expiration invalide (format MM/AA)")
    return s


def digits(number: str) -> str:
    """Numéro sans espaces ni tirets (c'est ce qui est copié)."""
    return re.sub(r"[\s\-]", "", str(number or ""))


def _luhn(number: str) -> bool:
    """Clé de contrôle de tous les numéros de carte."""
    total = 0
    for i, c in enumerate(reversed(number)):
        n = int(c) * (2 if i % 2 else 1)
        total += n - 9 if n > 9 else n
    return total % 10 == 0


def is_card_number(number: str) -> bool:
    """Numéro Visa (13, 16 ou 19 chiffres), Mastercard (16) ou American Express (15) à la clé valide.

    Exige plus qu'une simple suite de chiffres : un numéro fiscal (13 chiffres) ou de sécurité sociale
    (15 chiffres) ne doit pas passer pour une carte.
    """
    d = digits(number)
    if not _CARD_NUMBER_RE.match(d):
        return False
    visa = d[0] == "4" and len(d) in (13, 16, 19)
    master = len(d) == 16 and (51 <= int(d[:2]) <= 55 or 2221 <= int(d[:4]) <= 2720)
    amex = len(d) == 15 and d[:2] in ("34", "37")
    return (visa or master or amex) and _luhn(d)


def looks_like_card(account: Account) -> bool:
    """Un compte est une carte bancaire si son identifiant est un numéro de carte."""
    return is_card_number(account.login)


def from_account(account: Account, updated: str) -> BankCard:
    """Carte tirée d'un compte : 3 chiffres → cryptogramme, tout autre mot de passe → code."""
    pw = account.password.strip()
    is_cvv = bool(re.fullmatch(r"\d{3}", pw))
    return BankCard(id=account.id, name=account.name, number=digits(account.login),
                    cvv=pw if is_cvv else "", pin="" if is_cvv else pw,
                    image=account.image, profiles=list(account.profiles), updated=updated)


def convert_accounts(vault: Vault, now: str) -> int:
    """Convertit en cartes bancaires les comptes qui en sont ; renvoie leur nombre.

    La carte garde l'id du compte ; le compte laisse une pierre tombale pour que la synchro le retire
    aussi du téléphone (les pierres tombales sont propres à chaque type d'élément).
    """
    cards = [a for a in vault.accounts if looks_like_card(a)]
    if not cards:
        return 0
    ids = {a.id for a in cards}
    vault.accounts = [a for a in vault.accounts if a.id not in ids]
    vault.bankcards.extend(from_account(a, now) for a in cards)
    vault.deleted.extend(tombstone("account", a.id, now) for a in cards)
    return len(cards)
