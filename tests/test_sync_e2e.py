"""Synchro de bout en bout : vraie Api, vrai SyncServer sur 127.0.0.1, coffre chiffré, faux téléphone en HTTP."""
import hashlib
import os
import threading
import urllib.error
import urllib.request
from datetime import datetime, timedelta

import pytest

from app import api as api_mod
from app import apk as apk_mod
from app.api import Api
from app.store import VaultStore
from app.sync import AAD_REQ, AAD_RESP, SyncServer, open_sealed, seal, unb64u
from app.syncflow import PROOF_PC, PROOF_PHONE, pair_proof
from app.version import VERSION

CODE = "123456"
NEW_CODE = "987654"
_VAULT_KEYS = ("profiles", "accounts", "giftcards", "deleted")


class FastServer(SyncServer):
    """Vrai SyncServer sur 127.0.0.1, boucle interrogée toutes les 10 ms (arrêt rapide, test rapide)."""

    def __init__(self, session):
        super().__init__(session, host="127.0.0.1")

    def start(self):
        self._thread = threading.Thread(target=self._httpd.serve_forever, kwargs={"poll_interval": 0.01},
                                        daemon=True)
        self._thread.start()


def _iso(dt):
    return dt.isoformat(timespec="seconds")


class Phone:
    """Faux téléphone : mémorise le coffre et les métadonnées de synchro comme le ferait l'appli."""

    def __init__(self, pc, device_id, name):
        self.pc, self.device_id, self.name = pc, device_id, name
        self.meta = {"generation": None, "last_sync": None, "code_version": None}
        self.vault = None
        self.pair = None  # secret d'appairage reçu à la 1re synchro avec code (Ruling 21)
        self.app_version = VERSION

    def _post(self, msg):
        p = self.pc.qr[-1]
        key = unb64u(p["key"])
        req = urllib.request.Request(f"http://127.0.0.1:{p['port']}/pp-sync", data=seal(key, msg, AAD_REQ),
                                     method="POST")
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return open_sealed(key, r.read(), AAD_RESP)[0]
        except urllib.error.HTTPError as e:
            return {"http": e.code}
        except urllib.error.URLError:
            return {"http": None}  # serveur arrêté

    def hello(self):
        msg = {"type": "hello", "device_id": self.device_id, "device_name": self.name, **self.meta,
               "has_data": self.vault is not None, "now": _iso(datetime.now()), "app_version": self.app_version}
        key = unb64u(self.pc.qr[-1]["key"])
        if self.pair:
            msg["proof"] = pair_proof(self.pair, key, PROOF_PHONE)
        h = self._post(msg)
        if self.pair and h.get("ok"):
            # le téléphone appairé refuse un PC qui ne prouve pas détenir le secret
            assert h.get("proof_pc") == pair_proof(self.pair, key, PROOF_PC), h
        return h

    def sync(self, code=None):
        """Scanne un nouveau QR (sync_start) puis hello + sync ; renvoie (réponse hello, réponse sync)."""
        self.pc.api.sync_start()
        try:
            h = self.hello()
            assert h.get("ok"), h
            msg = {"type": "sync", "device_id": self.device_id, "device_name": self.name,
                   "replace": h["mode"] == "replace", "last_sync": self.meta["last_sync"],
                   "now": _iso(datetime.now()), "code": code}
            if h["mode"] != "replace":
                msg["vault"] = {k: self.vault[k] for k in _VAULT_KEYS}
            r = self._post(msg)
            if r.get("ok"):
                self.pair = r.get("pair") or self.pair
                self.vault = r["vault"]
                self.meta = {"generation": r["generation"], "last_sync": r["synced_at"],
                             "code_version": r["code_version"]}
            return h, r
        finally:
            self.pc.api.sync_stop()

    def stamp(self):
        """Contrat d'horodatage (Ruling 8) : max(maintenant, last_sync + 1 s)."""
        ls = datetime.fromisoformat(self.meta["last_sync"])
        return _iso(max(datetime.now().replace(microsecond=0), ls + timedelta(seconds=1)))


class PC:
    def __init__(self, tmp_path, fake_clip, clock, dialogs, monkeypatch):
        self.qr = []
        self.clock = clock

        def fake_qr(payload):
            self.qr.append(payload)
            return "<svg/>"
        monkeypatch.setattr(api_mod, "qr_svg", fake_qr)
        self.api = Api(VaultStore(tmp_path / "vault.json"), fake_clip, clock=clock, wall_clock=clock,
                       dialogs=dialogs, schedule=lambda s, f: None,
                       sync_server=FastServer,
                       sync_hosts=lambda: ["127.0.0.1"])
        self.api.start_empty("Jules")
        pid = self.api.get_state()["profiles"][0]["id"]
        self.api.save_account({"name": "Netflix", "login": "jules", "password": "pw-pc", "profiles": [pid]})
        self.api.set_lock("pin", CODE)

    def account(self, name):
        return next(a for a in self.api.list_accounts(None) if a["name"] == name)


@pytest.fixture
def pc(tmp_path, fake_clip, clock, dialogs, monkeypatch):
    p = PC(tmp_path, fake_clip, clock, dialogs, monkeypatch)
    yield p
    p.api.sync_stop()


def test_sync_end_to_end(pc):
    api = pc.api
    phone = Phone(pc, "dev-a", "Pixel A")

    # 1. première synchro : code exigé, mauvais code refusé, puis bon code (après le délai anti-essais)
    h, r = phone.sync()
    assert h["need_code"] and h["mode"] == "replace" and h["reason"] == "first" and "code_version" not in h
    assert r["error"] == "code_required"
    h, r = phone.sync("000000")
    assert r["error"] == "bad_code" and r["wait_seconds"] > 0
    pc.clock.advance(r["wait_seconds"] + 1)
    h, r = phone.sync(CODE)
    assert r["ok"], r
    assert [a["name"] for a in phone.vault["accounts"]] == ["Netflix"]
    assert isinstance(r["generation"], str) and r["generation"]
    assert api.sync_status()["state"] == "closed"  # arrêtée par sync_stop
    assert [d["id"] for d in api.list_devices()] == ["dev-a"]

    # 2. modification sur le téléphone → fusion sans code, une sauvegarde
    backups = len(api.list_backups())
    acc = phone.vault["accounts"][0]
    acc["password"], acc["updated"] = "pw-phone", phone.stamp()
    h, r = phone.sync()
    assert h["mode"] == "merge" and h["need_code"] is False
    assert r["ok"] and r["summary"]["to_pc"] == 1
    assert pc.account("Netflix")["password"] == "pw-phone"
    assert len(api.list_backups()) == backups + 1

    # 3. synchro sans changement : pas de nouvelle sauvegarde (Ruling 9)
    h, r = phone.sync()
    assert r["ok"] and r["summary"]["to_pc"] == 0
    assert len(api.list_backups()) == backups + 1

    # 4. code du PC changé → le code est redemandé (fusion conservée)
    api.set_lock("pin", NEW_CODE)
    h, r = phone.sync()
    assert h["need_code"] is True and h["mode"] == "merge" and r["error"] == "code_required"
    h, r = phone.sync(NEW_CODE)
    assert r["ok"] and phone.meta["code_version"] == r["code_version"]
    h, r = phone.sync()
    assert h["need_code"] is False

    # 5. restauration d'une sauvegarde → remplacement du coffre du téléphone et code redemandé (Ruling 7)
    old_generation = phone.meta["generation"]
    api.restore_backup(api.list_backups()[0]["name"])
    if api.get_state()["locked"]:
        assert api.unlock(NEW_CODE)["ok"]
    # le registre restauré date d'avant le ré-appairage de l'étape 4 : son secret est l'ancien, le PC ne
    # prouve plus rien et le téléphone refuse ; « Ré-appairer » (secret local oublié) puis code
    with pytest.raises(AssertionError):
        phone.sync()
    old_pair, phone.pair = phone.pair, None
    h, r = phone.sync()
    assert h["mode"] == "replace" and h["reason"] == "restored" and h["need_code"] is True
    assert r["error"] == "code_required"
    h, r = phone.sync(NEW_CODE)
    assert r["ok"] and r["generation"] != old_generation and r["pair"] != old_pair  # nouveau secret
    assert phone.vault["accounts"] == [dict(a) for a in r["vault"]["accounts"]]
    h, r = phone.sync()
    assert h["mode"] == "merge" and h["need_code"] is False

    # 6. téléphone oublié → secret effacé sur le PC : le PC ne prouve plus rien, le téléphone refuse ;
    # « Ré-appairer » (secret local oublié) → code redemandé, nouveau secret
    api.forget_device("dev-a")
    with pytest.raises(AssertionError):
        phone.sync()
    phone.pair = None
    h, r = phone.sync()
    assert h["need_code"] is True and "proof_pc" not in h and r["error"] == "code_required"
    h, r = phone.sync(NEW_CODE)
    assert r["ok"] and r["pair"]
    h, r = phone.sync()
    assert h["need_code"] is False and "pair" not in r

    # 7. deuxième téléphone : première synchro avec code, il reçoit la modification du premier
    phone_b = Phone(pc, "dev-b", "Pixel B")
    h, r = phone_b.sync(NEW_CODE)
    assert r["ok"] and h["reason"] == "first"
    assert {d["id"] for d in api.list_devices()} == {"dev-a", "dev-b"}
    assert [a["name"] for a in phone_b.vault["accounts"]] == [a["name"] for a in phone.vault["accounts"]]


def test_device_id_alone_no_longer_skips_code(pc):
    """Ruling 21 : un faux téléphone qui a récolté le device_id (envoyé à tout QR) n'évite pas le code."""
    phone = Phone(pc, "dev-a", "Pixel A")
    h, r = phone.sync(CODE)
    assert r["ok"]
    thief = Phone(pc, "dev-a", "Voleur")
    thief.meta, thief.vault = dict(phone.meta), phone.vault
    h, r = thief.sync()
    assert h["need_code"] is True and "code_version" not in h and "proof_pc" not in h
    assert r["error"] == "code_required" and "vault" not in r


def test_session_is_single_use_over_http(pc):
    phone = Phone(pc, "dev-a", "Pixel A")
    pc.api.sync_start()
    assert phone.hello()["ok"]
    r = phone._post({"type": "sync", "device_id": "dev-a", "device_name": "Pixel A", "replace": True,
                     "last_sync": None, "now": _iso(datetime.now()), "code": CODE})
    assert r["ok"] and pc.api.sync_status()["state"] == "done"
    assert pc.api._sync.session.handle(b"rejeu")[0] == 410  # usage unique : plus rien n'est accepté


def test_old_phone_gets_apk_over_http(pc, tmp_path, monkeypatch):
    """Un téléphone 0.9.0 ne peut pas synchroniser : il reçoit l'APK dans la session chiffrée, puis met à jour."""
    data = b"PK" + os.urandom(11 * 1024 * 1024)  # taille réelle de l'APK (~11 Mo, réponse ~20 Mo)
    apk = tmp_path / "embarque.apk"
    apk.write_bytes(data)
    monkeypatch.setattr(apk_mod, "APK_OVERRIDE", apk)
    phone = Phone(pc, "dev-a", "Pixel A")
    phone.app_version = "0.9.0"
    pc.api.sync_start()
    try:
        h = phone.hello()
        assert h["error"] == "update_required" and h["current"] == "0.9.0" and h["available"] == VERSION
        assert h["size"] == len(data) and h["sha256"] == hashlib.sha256(data).hexdigest()
        assert "proof_pc" not in h and "code_version" not in h and "vault" not in h
        assert "doit être mis à jour" in pc.api.sync_status()["notice"]
        r = phone._post({"type": "sync", "device_id": "dev-a", "device_name": "Pixel A", "replace": True,
                         "last_sync": None, "now": _iso(datetime.now()), "code": CODE})
        assert r["error"] == "invalid" and "vault" not in r
        r = phone._post({"type": "apk"})
        assert r["ok"] and r["version"] == VERSION
        got = unb64u(r["apk"])
        assert got == data and hashlib.sha256(got).hexdigest() == r["sha256"] == h["sha256"]
        assert pc.api.sync_status()["notice"] == "✓ Appli envoyée au téléphone de Pixel A"
        assert phone._post({"type": "cancel"})["ok"]
        assert pc.api.sync_status()["state"] == "closed"
    finally:
        pc.api.sync_stop()
    # appli mise à jour : synchro normale avec le code
    phone.app_version = VERSION
    h, r = phone.sync(CODE)
    assert r["ok"] and h["reason"] == "first"
