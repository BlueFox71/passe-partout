from datetime import date

import pytest

from app.giftcards import expiring_soon, is_finished, spend
from app.model import GiftCard

TODAY = date(2026, 10, 18)


def card(name="C", remaining=50.0, end=None):
    return GiftCard(id=name, name=name, remaining=remaining, end_date=end)


def test_spend():
    c = spend(card(remaining=50.0), 12.5, TODAY)
    entry = c.history[-1]
    assert c.remaining == 37.5 and entry.pop("id") and entry == {"date": "2026-10-18", "amount": 12.5}


def test_spend_arrondi():
    assert spend(card(remaining=10.0), 3.333, TODAY).remaining == 6.67


def test_spend_trop():
    with pytest.raises(ValueError):
        spend(card(remaining=10.0), 11, TODAY)


def test_spend_negatif():
    with pytest.raises(ValueError):
        spend(card(remaining=10.0), 0, TODAY)


def test_spend_tout_le_solde():
    assert spend(card(remaining=10.1), 10.1, TODAY).remaining == 0


def test_expiration():
    cards = [card("A", end="2026-11-01"), card("B", end="2027-01-01"), card("C", end=None),
             card("D", end="2026-10-20", remaining=0), card("E", end="2026-10-17")]
    assert [c.name for c in expiring_soon(cards, TODAY)] == ["A"]
    assert is_finished(card(remaining=0), TODAY) and is_finished(card(end="2026-10-17"), TODAY)
    assert not is_finished(card(end="2026-10-18"), TODAY)
