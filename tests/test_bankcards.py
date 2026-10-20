"""Cartes bancaires : règles, API, conversion des comptes qui sont des cartes, fusion et synchro."""
import pytest

from app import bankcards as bc
from app.merge import merge
from app.model import Account, BankCard, Profile, Vault, tombstone
from app.store import VaultStore
from app.syncflow import validate_phone_vault
from tests.conftest import make_account, make_api, sample_vault

T = "2026-10-01T09:00:00"
LS = "2026-10-01T12:00:00"
NOW = "2026-10-19T12:00:00"


def card_dict(**kw):
    d = {"id": None, "name": "Boursorama", "holder": "JULES CANNET", "number": "4970 1234 5678 1234",
         "expiry": "12/28", "cvv": "123", "pin": "4321", "image": None, "profiles": ["p1"]}
    d.update(kw)
    return d


# ---------- règles ----------
@pytest.mark.parametrize("raw, out", [("12/28", "12/28"), ("1228", "12/28"), ("12-2028", "12/28"),
                                      ("3/27", "03/27"), (" 03 / 27 ", "03/27"), ("", ""), (None, "")])
def test_check_expiry_normalise(raw, out):
    assert bc.check_expiry(raw) == out


@pytest.mark.parametrize("raw", ["13/28", "00/28", "12/2", "demain", "1/2/28"])
def test_check_expiry_refuse(raw):
    with pytest.raises(ValueError):
        bc.check_expiry(raw)


@pytest.mark.parametrize("login, card", [("4970123456781234", True), ("4970 1234 5678 1234", True),
                                         ("4970-1234-5678-1234", True), ("376411112222331", True),
                                         ("5131123456781237", True), ("2221000000000009", True),
                                         ("4970123456781235", False),  # clé de contrôle fausse
                                         ("1234567890123", False),  # numéro fiscal
                                         ("185067512345678", False),  # numéro de sécurité sociale
                                         ("6011000990139424", False),  # réseau non reconnu
                                         ("48213377", False), ("jules@exemple.fr", False),
                                         ("4970 •••• 1234", False), ("", False)])
def test_looks_like_card(login, card):
    assert bc.looks_like_card(make_account("Carte", login=login)) is card


def test_conversion_cryptogramme_code_et_pierre_tombale():
    v = Vault(profiles=[Profile(id="p1", name="Jules")], accounts=[
        make_account("Carte Bleu Jules", "Banque", "4970 1234 5678 1234", "4321", profiles=["p1"], image="data:image/png;base64,x"),
        make_account("Carte Bleu Alexis", "Banque", "5131123456781237", "123", profiles=["p1"]),
        make_account("Carte Edenred", "Repas", "4970123456781242", "motdepasse", profiles=["p1"]),
        make_account("Boursorama", "Banque", "48213377", "Tr0mpette!", profiles=["p1"]),
    ])
    assert bc.convert_accounts(v, NOW) == 3
    assert [a.name for a in v.accounts] == ["Boursorama"]
    by_name = {b.name: b for b in v.bankcards}
    jules = by_name["Carte Bleu Jules"]
    assert (jules.id, jules.number, jules.pin, jules.cvv, jules.image, jules.profiles, jules.updated) == \
        ("carte bleu jules", "4970123456781234", "4321", "", "data:image/png;base64,x", ["p1"], NOW)
    assert (by_name["Carte Bleu Alexis"].cvv, by_name["Carte Bleu Alexis"].pin) == ("123", "")
    assert by_name["Carte Edenred"].pin == "motdepasse"
    assert sorted(t["id"] for t in v.deleted if t["kind"] == "account") == \
        ["carte bleu alexis", "carte bleu jules", "carte edenred"]
    assert bc.convert_accounts(v, NOW) == 0


# ---------- API ----------
def test_save_list_delete_bankcard(api_unlocked):
    saved = api_unlocked.save_bankcard(card_dict(expiry="1228"))
    assert saved["expiry"] == "12/28" and saved["number"] == "4970 1234 5678 1234"
    assert [b["name"] for b in api_unlocked.list_bankcards("p1")] == ["Boursorama"]
    assert api_unlocked.list_bankcards("p2") == []
    again = api_unlocked.save_bankcard({**saved, "holder": "  JULES   C. "})
    assert again["id"] == saved["id"] and again["holder"] == "JULES C."
    api_unlocked.delete_bankcard(saved["id"])
    assert api_unlocked.list_bankcards(None) == []
    assert {"kind": "bankcard", "id": saved["id"]}.items() <= api_unlocked._store.vault.deleted[-1].items()


def test_save_bankcard_controles(api_unlocked):
    with pytest.raises(ValueError):
        api_unlocked.save_bankcard(card_dict(name="  "))
    with pytest.raises(ValueError):
        api_unlocked.save_bankcard(card_dict(expiry="13/28"))
    with pytest.raises(ValueError):
        api_unlocked.save_bankcard(card_dict(profiles=[]))


def test_supprimer_profil_reattribue_les_cartes(api_unlocked):
    api_unlocked.save_bankcard(card_dict(profiles=["p2"]))
    api_unlocked.delete_profile("p2", "p1")
    assert api_unlocked.list_bankcards("p1")[0]["profiles"] == ["p1"]


def _vault_avec_carte_en_compte():
    v = sample_vault()
    v.accounts.append(make_account("Carte Bleu Jules", "Banque", "4970 1234 5678 1234", "4321",
                                   profiles=["p1"], created=T, updated=T))
    return v


def test_conversion_au_demarrage_une_seule_fois(tmp_path, fake_clip, clock, dialogs):
    VaultStore(tmp_path / "vault.json").save(_vault_avec_carte_en_compte())
    api = make_api(tmp_path, fake_clip, clock, dialogs)
    assert api.get_state()["converted_cards"] == 1
    assert api.get_state()["converted_cards"] == 0  # annoncé une seule fois
    assert [b["name"] for b in api.list_bankcards(None)] == ["Carte Bleu Jules"]
    assert "Carte Bleu Jules" not in [a["name"] for a in api.list_accounts(None)]
    assert api.list_backups()  # sauvegarde automatique avant la conversion
    # un compte-carte créé ensuite n'est plus converti (relance)
    api.save_account({"id": None, "name": "Autre carte", "login": "5131123456781237", "password": "1",
                      "profiles": ["p1"]})
    api = make_api(tmp_path, fake_clip, clock, dialogs)
    assert api.get_state()["converted_cards"] == 0
    assert "Autre carte" in [a["name"] for a in api.list_accounts(None)]


def test_conversion_au_deverrouillage(tmp_path, fake_clip, clock, dialogs):
    store = VaultStore(tmp_path / "vault.json")
    store.save(_vault_avec_carte_en_compte())
    api = make_api(tmp_path, fake_clip, clock, dialogs)
    api.get_state()
    api._store.vault.settings.pop("cards_converted")  # coffre d'avant la conversion, mais chiffré
    api._store.vault.bankcards.clear()
    api._store.vault.accounts = _vault_avec_carte_en_compte().accounts
    api.set_lock("pin", "123456")
    api = make_api(tmp_path, fake_clip, clock, dialogs)
    assert api.get_state()["converted_cards"] == 0  # verrouillé : rien de converti encore
    assert api.unlock("123456")["ok"] is True
    assert api.get_state()["converted_cards"] == 1


# ---------- fusion et synchro ----------
def _vault(bankcards=(), accounts=(), deleted=()):
    return Vault(profiles=[Profile(id="p1", name="Jules", updated=T)], accounts=list(accounts),
                 bankcards=list(bankcards), deleted=list(deleted))


def test_fusion_carte_ajoutee_sur_le_telephone():
    pc = _vault()
    phone = _vault([BankCard(id="b1", name="Boursorama", number="4970", profiles=["p1"], updated="2026-10-05T10:00:00")])
    r = merge(pc, phone, LS, NOW)
    assert [b.id for b in r.vault.bankcards] == ["b1"] and r.to_pc == 1


def test_fusion_conflit_garde_une_copie():
    pc = _vault([BankCard(id="b1", name="Bourso", pin="1111", profiles=["p1"], updated="2026-10-06T10:00:00")])
    phone = _vault([BankCard(id="b1", name="Bourso", pin="2222", profiles=["p1"], updated="2026-10-05T10:00:00")])
    r = merge(pc, phone, LS, NOW)
    assert sorted(b.pin for b in r.vault.bankcards) == ["1111", "2222"] and r.conflicts == 1


def test_fusion_conversion_retire_le_compte_du_telephone():
    phone_acc = Account(id="c1", name="Carte", login="4970123456781234", password="4321", profiles=["p1"],
                        created=T, updated=T)
    pc = _vault()
    pc.accounts = [phone_acc]
    bc.convert_accounts(pc, "2026-10-10T10:00:00")
    r = merge(pc, _vault(accounts=[phone_acc]), LS, NOW)
    assert r.vault.accounts == [] and [b.id for b in r.vault.bankcards] == ["c1"]


def test_validate_phone_vault_cartes_bancaires():
    d = {"profiles": [], "accounts": [], "giftcards": [], "deleted": [tombstone("bankcard", "b0", T)],
         "bankcards": [{"id": "b1", "name": "Boursorama", "holder": "J", "number": "4970", "expiry": "12/28",
                        "cvv": "123", "pin": "4321", "image": None, "profiles": ["p1"], "updated": T}]}
    v = validate_phone_vault(d)
    assert v.bankcards[0].name == "Boursorama"
    assert validate_phone_vault({k: x for k, x in d.items() if k != "bankcards"}).bankcards == []
    with pytest.raises(ValueError):
        validate_phone_vault({**d, "bankcards": [{**d["bankcards"][0], "cvv": 123}]})
    with pytest.raises(ValueError):
        validate_phone_vault({**d, "bankcards": [d["bankcards"][0], d["bankcards"][0]]})
