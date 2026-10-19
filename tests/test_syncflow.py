import json
from datetime import datetime, timedelta

import pytest

from app.lockout import Lockout
from app.model import Account, Vault
from app.store import VaultStore
from app.syncflow import MAX_SKEW_SECONDS, SyncFlow, validate_phone_vault
from tests.conftest import sample_vault

CODE = "123456"
NOW = datetime(2026, 10, 19, 12, 0, 0)


def iso(dt):
    return dt.isoformat(timespec="seconds")


class Env:
    def __init__(self, tmp_path, encrypted=True):
        self.store = VaultStore(tmp_path / "vault.json")
        self.store.vault = sample_vault()
        # téléphone déjà appairé : dev1 est dans le registre des appareils
        self.store.vault.sync["devices"]["dev1"] = {"name": "Pixel", "last_sync": iso(NOW - timedelta(days=1))}
        if encrypted:
            self.store.set_lock(CODE)
        else:
            self.store.save(self.store.vault, backup=False)
        self.config = {"generation": 0, "lock_mode": "pin", "pin_length": 6}
        self.t = 0.0
        self.lockout = Lockout(lambda: self.t)
        self.persisted = 0
        self.now = NOW

    def persist(self):
        self.persisted += 1

    def flow(self):
        return SyncFlow(self.store, self.lockout, self.persist, lambda: self.config, "PC-Jules",
                        now=lambda: self.now)


@pytest.fixture
def env(tmp_path):
    return Env(tmp_path)


def hello_msg(env=None, **kw):
    msg = {"type": "hello", "device_id": "dev1", "device_name": "Pixel", "generation": 0,
           "last_sync": iso(NOW - timedelta(days=1)), "code_version": env.store.code_version() if env else "x",
           "has_data": True, "now": iso(NOW)}
    msg.update(kw)
    return msg


def phone_vault(**kw):
    d = {k: v for k, v in sample_vault().to_dict().items() if k in ("profiles", "accounts", "giftcards", "deleted")}
    d.update(kw)
    return d


def sync_msg(**kw):
    msg = {"type": "sync", "device_id": "dev1", "device_name": "Pixel", "code": None, "replace": False,
           "vault": phone_vault(), "last_sync": iso(NOW - timedelta(days=1)), "now": iso(NOW)}
    msg.update(kw)
    return msg


def known(env):
    """Flux après un hello d'un téléphone déjà appairé (mode merge, pas de code)."""
    flow = env.flow()
    r = flow.handle(hello_msg(env))
    assert r["ok"] and r["mode"] == "merge" and not r["need_code"]
    return flow


# ---------------------------------------------------------------- store
def test_verify_code_and_code_version(env):
    assert env.store.verify_code(CODE)
    assert not env.store.verify_code("000000")
    v = env.store.code_version()
    assert isinstance(v, str) and len(v) == 16 and CODE not in v
    env.store.set_lock("654321")
    assert env.store.code_version() != v


# ---------------------------------------------------------------- hello
def test_hello_first_sync_needs_code_and_replace(env):
    r = env.flow().handle(hello_msg(device_id="neuf", code_version=None, has_data=False, last_sync=None,
                                    generation=None))
    assert r["ok"] is True
    assert r["need_code"] is True and r["mode"] == "replace" and r["reason"] == "first"
    assert r["pc"] == "PC-Jules" and r["lock_mode"] == "pin" and r["pin_length"] == 6
    assert "code_version" not in r


def test_hello_known_device_merges(env):
    r = env.flow().handle(hello_msg(env))
    assert r["ok"] and r["mode"] == "merge" and r["reason"] is None and r["need_code"] is False
    assert r["code_version"] == env.store.code_version()


def test_hello_after_restore_is_replace_restored(env):
    env.config["generation"] = 1
    r = env.flow().handle(hello_msg(env))
    assert r["mode"] == "replace" and r["reason"] == "restored"
    assert r["since"] == iso(NOW - timedelta(days=1))


def test_hello_stale_after_180_days(env):
    r = env.flow().handle(hello_msg(env, last_sync=iso(NOW - timedelta(days=181))))
    assert r["mode"] == "replace" and r["reason"] == "stale"
    r = env.flow().handle(hello_msg(env, last_sync=None))
    assert r["mode"] == "replace" and r["reason"] == "stale"
    r = env.flow().handle(hello_msg(env, last_sync=iso(NOW - timedelta(days=179))))
    assert r["mode"] == "merge"


def test_hello_rejects_clock_skew(env):
    r = env.flow().handle(hello_msg(env, now=iso(NOW + timedelta(minutes=6))))
    assert r["ok"] is False and r["error"] == "clock"
    assert "6 min" in r["message"] and "heure automatique" in r["message"]
    r = env.flow().handle(hello_msg(env, now=iso(NOW - timedelta(seconds=MAX_SKEW_SECONDS - 10))))
    assert r["ok"] is True


def test_hello_requires_pc_lock(tmp_path):
    env = Env(tmp_path, encrypted=False)
    r = env.flow().handle(hello_msg(code_version="x"))
    assert r == {"ok": False, "error": "no_lock", "message": r["message"]} and r["message"]


def test_hello_invalid_message(env):
    for bad in (hello_msg(env, device_id=""), hello_msg(env, now="hier"), hello_msg(env, last_sync=5),
                {"type": "bonjour"}, {"type": "hello"}):
        r = env.flow().handle(bad)
        assert r["ok"] is False and r["error"] == "invalid"


# ---------------------------------------------------------------- sync
def test_sync_without_hello_is_invalid(env):
    r = env.flow().handle(sync_msg())
    assert r["ok"] is False and r["error"] == "invalid"


def test_sync_must_follow_hello_mode(env):
    flow = known(env)
    assert flow.handle(sync_msg(replace=True))["error"] == "invalid"
    env.config["generation"] = 1
    flow = env.flow()
    assert flow.handle(hello_msg(env))["mode"] == "replace"
    assert flow.handle(sync_msg(replace=False))["error"] == "invalid"


def test_sync_rejects_clock_skew(env):
    flow = known(env)
    r = flow.handle(sync_msg(now=iso(NOW - timedelta(minutes=10))))
    assert r["ok"] is False and r["error"] == "clock"


def test_sync_requires_code_when_needed(env):
    flow = env.flow()
    assert flow.handle(hello_msg(env, code_version="ancien"))["need_code"]
    r = flow.handle(sync_msg())
    assert r["ok"] is False and r["error"] == "code_required"


def test_sync_bad_code_counts_in_lockout(env):
    flow = env.flow()
    flow.handle(hello_msg(env, code_version="ancien"))
    before = env.store.path.read_bytes()
    r = flow.handle(sync_msg(code="000000"))
    assert r["ok"] is False and r["error"] == "bad_code" and r["wait_seconds"] > 0
    assert CODE not in json.dumps(r) and "000000" not in json.dumps(r)
    assert env.persisted == 1
    r = flow.handle(sync_msg(code=CODE))  # 2e essai immédiat : refusé même avec le bon code
    assert r["error"] == "bad_code" and r["wait_seconds"] > 0
    assert env.store.path.read_bytes() == before
    env.t += 10
    r = flow.handle(sync_msg(code=CODE))
    assert r["ok"] is True and r["code_version"] == env.store.code_version()
    assert env.lockout.wait_seconds() == 0


def test_sync_merges_saves_backup_registers_device(env):
    flow = known(env)
    assert env.store.list_backups() == []
    pv = phone_vault()
    pv["accounts"].append(Account(id="neuf", name="Nouveau", password="s3cret", profiles=["p1"],
                                  updated=iso(NOW)).__dict__)
    r = flow.handle(sync_msg(vault=pv))
    assert r["ok"] is True
    assert r["summary"] == {"to_pc": 1, "to_phone": 0, "deleted": 0, "conflicts": 0}
    assert flow.summary == r["summary"] and flow.device_name == "Pixel"
    assert r["synced_at"] == iso(NOW) and r["generation"] == 0
    assert r["lock_mode"] == "pin" and r["pin_length"] == 6
    assert len(env.store.list_backups()) == 1
    reloaded = VaultStore(env.store.path)
    v = reloaded.load(CODE)
    assert "neuf" in [a.id for a in v.accounts]
    assert v.sync["devices"]["dev1"] == {"name": "Pixel", "last_sync": iso(NOW)}
    assert "neuf" in [a["id"] for a in r["vault"]["accounts"]]
    json.dumps(r)


def test_sync_replace_returns_pc_vault(env):
    env.config["generation"] = 2
    flow = env.flow()
    assert flow.handle(hello_msg(env))["mode"] == "replace"
    pv = phone_vault(accounts=[])
    r = flow.handle(sync_msg(replace=True, vault=pv))
    assert r["ok"] is True and r["generation"] == 2
    expected = sample_vault().to_dict()
    assert r["vault"]["accounts"] == expected["accounts"]
    assert r["vault"]["giftcards"] == expected["giftcards"]
    v = VaultStore(env.store.path).load(CODE)
    assert [a.id for a in v.accounts] == [a["id"] for a in expected["accounts"]]
    assert v.sync["devices"]["dev1"]["name"] == "Pixel"
    assert env.store.list_backups() == []  # rien d'enregistré sauf le registre : pas de sauvegarde


def test_sync_replace_without_vault(env):
    flow = env.flow()
    flow.handle(hello_msg(device_id="neuf", code_version=None, has_data=False, last_sync=None, generation=None))
    r = flow.handle({k: v for k, v in sync_msg(device_id="neuf", replace=True, code=CODE, last_sync=None).items()
                     if k != "vault"})
    assert r["ok"] is True and len(r["vault"]["accounts"]) == 2
    assert r["code_version"] == env.store.code_version()
    assert "neuf" in VaultStore(env.store.path).load(CODE).sync["devices"]


def test_sync_response_has_no_settings_or_sync(env):
    r = known(env).handle(sync_msg())
    assert r["ok"] is True
    assert "settings" not in r["vault"] and "sync" not in r["vault"]
    assert set(r["vault"]) >= {"profiles", "accounts", "giftcards", "deleted"}


def test_sync_invalid_payload_leaves_pc_untouched(env):
    flow = known(env)
    before = env.store.path.read_bytes()
    for bad in ({"accounts": [{"id": 3}]}, {"accounts": "x"}, {"giftcards": [{"id": "g", "name": "x", "remaining": -1}]}):
        r = flow.handle(sync_msg(vault=bad))
        assert r["ok"] is False and r["error"] == "invalid"
    assert env.store.path.read_bytes() == before


def test_sync_when_pc_locked(env):
    flow = known(env)
    env.store.forget_key()
    r = flow.handle(sync_msg())
    assert r["ok"] is False and r["error"] == "locked"


def test_hello_when_pc_locked(env):
    env.store.forget_key()
    r = env.flow().handle(hello_msg(code_version="x"))
    assert r["ok"] is False and r["error"] == "locked"


def test_cancel_replies_ok(env):
    assert env.flow().handle({"type": "cancel"}) == {"ok": True}


# ---------------------------------------------------------------- validate_phone_vault
def _valid():
    return phone_vault()


@pytest.mark.parametrize("mutate", [
    lambda d: d.pop("profiles"),
    lambda d: d.__setitem__("profiles", ["p1"]),
    lambda d: d["profiles"][0].__setitem__("name", ""),
    lambda d: d["accounts"][0].__setitem__("profiles", [1]),
    lambda d: d["accounts"][0].__setitem__("password", None),
    lambda d: d["accounts"][0].__setitem__("image", "http://exemple.fr/x.png"),
    lambda d: d["accounts"][0].__setitem__("favorite", "oui"),
    lambda d: d["accounts"][0].pop("updated"),
    lambda d: d["accounts"].append(dict(d["accounts"][0])),  # id en double
    lambda d: d["giftcards"][0].__setitem__("remaining", "50"),
    lambda d: d["giftcards"][0].__setitem__("remaining", float("nan")),
    lambda d: d["giftcards"][0].__setitem__("initial", -5),
    lambda d: d["giftcards"][0].__setitem__("history", [{"id": "h", "date": "2026-10-01", "amount": 0}]),
    lambda d: d["giftcards"][0].__setitem__("history", [{"date": "2026-10-01", "amount": 5}]),
    lambda d: d["giftcards"][0].__setitem__("history", ["x"]),
    lambda d: d.__setitem__("deleted", [{"kind": "chat", "id": "x", "at": iso(NOW)}]),
    lambda d: d.__setitem__("deleted", [{"kind": "account", "id": "x", "at": "pas une date"}]),
])
def test_validate_phone_vault_rejects(mutate):
    d = _valid()
    mutate(d)
    with pytest.raises(ValueError):
        validate_phone_vault(d)


def test_validate_phone_vault_accepts():
    d = _valid()
    d["accounts"][0]["image"] = "data:image/png;base64,AAAA"
    d["giftcards"][0]["history"] = [{"id": "h1", "date": "2026-10-01", "amount": 5}]
    d["deleted"] = [{"kind": "account", "id": "x", "at": iso(NOW)}]
    v = validate_phone_vault(d)
    assert isinstance(v, Vault) and len(v.accounts) == 2 and v.giftcards[0].history[0]["id"] == "h1"
    assert validate_phone_vault(d) is not None and d["accounts"][0]["image"].startswith("data:")


# ---------------------------------------------------------------- corrections (revue)
def test_second_hello_rejected(env):
    flow = known(env)
    r = flow.handle(hello_msg(env))
    assert r["ok"] is False and r["error"] == "invalid"


def test_hello_hides_code_version_when_code_needed(env):
    r = env.flow().handle(hello_msg(code_version=None))
    assert r["ok"] is True and r["need_code"] is True and "code_version" not in r
    assert env.store.code_version() not in json.dumps(r)


def test_unknown_device_needs_code_even_with_right_code_version(env):
    r = env.flow().handle(hello_msg(env, device_id="oublie"))  # bonne version du code, appareil oublié
    assert r["need_code"] is True and "code_version" not in r


@pytest.mark.parametrize("device_id", ["dev1", "inconnu"])
def test_bypass_attempt_without_code_fails(env, device_id):
    before = env.store.path.read_bytes()
    flow = env.flow()
    r = flow.handle(hello_msg(device_id=device_id, code_version=None))
    assert r["need_code"] is True and "code_version" not in r
    r = flow.handle(hello_msg(device_id=device_id, code_version=env.store.code_version()))
    assert r["ok"] is False and r["error"] == "invalid"
    for msg in (sync_msg(device_id=device_id, replace=True, code=None),
                sync_msg(device_id=device_id, replace=False, code=None)):
        r = flow.handle(msg)
        assert r["ok"] is False and r["error"] in ("invalid", "code_required")
        assert "vault" not in r
    assert env.store.path.read_bytes() == before


def test_huge_amount_is_invalid(env):
    flow = known(env)
    before = env.store.path.read_bytes()
    for mutate in (lambda g: g.__setitem__("remaining", 10**400),
                   lambda g: g.__setitem__("history", [{"id": "h", "date": "2026-10-01", "amount": 10**400}])):
        pv = phone_vault()
        mutate(pv["giftcards"][0])
        r = flow.handle(sync_msg(vault=pv))
        assert r["ok"] is False and r["error"] == "invalid"
    assert env.store.path.read_bytes() == before


BAD_DATES = ["20261019", "2026-W42-1", "2026-10-19", "2026-10-19 12:00:00", "2026-10-19T12:00:00.123456",
             "2026-10-19T12:00", "2026-10-19T12:00:00+00:00"]


@pytest.mark.parametrize("bad", BAD_DATES)
def test_non_canonical_dates_invalid(env, bad):
    flow = known(env)
    before = env.store.path.read_bytes()
    pv = phone_vault()
    pv["accounts"][0]["updated"] = bad
    assert flow.handle(sync_msg(vault=pv))["error"] == "invalid"
    pv = phone_vault(deleted=[{"kind": "account", "id": "x", "at": bad}])
    assert flow.handle(sync_msg(vault=pv))["error"] == "invalid"
    assert flow.handle(sync_msg(now=bad))["error"] == "invalid"
    assert flow.handle(sync_msg(last_sync=bad))["error"] == "invalid"
    assert env.store.path.read_bytes() == before
    assert env.flow().handle(hello_msg(env, now=bad))["error"] == "invalid"
    assert env.flow().handle(hello_msg(env, last_sync=bad))["error"] == "invalid"


@pytest.mark.parametrize("bad", ["2026-10-1", "20261001", "2026-10-01T00:00:00", 20261001])
def test_non_canonical_history_date_invalid(bad):
    d = phone_vault()
    d["giftcards"][0]["history"] = [{"id": "h", "date": bad, "amount": 5}]
    with pytest.raises(ValueError):
        validate_phone_vault(d)


def test_last_sync_must_match_hello(env):
    flow = known(env)
    before = env.store.path.read_bytes()
    for other in (iso(NOW - timedelta(days=2)), None):
        r = flow.handle(sync_msg(last_sync=other))
        assert r["ok"] is False and r["error"] == "invalid"
    assert env.store.path.read_bytes() == before
    assert flow.handle(sync_msg())["ok"] is True
