"""Cartes fidélité : API, fusion et synchro."""
import pytest

from app.merge import merge
from app.model import LoyaltyCard, Profile, Vault, tombstone
from app.syncflow import validate_phone_vault

T = "2026-10-01T09:00:00"
LS = "2026-10-01T12:00:00"
NOW = "2026-10-19T12:00:00"


def test_cartes_fidelite_api(api_unlocked):
    c = api_unlocked.save_loyaltycard({"id": None, "name": " Leclerc ", "number": " 2912345678901 ", "pin": "",
                                       "image": None, "profiles": ["p1"]})
    assert (c["name"], c["number"], c["pin"]) == ("Leclerc", "2912345678901", "")
    vide = api_unlocked.save_loyaltycard({"name": "Fnac", "profiles": ["p2"]})  # identifiant et PIN facultatifs
    assert (vide["number"], vide["pin"]) == ("", "")
    assert [x["name"] for x in api_unlocked.list_loyaltycards(None)] == ["Fnac", "Leclerc"]
    assert [x["name"] for x in api_unlocked.list_loyaltycards("p1")] == ["Leclerc"]
    again = api_unlocked.save_loyaltycard({**c, "pin": "1234"})
    assert again["id"] == c["id"] and again["pin"] == "1234"
    with pytest.raises(ValueError):
        api_unlocked.save_loyaltycard({"name": " ", "profiles": ["p1"]})
    with pytest.raises(ValueError):
        api_unlocked.save_loyaltycard({"name": "Fnac", "profiles": []})
    api_unlocked.delete_profile("p2", "p1")
    assert len(api_unlocked.list_loyaltycards("p1")) == 2
    api_unlocked.delete_loyaltycard(c["id"])
    assert [x["name"] for x in api_unlocked.list_loyaltycards(None)] == ["Fnac"]
    assert api_unlocked._store.vault.deleted[-1]["kind"] == "loyaltycard"


def test_cartes_fidelite_fusion_et_synchro():
    pc = Vault(profiles=[Profile(id="p1", name="Jules", updated=T)],
               loyaltycards=[LoyaltyCard(id="l1", name="Leclerc", number="1", profiles=["p1"], updated=T)])
    phone = Vault.from_dict(pc.to_dict())
    phone.loyaltycards = [LoyaltyCard(id="l2", name="Fnac", pin="12", profiles=["p1"], updated="2026-10-05T10:00:00")]
    phone.deleted.append(tombstone("loyaltycard", "l1", "2026-10-05T10:00:00"))
    r = merge(pc, phone, LS, NOW)
    assert [c.id for c in r.vault.loyaltycards] == ["l2"] and r.deleted == 1 and r.to_pc == 2

    d = phone.to_dict()
    assert validate_phone_vault(d).loyaltycards[0].name == "Fnac"
    assert validate_phone_vault({k: x for k, x in d.items() if k != "loyaltycards"}).loyaltycards == []
    with pytest.raises(ValueError):
        validate_phone_vault({**d, "loyaltycards": [{**d["loyaltycards"][0], "pin": 12}]})
    with pytest.raises(ValueError):
        validate_phone_vault({**d, "loyaltycards": [d["loyaltycards"][0], d["loyaltycards"][0]]})
