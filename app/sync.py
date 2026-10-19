"""Synchro téléphone <-> PC : enveloppe chiffrée et session à usage unique.

Chaque message est un JSON compact chiffré en AES-256-GCM avec la clé du QR code.
Corps HTTP : {"n": <nonce b64url>, "c": <chiffré b64url>}. Les messages ne sont
jamais journalisés (ils contiennent des mots de passe).
"""
import base64
import json
import os
import threading
import time
from typing import Callable

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

AAD_REQ = b"pp-sync-v1:req"
AAD_RESP = b"pp-sync-v1:resp"


class SyncError(Exception):
    pass


def b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def unb64u(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _json_compact(obj: dict) -> bytes:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def seal(key: bytes, obj: dict, aad: bytes, nonce: bytes | None = None) -> bytes:
    if nonce is None:
        nonce = os.urandom(12)
    ct = AESGCM(key).encrypt(nonce, _json_compact(obj), aad)
    return json.dumps({"n": b64u(nonce), "c": b64u(ct)}, separators=(",", ":")).encode("ascii")


def open_sealed(key: bytes, body: bytes, aad: bytes) -> tuple[dict, bytes]:
    try:
        d = json.loads(body)
        nonce = unb64u(d["n"])
        ct = unb64u(d["c"])
        if len(nonce) != 12:
            raise ValueError("nonce")
        obj = json.loads(AESGCM(key).decrypt(nonce, ct, aad))
    except (InvalidTag, ValueError, KeyError, TypeError) as e:
        raise SyncError("message illisible") from e
    if not isinstance(obj, dict):
        raise SyncError("message illisible")
    return obj, nonce


class SyncSession:
    """Session à usage unique, sûre vis-à-vis des threads du serveur HTTP."""

    def __init__(self, key: bytes, on_message: Callable[[dict], dict],
                 expires_at: float, clock=time.monotonic):
        self._key = key
        self._on_message = on_message
        self._expires_at = expires_at
        self._clock = clock
        self._lock = threading.Lock()
        self._seen: set[bytes] = set()
        self.state = "waiting"

    def _refresh_expiry(self) -> None:
        if self.state in ("waiting", "syncing") and self._clock() >= self._expires_at:
            self.state = "expired"

    def handle(self, body: bytes) -> tuple[int, bytes]:
        with self._lock:
            self._refresh_expiry()
            if self.state not in ("waiting", "syncing"):
                return 410, b""
            try:
                msg, nonce = open_sealed(self._key, body, AAD_REQ)
            except SyncError:
                return 403, b""
            if nonce in self._seen:
                return 409, b""
            self._seen.add(nonce)
            self.state = "syncing"
            kind = msg.get("type")
            try:
                reply = self._on_message(msg)
                if not isinstance(reply, dict):
                    raise TypeError("réponse invalide")
                sealed = seal(self._key, reply, AAD_RESP)
            except Exception:
                if kind == "cancel":
                    self.state = "closed"
                return 500, b""
            if kind == "cancel":
                self.state = "closed"
            elif kind == "sync" and reply.get("ok") is not False and "error" not in reply:
                self.state = "done"
            return 200, sealed

    def close(self) -> None:
        with self._lock:
            if self.state in ("waiting", "syncing"):
                self.state = "closed"
