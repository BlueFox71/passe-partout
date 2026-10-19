import json
import os
from pathlib import Path

import pytest

from app import sync
from app.sync import AAD_REQ, AAD_RESP, SyncError, SyncSession, open_sealed, seal, unb64u

VECTOR = Path(__file__).parent / "fixtures" / "sync_vector.json"
KEY = bytes(range(32))


class FakeClock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


def make_session(on_message=None, ttl=120.0):
    clock = FakeClock()
    s = SyncSession(KEY, on_message or (lambda m: {"ok": True, "echo": m["type"]}), clock() + ttl, clock)
    return s, clock


def test_seal_open_roundtrip():
    obj = {"type": "hello", "nom": "Café €"}
    body = seal(KEY, obj, AAD_REQ)
    got, nonce = open_sealed(KEY, body, AAD_REQ)
    assert got == obj
    assert len(nonce) == 12


def test_wrong_key_or_tampered_body_raises():
    body = seal(KEY, {"a": 1}, AAD_REQ)
    with pytest.raises(SyncError):
        open_sealed(os.urandom(32), body, AAD_REQ)
    with pytest.raises(SyncError):
        open_sealed(KEY, body, AAD_RESP)
    d = json.loads(body)
    c = bytearray(unb64u(d["c"]))
    c[0] ^= 1
    d["c"] = sync.b64u(bytes(c))
    with pytest.raises(SyncError):
        open_sealed(KEY, json.dumps(d).encode(), AAD_REQ)
    with pytest.raises(SyncError):
        open_sealed(KEY, b"pas du json", AAD_REQ)


def test_vector_file_matches_seal():
    v = json.loads(VECTOR.read_text(encoding="utf-8"))
    body = seal(unb64u(v["key"]), v["plaintext"], v["aad"].encode(), unb64u(v["nonce"]))
    assert body.decode() == v["body"]


def test_session_answers_and_closes_after_sync():
    s, _ = make_session()
    assert s.state == "waiting"
    status, resp = s.handle(seal(KEY, {"type": "hello"}, AAD_REQ))
    assert status == 200 and s.state == "syncing"
    assert open_sealed(KEY, resp, AAD_RESP)[0] == {"ok": True, "echo": "hello"}
    status, _ = s.handle(seal(KEY, {"type": "sync"}, AAD_REQ))
    assert status == 200 and s.state == "done"
    assert s.handle(seal(KEY, {"type": "hello"}, AAD_REQ))[0] == 410


def test_session_cancel_closes():
    s, _ = make_session()
    assert s.handle(seal(KEY, {"type": "cancel"}, AAD_REQ))[0] == 200
    assert s.state == "closed"
    assert s.handle(seal(KEY, {"type": "hello"}, AAD_REQ))[0] == 410


def test_session_rejects_replayed_nonce():
    s, _ = make_session()
    body = seal(KEY, {"type": "hello"}, AAD_REQ)
    assert s.handle(body)[0] == 200
    assert s.handle(body)[0] == 409


def test_session_rejects_wrong_key():
    s, _ = make_session()
    assert s.handle(seal(os.urandom(32), {"type": "hello"}, AAD_REQ))[0] == 403
    assert s.state == "waiting"


def test_session_expires():
    s, clock = make_session()
    clock.t += 121
    assert s.handle(seal(KEY, {"type": "hello"}, AAD_REQ))[0] == 410
    assert s.state == "expired"


def test_response_cannot_be_replayed_as_request():
    s, _ = make_session()
    _, resp = s.handle(seal(KEY, {"type": "hello"}, AAD_REQ))
    assert s.handle(resp)[0] == 403


def test_failed_sync_keeps_session_open():
    s, _ = make_session(lambda m: {"ok": False, "error": "x"})
    assert s.handle(seal(KEY, {"type": "sync"}, AAD_REQ))[0] == 200
    assert s.state == "syncing"


def test_callback_exception_gives_500_and_keeps_session():
    def boom(m):
        raise RuntimeError("x")
    s, _ = make_session(boom)
    assert s.handle(seal(KEY, {"type": "hello"}, AAD_REQ))[0] == 500
    assert s.state == "syncing"


@pytest.mark.parametrize("bad", [["pas", "un", "dict"], {"x": object()}])
def test_bad_reply_gives_500_and_session_still_usable(bad):
    replies = [bad]
    s, _ = make_session(lambda m: replies.pop(0) if replies else {"ok": True})
    assert s.handle(seal(KEY, {"type": "sync"}, AAD_REQ)) == (500, b"")
    assert s.state == "syncing"
    assert s.handle(seal(KEY, {"type": "sync"}, AAD_REQ))[0] == 200
    assert s.state == "done"


def test_cancel_closes_even_if_callback_raises():
    def boom(m):
        raise RuntimeError("x")
    s, _ = make_session(boom)
    assert s.handle(seal(KEY, {"type": "cancel"}, AAD_REQ))[0] == 500
    assert s.state == "closed"
    assert s.handle(seal(KEY, {"type": "hello"}, AAD_REQ))[0] == 410


# ---------------------------------------------------------------- état lu sans verrou (Tâche 5)
def test_status_reports_expired_without_any_message():
    s, clock = make_session(ttl=120.0)
    assert s.status == "waiting"
    clock.t += 121
    assert s.status == "expired"


def test_close_after_deadline_gives_expired():
    s, clock = make_session(ttl=120.0)
    clock.t += 121
    s.close()
    assert s.state == "expired"


def test_close_does_not_wait_for_message_in_progress():
    """close() pendant qu'un message est traité : ne bloque pas, la session se ferme ensuite."""
    import threading
    entered, release = threading.Event(), threading.Event()

    def slow(m):
        entered.set()
        assert release.wait(5)
        return {"ok": True}

    s, _ = make_session(slow)
    out = {}
    t = threading.Thread(target=lambda: out.update(r=s.handle(seal(KEY, {"type": "hello"}, AAD_REQ))))
    t.start()
    assert entered.wait(5)
    closer = threading.Thread(target=s.close)
    closer.start()
    closer.join(2)
    assert not closer.is_alive(), "close() ne doit pas attendre la fin du message en cours"
    assert s.status == "closed"
    release.set()
    t.join(5)
    assert out["r"][0] == 200
    assert s.state == "closed"
    assert s.handle(seal(KEY, {"type": "sync"}, AAD_REQ))[0] == 410


# ---------------------------------------------------------------- serveur HTTP, QR code
def _post(port, path, body, method="POST"):
    import http.client
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        c.request(method, path, body=body, headers={"Content-Type": "application/json"})
        r = c.getresponse()
        return r.status, r.read()
    finally:
        c.close()


@pytest.fixture
def server():
    from app.sync import SyncServer
    created = []

    def make(session):
        srv = SyncServer(session, host="127.0.0.1")
        srv.start()
        created.append(srv)
        return srv
    yield make
    for srv in created:
        srv.stop()


def test_server_roundtrip_on_loopback(server):
    s, _ = make_session()
    srv = server(s)
    assert srv.port > 0
    status, body = _post(srv.port, "/pp-sync", seal(KEY, {"type": "hello"}, AAD_REQ))
    assert status == 200
    assert open_sealed(KEY, body, AAD_RESP)[0] == {"ok": True, "echo": "hello"}
    assert _post(srv.port, "/pp-sync", b"pas du json")[0] == 403


def test_server_rejects_other_paths_and_huge_body(server):
    import http.client
    s, _ = make_session()
    srv = server(s)
    assert _post(srv.port, "/pp-sync", None, method="GET")[0] == 405
    assert _post(srv.port, "/x", seal(KEY, {"type": "hello"}, AAD_REQ))[0] == 404
    c = http.client.HTTPConnection("127.0.0.1", srv.port, timeout=5)
    try:
        c.putrequest("POST", "/pp-sync")
        c.putheader("Content-Length", str(70 * 1024 * 1024))
        c.endheaders()  # corps jamais envoyé : le serveur doit répondre sans le lire
        assert c.getresponse().status == 413
    finally:
        c.close()
    assert s.state == "waiting"


def test_server_stops_itself_after_successful_sync(server):
    import time as _time
    s, _ = make_session()
    srv = server(s)
    assert _post(srv.port, "/pp-sync", seal(KEY, {"type": "sync"}, AAD_REQ))[0] == 200
    assert s.state == "done"
    deadline = _time.monotonic() + 5
    while srv.running and _time.monotonic() < deadline:
        _time.sleep(0.05)
    assert not srv.running
    srv.stop()  # idempotent


def test_private_ipv4s_filters(monkeypatch):
    import socket
    infos = [(socket.AF_INET, 0, 0, "", (ip, 0)) for ip in
             ("127.0.0.1", "169.254.3.4", "192.168.1.20", "8.8.8.8", "10.0.0.5", "192.168.1.20")]
    monkeypatch.setattr(sync.socket, "getaddrinfo", lambda *a, **k: infos)
    assert sync.private_ipv4s() == ["192.168.1.20", "10.0.0.5"]

    def fail(*a, **k):
        raise socket.gaierror("x")
    monkeypatch.setattr(sync.socket, "getaddrinfo", fail)
    assert sync.private_ipv4s() == []


def test_qr_svg_contains_svg():
    svg = sync.qr_svg({"v": 1, "hosts": ["192.168.1.20"], "port": 50123, "key": "k" * 43, "pc": "PC-Jules"})
    assert "<svg" in svg and "</svg>" in svg
    assert "<?xml" not in svg


@pytest.mark.parametrize("size", [0, 1, 2, 3, 100, 3 * 1024 * 1024 + 1])
def test_seal_envelope_is_compact_json_without_padding(size):
    """L'enveloppe assemblée en octets est exactement le JSON compact d'avant (réponse « apk » de ~20 Mo)."""
    key, nonce = bytes(32), bytes(range(12))
    obj = {"ok": True, "apk": "x" * size}
    body = seal(key, obj, AAD_RESP, nonce)
    d = json.loads(body)
    assert list(d) == ["n", "c"] and "=" not in d["c"] and "=" not in d["n"]
    assert body == json.dumps({"n": d["n"], "c": d["c"]}, separators=(",", ":")).encode("ascii")
    assert open_sealed(key, body, AAD_RESP) == (obj, nonce)
