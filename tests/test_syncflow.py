import hashlib
import hmac
import json
from datetime import datetime, timedelta

import pytest

from app.lockout import Lockout
from app.model import Account, Vault
from app.store import VaultStore
from app.sync import b64u, unb64u
from app.syncflow import MAX_SKEW_SECONDS, SyncFlow, validate_phone_vault
from tests.conftest import sample_vault

CODE = "123456"
GEN = "gen-a"  # jeton de génération du coffre PC (aléatoire dans l'appli)
NOW = datetime(2026, 10, 19, 12, 0, 0)
QR_KEY = bytes(range(32))  # clé du QR de la session (aléatoire dans l'appli)
PAIR = b64u(bytes([7]) * 32)  # secret d'appairage de dev1 (Ruling 21)


def proof(pair, label, key=QR_KEY):
    return b64u(hmac.new(unb64u(pair), key + label, hashlib.sha256).digest())


def iso(dt):
    return dt.isoformat(timespec="seconds")


class Env:
    def __init__(self, tmp_path, encrypted=True):
        self.store = VaultStore(tmp_path / "vault.json")
        self.store.vault = sample_vault()
        # téléphone déjà appairé : dev1 est dans le registre des appareils
        self.store.vault.sync["devices"]["dev1"] = {"name": "Pixel", "last_sync": iso(NOW - timedelta(days=1)),
                                                     "pair": PAIR}
        if encrypted:
            self.store.set_lock(CODE)
        else:
            self.store.save(self.store.vault, backup=False)
        self.config = {"generation": GEN, "lock_mode": "pin", "pin_length": 6}
        self.t = 0.0
        self.lockout = Lockout(lambda: self.t)
        self.persisted = 0
        self.now = NOW

    def persist(self):
        self.persisted += 1

    def flow(self):
        return SyncFlow(self.store, self.lockout, self.persist, lambda: self.config, "PC-Jules",
                        now=lambda: self.now, qr_key=QR_KEY)


@pytest.fixture
def env(tmp_path):
    return Env(tmp_path)


def hello_msg(env=None, **kw):
    msg = {"type": "hello", "device_id": "dev1", "device_name": "Pixel", "generation": GEN,
           "last_sync": iso(NOW - timedelta(days=1)), "code_version": env.store.code_version() if env else "x",
           "has_data": True, "now": iso(NOW)}
    if env:
        msg["proof"] = proof(PAIR, b"pp-phone-hello")  # téléphone appairé
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
    env.config["generation"] = "gen-b"
    r = env.flow().handle(hello_msg(env))
    assert r["mode"] == "replace" and r["reason"] == "restored"
    # coffre remplacé : le registre restauré ne prouve plus rien, le code est exigé (Ruling 7)
    assert r["need_code"] is True and "code_version" not in r
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
    env.config["generation"] = "gen-b"
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
    assert r["synced_at"] == iso(NOW) and r["generation"] == GEN
    assert r["lock_mode"] == "pin" and r["pin_length"] == 6
    assert len(env.store.list_backups()) == 1
    reloaded = VaultStore(env.store.path)
    v = reloaded.load(CODE)
    assert "neuf" in [a.id for a in v.accounts]
    assert v.sync["devices"]["dev1"] == {"name": "Pixel", "last_sync": iso(NOW), "pair": PAIR}  # secret gardé
    assert "pair" not in r
    assert "neuf" in [a["id"] for a in r["vault"]["accounts"]]
    json.dumps(r)


def test_sync_replace_returns_pc_vault(env):
    env.config["generation"] = "gen-c"
    flow = env.flow()
    assert flow.handle(hello_msg(env))["mode"] == "replace"
    pv = phone_vault(accounts=[])
    assert flow.handle(sync_msg(replace=True, vault=pv))["error"] == "code_required"
    r = flow.handle(sync_msg(replace=True, vault=pv, code=CODE))
    assert r["ok"] is True and r["generation"] == "gen-c"
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


# ---------------------------------------------------------------- corrections (revue finale)
def test_no_change_syncs_add_no_backup_change_adds_one(env):  # Ruling 9
    for _ in range(5):
        r = known(env).handle(sync_msg())
        assert r["ok"] is True and r["summary"]["to_pc"] == 0
    assert env.store.list_backups() == []
    assert VaultStore(env.store.path).load(CODE).sync["devices"]["dev1"]["last_sync"] == iso(NOW)  # registre écrit
    pv = phone_vault()
    pv["accounts"][0]["password"] = "modifié sur le téléphone"
    pv["accounts"][0]["updated"] = iso(NOW)
    r = known(env).handle(sync_msg(vault=pv))
    assert r["ok"] is True and r["summary"]["to_pc"] == 1
    assert len(env.store.list_backups()) == 1


@pytest.mark.parametrize("gen", ["gen-b", None])
def test_generation_mismatch_needs_code_even_for_known_device(env, gen):  # Ruling 7
    flow = env.flow()
    r = flow.handle(hello_msg(env, generation=gen))
    assert r["ok"] and r["need_code"] is True and r["mode"] == "replace" and r["reason"] == "restored"
    assert flow.handle(sync_msg(replace=True))["error"] == "code_required"


def test_pc_without_generation_token_needs_code(env):
    env.config.pop("generation")  # config perdue : l'Api créera un nouveau jeton, jamais égal à celui du téléphone
    r = env.flow().handle(hello_msg(env))
    assert r["need_code"] is True and r["mode"] == "replace"


@pytest.mark.parametrize("gen", [0, 1, True, ["gen-a"]])
def test_generation_must_be_a_string(env, gen):
    assert env.flow().handle(hello_msg(env, generation=gen))["error"] == "invalid"


@pytest.mark.parametrize("raw, expected", [
    ("  Pixel 8  ", "Pixel 8"), ("", "Téléphone"), ("   ", "Téléphone"), ("x" * 100, "x" * 60),
])
def test_device_name_is_cleaned(env, raw, expected):
    flow = known(env) if raw == "  Pixel 8  " else env.flow()
    if raw != "  Pixel 8  ":
        assert flow.handle(hello_msg(env, device_name=raw))["ok"]
        assert flow.device_name == expected
    r = flow.handle(sync_msg(device_name=raw))
    assert r["ok"] is True and flow.device_name == expected
    assert VaultStore(env.store.path).load(CODE).sync["devices"]["dev1"]["name"] == expected


class _FailingSave:
    def __init__(self, store):
        self._store = store

    def __getattr__(self, name):
        return getattr(self._store, name)

    def save(self, vault, backup=True):
        raise OSError(28, "No space left on device", str(self._store.path))


def test_save_failure_is_reported(env):  # Minor 6
    flow = known(env)
    flow._store = _FailingSave(env.store)
    before = env.store.path.read_bytes()
    r = flow.handle(sync_msg())
    assert r["ok"] is False and r["error"] == "save_failed"
    assert r["message"].startswith("Impossible d'enregistrer les données reçues")
    assert str(env.store.path) not in r["message"] and CODE not in json.dumps(r) and "vault" not in r
    assert flow.summary is None
    assert env.store.path.read_bytes() == before


@pytest.mark.parametrize("mutate", [
    lambda d: d["profiles"][0].__setitem__("avatar", "http://exemple.fr/a.png"),
    lambda d: d["profiles"][0].__setitem__("avatar", 5),
    lambda d: d.__setitem__("deleted", [{"kind": "account", "id": "x", "at": iso(NOW), "extra": 1}]),
    lambda d: d["giftcards"][0].__setitem__("history",
                                            [{"id": "h", "date": "2026-10-01", "amount": 5, "note": "x"}]),
    lambda d: d["giftcards"][0].__setitem__("end_date", "31/12/2026"),
    lambda d: d["giftcards"][0].__setitem__("end_date", "2026-12-31T00:00:00"),
    lambda d: d["giftcards"][0].__setitem__("end_date", "2026-2-1"),
    lambda d: d["giftcards"][0].__setitem__("end_date", 20261231),
])
def test_validate_phone_vault_rejects_more(mutate):  # Minor 3
    d = _valid()
    mutate(d)
    with pytest.raises(ValueError):
        validate_phone_vault(d)


def test_validate_phone_vault_accepts_avatar_and_end_date():
    d = _valid()
    d["profiles"][0]["avatar"] = "data:image/png;base64,AAAA"
    d["profiles"][1]["avatar"] = None
    d["giftcards"][0]["end_date"] = "2026-12-31"
    v = validate_phone_vault(d)
    assert v.profiles[0].avatar.startswith("data:image/") and v.giftcards[0].end_date == "2026-12-31"
    d["giftcards"][0]["end_date"] = None
    assert validate_phone_vault(d).giftcards[0].end_date is None


# ---------------------------------------------------------------- appairage (Ruling 21)
def test_known_device_with_valid_proof_skips_code_and_gets_pc_proof(env):
    r = env.flow().handle(hello_msg(env))
    assert r["need_code"] is False and r["code_version"] == env.store.code_version()
    assert r["proof_pc"] == proof(PAIR, b"pp-pc-hello")
    assert PAIR not in json.dumps(r)


@pytest.mark.parametrize("bad", [None, "", "xx", proof(PAIR, b"pp-pc-hello"), proof(PAIR, b"pp-phone-hello", bytes(32)),
                                 proof(b64u(bytes(32)), b"pp-phone-hello")])
def test_missing_or_wrong_proof_needs_code(env, bad):
    msg = hello_msg(env, proof=bad)
    if bad is None:
        msg.pop("proof")
    r = env.flow().handle(msg)
    assert r["ok"] is True and r["need_code"] is True
    assert "code_version" not in r and "proof_pc" not in r


@pytest.mark.parametrize("bad", [5, ["x"], {"a": 1}])
def test_proof_must_be_a_string(env, bad):
    assert env.flow().handle(hello_msg(env, proof=bad))["error"] == "invalid"


def test_device_without_pair_needs_code_then_gets_one(env):
    del env.store.vault.sync["devices"]["dev1"]["pair"]  # téléphone d'avant l'appairage
    flow = env.flow()
    r = flow.handle(hello_msg(env))
    assert r["need_code"] is True and "proof_pc" not in r
    r = flow.handle(sync_msg(code=CODE))
    assert r["ok"] is True
    pair = r["pair"]
    assert isinstance(pair, str) and len(unb64u(pair)) == 32
    assert VaultStore(env.store.path).load(CODE).sync["devices"]["dev1"]["pair"] == pair
    # la synchro suivante (nouveau QR, nouvelle clé) se fait sans code avec la nouvelle preuve
    key2 = bytes(range(1, 33))
    flow2 = SyncFlow(env.store, env.lockout, env.persist, lambda: env.config, "PC-Jules", now=lambda: env.now,
                     qr_key=key2)
    r = flow2.handle(hello_msg(env, last_sync=iso(NOW), proof=proof(pair, b"pp-phone-hello", key2)))
    assert r["need_code"] is False and r["proof_pc"] == proof(pair, b"pp-pc-hello", key2)


def test_code_verified_sync_issues_fresh_pair(env):
    flow = env.flow()
    r = flow.handle(hello_msg(env, code_version="ancien"))  # code changé : preuve valide mais code exigé
    assert r["need_code"] is True and r["proof_pc"] == proof(PAIR, b"pp-pc-hello")
    r = flow.handle(sync_msg(code=CODE))
    assert r["ok"] is True and r["pair"] != PAIR and len(unb64u(r["pair"])) == 32
    assert VaultStore(env.store.path).load(CODE).sync["devices"]["dev1"]["pair"] == r["pair"]


def test_first_sync_issues_pair(env):
    flow = env.flow()
    flow.handle(hello_msg(device_id="neuf", code_version=None, has_data=False, last_sync=None, generation=None))
    r = flow.handle({k: v for k, v in sync_msg(device_id="neuf", replace=True, code=CODE, last_sync=None).items()
                     if k != "vault"})
    assert r["ok"] is True and len(unb64u(r["pair"])) == 32
    assert VaultStore(env.store.path).load(CODE).sync["devices"]["neuf"]["pair"] == r["pair"]


def test_restore_needs_code_even_with_valid_proof_then_new_pair(env):
    env.config["generation"] = "gen-restored"
    flow = env.flow()
    r = flow.handle(hello_msg(env))
    assert r["need_code"] is True and r["mode"] == "replace" and r["proof_pc"] == proof(PAIR, b"pp-pc-hello")
    r = flow.handle(sync_msg(replace=True, code=CODE))
    assert r["ok"] is True and r["pair"] != PAIR


def test_unknown_device_with_proof_of_other_device_needs_code(env):
    r = env.flow().handle(hello_msg(env, device_id="autre"))
    assert r["need_code"] is True and "proof_pc" not in r


def test_pc_without_qr_key_never_skips_code(env):
    flow = SyncFlow(env.store, env.lockout, env.persist, lambda: env.config, "PC-Jules", now=lambda: env.now,
                    qr_key=b"")
    r = flow.handle(hello_msg(env))
    assert r["need_code"] is True and "proof_pc" not in r
