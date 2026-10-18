import pytest

from app.model import Account


def make_account(name="Compte", category="Divers", login="", password="", **kw):
    return Account(id=kw.pop("id", name.lower()), name=name, category=category, login=login, password=password, **kw)


@pytest.fixture
def sample_accounts():
    return [
        make_account("Facebook", "Réseau social", "alexis@exemple.fr", "fb-Alexis-01"),
        make_account("Boursorama", "Banque", "48213377", "Tr0mpette!Bleue"),
    ]


@pytest.fixture(autouse=True)
def scrypt_rapide_partout(monkeypatch):
    from app import crypto
    monkeypatch.setattr(crypto, "SCRYPT_N", 2**14)


def sample_vault():
    from app.model import GiftCard, Profile, Vault
    return Vault(
        profiles=[Profile(id="p1", name="Jules"), Profile(id="p2", name="Alexis")],
        accounts=[
            make_account("Boursorama", "Banque", "48213377", "Tr0mpette!Bleue", profiles=["p1"]),
            make_account("Netflix", "Streaming", "famille@exemple.fr", "Chill&Popcorn9", profiles=["p1", "p2"]),
        ],
        giftcards=[GiftCard(id="g1", name="Fnac", code="1234", pin="99", remaining=50.0, profiles=["p1"])],
    )
