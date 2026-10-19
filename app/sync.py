"""Synchro téléphone <-> PC : enveloppe chiffrée et session à usage unique.

Chaque message est un JSON compact chiffré en AES-256-GCM avec la clé du QR code.
Corps HTTP : {"n": <nonce b64url>, "c": <chiffré b64url>}. Les messages ne sont
jamais journalisés (ils contiennent des mots de passe).
"""
import base64
import io
import ipaddress
import json
import os
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable

import segno
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

AAD_REQ = b"pp-sync-v1:req"
AAD_RESP = b"pp-sync-v1:resp"
SYNC_SECONDS = 120
MAX_BODY = 64 * 1024 * 1024
SYNC_PATH = "/pp-sync"


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
    plain = _json_compact(obj)
    ct = AESGCM(key).encrypt(nonce, plain, aad)
    del plain
    # enveloppe assemblée en octets (même texte que json.dumps compact) : la réponse « apk » pèse ~20 Mo,
    # on évite les copies str ↔ bytes et la sérialisation JSON d'une chaîne géante
    c = base64.urlsafe_b64encode(ct)
    del ct
    end = len(c) - c[-2:].count(b"=")  # base64url sans remplissage, sans recopier c
    return b"".join((b'{"n":"', b64u(nonce).encode("ascii"), b'","c":"', memoryview(c)[:end], b'"}'))


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
        self._closing = False  # demandé par close() ; lu sans verrou
        self.state = "waiting"

    def _current(self) -> str:
        """État effectif : tient compte de l'échéance et d'une fermeture demandée."""
        state = self.state
        if state in ("waiting", "syncing"):
            if self._clock() >= self._expires_at:
                return "expired"
            if self._closing:
                return "closed"
        return state

    def _refresh_expiry(self) -> None:
        self.state = self._current()

    @property
    def status(self) -> str:
        """État lu sans prendre le verrou (ne bloque jamais, même pendant un message en cours)."""
        return self._current()

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
            elif self._closing:
                self.state = "closed"
            return 200, sealed

    def close(self) -> None:
        """Ferme la session sans jamais attendre : si un message est en cours de traitement, la fermeture
        prend effet à la fin de celui-ci (évite l'interblocage avec le mutex de l'Api)."""
        self._closing = True
        if self._lock.acquire(blocking=False):
            try:
                self._refresh_expiry()
            finally:
                self._lock.release()


# ---------------------------------------------------------------- serveur HTTP local
class _Handler(BaseHTTPRequestHandler):
    server_version = "PassePartout"
    sys_version = ""
    protocol_version = "HTTP/1.1"
    timeout = 30  # un client muet ne garde pas un thread indéfiniment

    def log_message(self, format, *args):  # noqa: A002 - jamais de journal (contenu sensible)
        pass

    def _reply(self, status: int, body: bytes = b"", close: bool = False) -> None:
        self.send_response(status)
        if body:
            self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        if status == 405:
            self.send_header("Allow", "POST")
        if close:
            self.send_header("Connection", "close")
            self.close_connection = True
        self.end_headers()
        if body and self.command != "HEAD":
            self.wfile.write(body)

    def do_POST(self):
        if self.path != SYNC_PATH:
            return self._reply(404, close=True)
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            return self._reply(411, close=True)
        if length < 0:
            return self._reply(400, close=True)
        if length > MAX_BODY:
            return self._reply(413, close=True)  # corps non lu
        body = self.rfile.read(length)
        sync_server: SyncServer = self.server.sync_server
        status, data = sync_server.session.handle(body)
        self._reply(status, data, close=True)
        if sync_server.session.status not in ("waiting", "syncing"):
            # session terminée (usage unique) : arrêt depuis un autre thread
            threading.Thread(target=sync_server.stop, daemon=True).start()

    def _not_allowed(self):
        self._reply(405, close=True)

    do_GET = do_HEAD = do_PUT = do_DELETE = do_PATCH = do_OPTIONS = _not_allowed


class _Server(ThreadingHTTPServer):
    allow_reuse_address = False  # sous Windows, SO_REUSEADDR laisserait un autre programme prendre le port
    daemon_threads = True


class SyncServer:
    """Serveur HTTP de la synchro : POST /pp-sync uniquement, threads démons, arrêt idempotent."""

    def __init__(self, session: SyncSession, port: int = 0, host: str = "0.0.0.0"):
        self.session = session
        self._httpd = _Server((host, port), _Handler)
        self._httpd.sync_server = self
        self.port: int = self._httpd.server_address[1]
        self._thread: threading.Thread | None = None
        self._stop_lock = threading.Lock()
        self._stopped = False

    @property
    def running(self) -> bool:
        return self._thread is not None and not self._stopped

    def start(self) -> None:
        self._thread = threading.Thread(target=self._httpd.serve_forever, kwargs={"poll_interval": 0.2},
                                        name="pp-sync-server", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        with self._stop_lock:
            if self._stopped:
                return
            self._stopped = True
        self.session.close()
        if self._thread is not None:
            self._httpd.shutdown()  # attend la fin de serve_forever (pas celle des threads démons)
        self._httpd.server_close()


def private_ipv4s() -> list[str]:
    """Adresses IPv4 privées du PC (ni boucle locale ni 169.254), dans l'ordre, sans doublon."""
    try:
        infos = socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)
    except OSError:
        return []
    out: list[str] = []
    for info in infos:
        ip = info[4][0]
        try:
            addr = ipaddress.ip_address(ip)
        except ValueError:
            continue
        if addr.is_private and not addr.is_loopback and not addr.is_link_local and ip not in out:
            out.append(ip)
    return out


def qr_svg(payload: "dict | str") -> str:
    """QR code (correction « M ») du JSON compact (ou de la chaîne telle quelle, ex. une URL), modules sombres
    sur fond blanc, marge incluse."""
    text = payload if isinstance(payload, str) else _json_compact(payload).decode("utf-8")
    qr = segno.make(text, error="m", micro=False)
    buf = io.BytesIO()
    qr.save(buf, kind="svg", scale=4, border=4, dark="#000000", light="#ffffff", xmldecl=False)
    return buf.getvalue().decode("utf-8")
