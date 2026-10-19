"""Modèle prêt pour la synchro : horodatages, pierres tombales, ids d'historique, génération."""
import json
from datetime import date

from app import giftcards as gc_logic
from app.model import GiftCard, Vault, tombstone

PNG = "data:image/png;base64,AAAA"
PNG2 = "data:image/png;base64,BBBB"


def test_old_vault_loads_with_defaults():
    v = Vault.from_dict({"profiles": [{"id": "p1", "name": "Jules"}], "accounts": [],
                         "giftcards": [{"id": "g1", "name": "Fnac", "history": [{"date": "2026-01-02", "amount": 5}]}]})
    assert v.deleted == [] and v.sync == {"devices": {}}
    assert v.giftcards[0].history[0]["id"] == "legacy-0"
    assert v.profiles[0].updated and v.giftcards[0].updated


def test_roundtrip_keeps_deleted_and_sync():
    v = Vault()
    v.deleted.append(tombstone("account", "a1", "2026-10-19T10:00:00"))
    v.sync = {"devices": {"tel": {"last": "2026-10-19T10:00:00"}}}
    v2 = Vault.from_dict(v.to_dict())
    assert v2.deleted == [{"kind": "account", "id": "a1", "at": "2026-10-19T10:00:00"}]
    assert v2.sync == {"devices": {"tel": {"last": "2026-10-19T10:00:00"}}}


def test_spend_gives_history_id():
    card = gc_logic.spend(GiftCard(id="g", name="x", remaining=10), 3, date(2026, 10, 19))
    assert card.history[-1]["id"] and card.history[-1]["amount"] == 3.0


def _stale(api, kind, item_id):
    """Met un horodatage ancien sur un élément pour détecter sa mise à jour."""
    v = api._vault()
    item = next(i for i in getattr(v, kind) if i.id == item_id)
    item.updated = "2000-01-01T00:00:00"
    return item


def test_delete_account_adds_tombstone(api_unlocked):
    aid = api_unlocked.list_accounts(None)[0]["id"]
    api_unlocked.delete_account(aid)
    t = api_unlocked._vault().deleted[-1]
    assert t["kind"] == "account" and t["id"] == aid and t["at"]


def test_delete_giftcard_adds_tombstone(api_unlocked):
    api_unlocked.delete_giftcard("g1")
    t = api_unlocked._vault().deleted[-1]
    assert t["kind"] == "giftcard" and t["id"] == "g1" and t["at"]


def test_delete_profile_adds_tombstone_and_touches_reassigned(api_unlocked):
    v = api_unlocked._vault()
    solo = next(a for a in v.accounts if a.profiles == ["p1"])
    _stale(api_unlocked, "accounts", solo.id)
    _stale(api_unlocked, "giftcards", "g1")
    api_unlocked.delete_profile("p1", "p2")
    v = api_unlocked._vault()
    t = v.deleted[-1]
    assert t["kind"] == "profile" and t["id"] == "p1" and t["at"]
    assert next(a for a in v.accounts if a.id == solo.id).updated > "2000-01-01T00:00:00"
    assert v.giftcards[0].updated > "2000-01-01T00:00:00"


def test_save_giftcard_and_spend_update_timestamp(api_unlocked):
    _stale(api_unlocked, "giftcards", "g1")
    api_unlocked.save_giftcard({"id": "g1", "name": "Fnac", "remaining": 40, "profiles": ["p1"]})
    assert api_unlocked._vault().giftcards[0].updated > "2000-01-01T00:00:00"
    _stale(api_unlocked, "giftcards", "g1")
    api_unlocked.spend("g1", 5)
    card = api_unlocked._vault().giftcards[0]
    assert card.updated > "2000-01-01T00:00:00" and card.history[-1]["id"]


def test_save_profile_updates_timestamp(api_unlocked):
    _stale(api_unlocked, "profiles", "p1")
    api_unlocked.save_profile({"id": "p1", "name": "Jules B"})
    assert api_unlocked._vault().profiles[0].updated > "2000-01-01T00:00:00"


def test_set_and_replace_images_update_timestamp(api_unlocked):
    aid = api_unlocked._vault().accounts[0].id
    _stale(api_unlocked, "accounts", aid)
    _stale(api_unlocked, "giftcards", "g1")
    api_unlocked.set_images({aid: PNG}, {"g1": PNG})
    v = api_unlocked._vault()
    assert v.accounts[0].updated > "2000-01-01T00:00:00" and v.giftcards[0].updated > "2000-01-01T00:00:00"
    _stale(api_unlocked, "accounts", aid)
    _stale(api_unlocked, "giftcards", "g1")
    api_unlocked.replace_images({aid: [PNG, PNG2]}, {"g1": [PNG, PNG2]})
    v = api_unlocked._vault()
    assert v.accounts[0].updated > "2000-01-01T00:00:00" and v.giftcards[0].updated > "2000-01-01T00:00:00"


def test_restore_backup_increments_generation(tmp_path, api_unlocked, fake_clip, clock, dialogs):
    cfg = tmp_path / "config.json"
    assert api_unlocked._config.get("generation", 0) == 0
    api_unlocked.save_account({"name": "X", "profiles": ["p1"]})  # crée une sauvegarde
    name = api_unlocked.list_backups()[0]["name"]
    api_unlocked.restore_backup(name)
    assert json.loads(cfg.read_text(encoding="utf-8"))["generation"] == 1
    api_unlocked.restore_backup(api_unlocked.list_backups()[0]["name"])  # la restauration échange les versions
    assert json.loads(cfg.read_text(encoding="utf-8"))["generation"] == 2
