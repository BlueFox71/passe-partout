import threading
from datetime import datetime

import pytest

from app import api as api_mod
from app.api import Api
from app.store import VaultStore
from app.sync import AAD_REQ, AAD_RESP, SYNC_SECONDS, open_sealed, seal, unb64u

CODE = "123456"


class FakeServer:
    created = []

    def __init__(self, session, port=0):
        self.session = session
        self.port = 50123
        self.started = self.stopped = False
        FakeServer.created.append(self)

    def start(self):
        self.started = True

    def stop(self):
        self.stopped = True


class Env:
    def __init__(self, tmp_path, clip, clock, dialogs, monkeypatch, hosts=("192.168.1.20",), lock=True):
        FakeServer.created = []
        self.clock = clock
        self.timers = []
        self.qr_payloads = []

        def fake_qr(payload):
            self.qr_payloads.append(payload)
            return "<svg>qr</svg>"
        monkeypatch.setattr(api_mod, "qr_svg", fake_qr)
        self.api = Api(VaultStore(tmp_path / "vault.json"), clip, clock=clock, wall_clock=clock, dialogs=dialogs,
                       schedule=lambda s, f: self.timers.append((s, f)), sync_server=FakeServer,
                       sync_hosts=lambda: list(hosts))
        self.api.start_empty("Jules")
        if lock:
            self.api.set_lock("pin", CODE)

    @property
    def server(self):
        return FakeServer.created[-1]

    @property
    def key(self):
        return unb64u(self.qr_payloads[-1]["key"])

    def send(self, msg, server=None):
        srv = server or self.server
        status, body = srv.session.handle(seal(self.key, msg, AAD_REQ))
        return status, (open_sealed(self.key, body, AAD_RESP)[0] if status == 200 else None)


@pytest.fixture
def env(tmp_path, fake_clip, clock, dialogs, monkeypatch):
    return Env(tmp_path, fake_clip, clock, dialogs, monkeypatch)


def now_iso():
    return datetime.now().isoformat(timespec="seconds")


def hello(**kw):
    msg = {"type": "hello", "device_id": "dev1", "device_name": "Pixel de Jules", "generation": 0,
           "last_sync": None, "code_version": None, "has_data": False, "now": now_iso()}
    msg.update(kw)
    return msg


def sync(**kw):
    msg = {"type": "sync", "device_id": "dev1", "device_name": "Pixel de Jules", "code": CODE, "replace": True,
           "last_sync": None, "now": now_iso()}
    msg.update(kw)
    return msg


def test_sync_start_requires_lock(tmp_path, fake_clip, clock, dialogs, monkeypatch):
    e = Env(tmp_path, fake_clip, clock, dialogs, monkeypatch, lock=False)
    with pytest.raises(ValueError, match="Définis d'abord un code de verrouillage"):
        e.api.sync_start()
    assert FakeServer.created == []


def test_sync_start_requires_local_network(tmp_path, fake_clip, clock, dialogs, monkeypatch):
    e = Env(tmp_path, fake_clip, clock, dialogs, monkeypatch, hosts=())
    with pytest.raises(ValueError, match="Aucun réseau local détecté"):
        e.api.sync_start()
    assert FakeServer.created == []


def test_sync_start_returns_qr_and_status_waiting(env, monkeypatch):
    monkeypatch.setenv("COMPUTERNAME", "PC-JULES")
    r = env.api.sync_start()
    assert r == {"qr": "<svg>qr</svg>", "seconds": SYNC_SECONDS, "hosts": ["192.168.1.20"]}
    p = env.qr_payloads[-1]
    assert p["v"] == 1 and p["hosts"] == ["192.168.1.20"] and p["port"] == 50123 and p["pc"] == "PC-JULES"
    assert len(env.key) == 32
    assert env.server.started and not env.server.stopped
    assert env.api.sync_status() == {"state": "waiting", "seconds_left": 120, "device": None,
                                      "summary": None, "error": None}
    env.clock.advance(30.5)
    assert env.api.sync_status()["seconds_left"] == 90
    assert any(abs(s - SYNC_SECONDS) < 1 for s, _ in env.timers)


def test_status_without_session_is_closed(env):
    assert env.api.sync_status()["state"] == "closed"


def test_full_sync_then_status_done_and_server_stopped(env):
    env.api.sync_start()
    status, r = env.send(hello())
    assert status == 200 and r["ok"] and r["need_code"]
    assert env.api.sync_status()["state"] == "syncing"
    assert env.api.sync_status()["device"] == "Pixel de Jules"
    status, r = env.send(sync())
    assert status == 200 and r["ok"], r
    st = env.api.sync_status()
    assert st["state"] == "done" and st["seconds_left"] == 0
    assert st["summary"] == r["summary"] and st["error"] is None
    assert env.server.stopped
    assert env.send(sync())[0] == 410
    assert [d["id"] for d in env.api.list_devices()] == ["dev1"]


def test_bad_code_is_reported_in_status(env):
    env.api.sync_start()
    env.send(hello())
    status, r = env.send(sync(code="000000"))
    assert status == 200 and r["error"] == "bad_code"
    st = env.api.sync_status()
    assert st["state"] == "syncing" and st["error"] == "Code incorrect."


def test_session_expires_after_two_minutes(env):
    env.api.sync_start()
    env.clock.advance(SYNC_SECONDS + 1)
    st = env.api.sync_status()
    assert st["state"] == "expired" and st["seconds_left"] == 0
    for _, fn in env.timers:
        fn()
    assert env.server.stopped
    assert env.api.sync_status()["state"] == "expired"
    assert env.send(hello())[0] == 410


def test_lock_closes_sync_session(env):  # Review Focus 4
    env.api.sync_start()
    srv = env.server
    env.api.lock()
    assert srv.session.state == "closed"
    assert srv.stopped
    assert env.api.sync_status()["state"] == "closed"
    assert env.send(hello(), server=srv)[0] == 410


def test_lock_during_request_in_progress_does_not_deadlock(env):
    """Le thread HTTP tient le verrou de session et attend le mutex de l'Api pendant que lock() le tient."""
    env.api.sync_start()
    srv = env.server
    key = env.key
    out = {}

    def http_thread():
        out["r"] = srv.session.handle(seal(key, hello(), AAD_REQ))

    def ui_thread():
        with env.api._mutex:
            t = threading.Thread(target=http_thread, daemon=True)
            t.start()
            out["t"] = t
            for _ in range(500):  # attend que le thread HTTP tienne le verrou de session
                if srv.session._lock.locked():
                    break
                threading.Event().wait(0.01)
            env.api.lock()

    ui = threading.Thread(target=ui_thread, daemon=True)
    ui.start()
    ui.join(5)
    assert not ui.is_alive(), "interblocage entre lock() et une requête en cours"
    out["t"].join(5)
    assert not out["t"].is_alive()
    status, body = out["r"]
    assert status == 200
    reply = open_sealed(key, body, AAD_RESP)[0]
    assert reply["ok"] is False  # session arrêtée : le coffre n'est pas touché
    assert srv.session.state == "closed" and srv.stopped
    assert env.send(hello(), server=srv)[0] == 410


def test_new_start_stops_previous_session(env):
    env.api.sync_start()
    first = env.server
    env.api.sync_start()
    assert first.stopped and first.session.state == "closed"
    assert env.server is not first and env.server.started


def test_sync_stop(env):
    env.api.sync_start()
    srv = env.server
    assert env.api.sync_stop() == {}
    assert srv.stopped and srv.session.state == "closed"
    assert env.api.sync_status()["state"] == "closed"
    assert env.api.sync_stop() == {}


def test_list_and_forget_device(env):
    v = env.api._store.vault
    v.sync["devices"]["a"] = {"name": "Vieux", "last_sync": "2026-01-01T10:00:00"}
    v.sync["devices"]["b"] = {"name": "Récent", "last_sync": "2026-10-18T09:00:00"}
    env.api._save()
    assert env.api.list_devices() == [
        {"id": "b", "name": "Récent", "last_sync": "2026-10-18T09:00:00"},
        {"id": "a", "name": "Vieux", "last_sync": "2026-01-01T10:00:00"},
    ]
    assert env.api.forget_device("a") == {}
    assert [d["id"] for d in env.api.list_devices()] == ["b"]
    env.api.lock()
    env.api.unlock(CODE)
    assert [d["id"] for d in env.api.list_devices()] == ["b"]  # enregistré
    assert env.api.forget_device("inconnu") == {}
