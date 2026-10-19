import urllib.request

import pytest

from app import api as api_mod
from app import apk as apk_mod
from app.api import Api
from app.apkserve import APK_SECONDS, ApkServer
from app.store import VaultStore
from app.version import VERSION


class FakeApkServer:
    created = []

    def __init__(self, apk_path, token, filename, port=0):
        self.apk_path, self.token, self.filename = apk_path, token, filename
        self.port = 50200
        self.downloads = 0
        self.started = self.stopped = False
        FakeApkServer.created.append(self)

    def start(self):
        self.started = True

    def stop(self):
        self.stopped = True


class Env:
    def __init__(self, tmp_path, clip, clock, dialogs, monkeypatch, hosts=("192.168.1.20",), server=FakeApkServer,
                 with_apk=True):
        FakeApkServer.created = []
        self.timers = []
        self.clock = clock
        self.qr = []
        monkeypatch.setattr(api_mod, "qr_svg", lambda p: self.qr.append(p) or "<svg>qr</svg>")
        apk = tmp_path / "pp.apk"
        apk.write_bytes(b"APKDATA")
        monkeypatch.setattr(apk_mod, "APK_OVERRIDE", apk if with_apk else tmp_path / "absent.apk")
        self.api = Api(VaultStore(tmp_path / "vault.json"), clip, clock=clock, wall_clock=clock, dialogs=dialogs,
                       schedule=lambda s, f: self.timers.append((s, f)), apk_server=server,
                       sync_hosts=lambda: list(hosts))
        self.api.start_empty("Jules")


@pytest.fixture
def env(tmp_path, fake_clip, clock, dialogs, monkeypatch):
    return Env(tmp_path, fake_clip, clock, dialogs, monkeypatch)


def test_apk_install_start_without_apk_raises(tmp_path, fake_clip, clock, dialogs, monkeypatch):
    e = Env(tmp_path, fake_clip, clock, dialogs, monkeypatch, with_apk=False)
    with pytest.raises(ValueError, match="Aucune appli Android n'est incluse dans cette version de Passe-Partout."):
        e.api.apk_install_start()
    assert FakeApkServer.created == []


def test_apk_install_start_requires_network(tmp_path, fake_clip, clock, dialogs, monkeypatch):
    e = Env(tmp_path, fake_clip, clock, dialogs, monkeypatch, hosts=())
    with pytest.raises(ValueError, match="Aucun réseau local détecté"):
        e.api.apk_install_start()


def test_apk_install_start_returns_qr_and_url(env):
    r = env.api.apk_install_start()
    srv = FakeApkServer.created[-1]
    assert srv.started and len(srv.token) >= 20
    assert srv.filename == f"passe-partout-{VERSION}.apk"
    assert r["url"] == f"http://192.168.1.20:50200/{srv.token}/{srv.filename}"
    assert r["urls"] == [r["url"]] and r["qr"] == "<svg>qr</svg>" and env.qr == [r["url"]]
    assert r["seconds"] == APK_SECONDS == 300 and r["version"] == VERSION
    assert env.api.apk_install_status() == {"state": "waiting", "seconds_left": 300, "downloads": 0}


def test_apk_install_status_done_and_stop(env):
    env.api.apk_install_start()
    FakeApkServer.created[-1].downloads = 1
    st = env.api.apk_install_status()
    assert st["state"] == "done" and st["downloads"] == 1
    env.api.apk_install_stop()
    assert FakeApkServer.created[-1].stopped
    assert env.api.apk_install_status() == {"state": "closed", "seconds_left": 0, "downloads": 0}


def test_apk_install_status_expires(env):
    env.api.apk_install_start()
    env.clock.advance(301)
    assert env.api.apk_install_status() == {"state": "expired", "seconds_left": 0, "downloads": 0}
    assert FakeApkServer.created[-1].stopped
    for _, fn in env.timers:
        fn()
    assert env.api.apk_install_status()["state"] == "expired"


def test_second_start_replaces_first(env):
    env.api.apk_install_start()
    first = FakeApkServer.created[-1]
    env.api.apk_install_start()
    assert first.stopped and not FakeApkServer.created[-1].stopped


def test_old_timer_does_not_stop_new_server(env):
    env.api.apk_install_start()
    old_timer = env.timers[-1][1]
    env.api.apk_install_start()
    old_timer()
    assert not FakeApkServer.created[-1].stopped


def test_lock_keeps_apk_server(env):
    env.api.set_lock("pin", "123456")
    env.api.apk_install_start()
    env.api.lock()
    assert not FakeApkServer.created[-1].stopped


def test_get_app_info(env):
    assert env.api.get_app_info() == {"version": VERSION, "apk": True}


def test_get_app_info_without_apk(tmp_path, fake_clip, clock, dialogs, monkeypatch):
    e = Env(tmp_path, fake_clip, clock, dialogs, monkeypatch, with_apk=False)
    assert e.api.get_app_info() == {"version": VERSION, "apk": False}


def test_real_server_end_to_end(tmp_path, fake_clip, clock, dialogs, monkeypatch):
    e = Env(tmp_path, fake_clip, clock, dialogs, monkeypatch,
            server=lambda p, t, f, port=0: ApkServer(p, t, f, port, host="127.0.0.1"))
    r = e.api.apk_install_start()
    port = r["url"].split(":")[2].split("/")[0]
    local = r["url"].replace("192.168.1.20", "127.0.0.1")
    assert f":{port}/" in local
    assert urllib.request.urlopen(local, timeout=5).read() == b"APKDATA"
    assert e.api.apk_install_status()["state"] == "done"
    e.api.apk_install_stop()


def test_apk_qr_only_for_session_urls(tmp_path, fake_clip, clock, dialogs, monkeypatch):
    e = Env(tmp_path, fake_clip, clock, dialogs, monkeypatch, hosts=("192.168.1.20", "10.0.0.5"))
    with pytest.raises(ValueError):
        e.api.apk_qr("http://192.168.1.20:50200/x/y.apk")  # aucune session
    r = e.api.apk_install_start()
    assert len(r["urls"]) == 2
    assert e.api.apk_qr(r["urls"][1]) == "<svg>qr</svg>" and e.qr[-1] == r["urls"][1]
    with pytest.raises(ValueError):
        e.api.apk_qr("http://evil.example/x")
    e.api.apk_install_stop()
    with pytest.raises(ValueError):
        e.api.apk_qr(r["urls"][1])
