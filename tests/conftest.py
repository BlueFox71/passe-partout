import pytest

from app.api import Api
from app.model import Account
from app.store import VaultStore


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
    # date de création fixe : deux appels à cheval sur un changement de seconde donnent le même contenu
    created = "2026-10-01T09:00:00"
    return Vault(
        profiles=[Profile(id="p1", name="Jules"), Profile(id="p2", name="Alexis")],
        accounts=[
            make_account("Boursorama", "Banque", "48213377", "Tr0mpette!Bleue", profiles=["p1"], created=created),
            make_account("Netflix", "Streaming", "famille@exemple.fr", "Chill&Popcorn9", profiles=["p1", "p2"],
                         created=created),
        ],
        giftcards=[GiftCard(id="g1", name="Fnac", code="1234", pin="99", remaining=50.0, profiles=["p1"])],
    )


class FakeClip:
    def __init__(self):
        self.text = ""

    def get(self):
        return self.text

    def set(self, text, secret=False):
        self.text = text

    def clear(self):
        self.text = ""


class Clock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t

    def advance(self, s):
        self.t += s


class FakeDialogs:
    def __init__(self):
        self.file = None
        self.folder = None

    def open_file(self, kind):
        return self.file

    def pick_folder(self):
        return self.folder


@pytest.fixture
def clock():
    return Clock()


@pytest.fixture
def fake_clip():
    return FakeClip()


@pytest.fixture
def dialogs():
    return FakeDialogs()


def make_api(tmp_path, clip, clock, dialogs):
    return Api(VaultStore(tmp_path / "vault.json"), clip, clock=clock, wall_clock=clock, dialogs=dialogs, schedule=lambda s, f: None)


@pytest.fixture
def api_unlocked(tmp_path, fake_clip, clock, dialogs):
    VaultStore(tmp_path / "vault.json").save(sample_vault())
    return make_api(tmp_path, fake_clip, clock, dialogs)


@pytest.fixture
def api_locked(tmp_path, fake_clip, clock, dialogs):
    api = make_api(tmp_path, fake_clip, clock, dialogs)
    api.start_empty("Jules")
    api.set_lock("pin", "123456")
    return make_api(tmp_path, fake_clip, clock, dialogs)  # nouveau lancement
