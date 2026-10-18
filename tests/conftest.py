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
