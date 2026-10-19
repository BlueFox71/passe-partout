"""Logique des cartes cadeaux : dépenses, expiration."""
from __future__ import annotations

from dataclasses import replace
from datetime import date

from app.model import GiftCard, new_id, now_iso


def spend(card: GiftCard, amount: float, today: date) -> GiftCard:
    amount = round(float(amount), 2)
    if amount <= 0:
        raise ValueError("Le montant doit être positif")
    if amount > round(card.remaining, 2) + 1e-9:
        raise ValueError("Montant supérieur au solde restant")
    return replace(
        card,
        remaining=round(card.remaining - amount, 2),
        history=[*card.history, {"id": new_id(), "date": today.isoformat(), "amount": amount}],
        updated=now_iso(),
    )


def is_finished(card: GiftCard, today: date) -> bool:
    return card.remaining <= 0 or (card.end_date is not None and card.end_date < today.isoformat())


def expiring_soon(cards: list[GiftCard], today: date, days: int = 30) -> list[GiftCard]:
    out = []
    for c in cards:
        if is_finished(c, today) or not c.end_date:
            continue
        if (date.fromisoformat(c.end_date) - today).days <= days:
            out.append(c)
    return out
