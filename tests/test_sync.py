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
