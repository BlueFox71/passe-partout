"""Serveur HTTP local qui propose l'APK Android au téléphone (QR code -> navigateur -> téléchargement).

Sert uniquement GET /<jeton>/<nom du fichier> ; HEAD est accepté sur la même adresse (certains navigateurs
sondent avant de télécharger) mais n'est jamais compté. L'APK est public : rien de secret ici, mais le
contenu des requêtes n'est tout de même jamais journalisé. Conception identique à SyncServer.
"""
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

APK_SECONDS = 300
APK_MIME = "application/vnd.android.package-archive"
CHUNK = 64 * 1024


class _Handler(BaseHTTPRequestHandler):
    server_version = "PassePartout"
    sys_version = ""
    protocol_version = "HTTP/1.1"
    timeout = 30  # un client muet ne garde pas un thread indéfiniment

    def log_message(self, format, *args):  # noqa: A002 - jamais de journal
        pass

    def _plain(self, status: int, allow: bool = False) -> None:
        self.send_response(status)
        self.send_header("Content-Length", "0")
        if allow:
            self.send_header("Allow", "GET, HEAD")
        self.send_header("Connection", "close")
        self.close_connection = True
        self.end_headers()

    def _serve(self, head: bool) -> None:
        srv: ApkServer = self.server.apk_server
        if self.path != f"/{srv.token}/{srv.filename}":
            return self._plain(404)
        try:
            f = open(srv.apk_path, "rb")
        except OSError:
            return self._plain(404)
        with f:
            size = Path(srv.apk_path).stat().st_size
            self.send_response(200)
            self.send_header("Content-Type", APK_MIME)
            self.send_header("Content-Length", str(size))
            self.send_header("Content-Disposition", f'attachment; filename="{srv.filename}"')
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.close_connection = True
            self.end_headers()
            if head:
                return
            sent = 0
            while sent < size:
                bloc = f.read(min(CHUNK, size - sent))
                if not bloc:
                    return  # fichier tronqué pendant l'envoi : pas compté
                self.wfile.write(bloc)  # lève si le client coupe : pas compté
                sent += len(bloc)
            self.wfile.flush()
            srv._count()

    def do_GET(self):
        self._serve(head=False)

    def do_HEAD(self):
        self._serve(head=True)

    def _not_allowed(self):
        self._plain(405, allow=True)

    do_POST = do_PUT = do_DELETE = do_PATCH = do_OPTIONS = _not_allowed


class _Server(ThreadingHTTPServer):
    allow_reuse_address = False  # sous Windows, SO_REUSEADDR laisserait un autre programme prendre le port
    daemon_threads = True


class ApkServer:
    def __init__(self, apk_path: Path, token: str, filename: str, port: int = 0, host: str = "0.0.0.0"):
        self.apk_path = Path(apk_path)
        self.token = token
        self.filename = filename
        self.downloads = 0  # téléchargements complets
        self._count_lock = threading.Lock()
        self._httpd = _Server((host, port), _Handler)
        self._httpd.apk_server = self
        self.port: int = self._httpd.server_address[1]
        self._thread: threading.Thread | None = None
        self._stop_lock = threading.Lock()
        self._stopped = False

    def _count(self) -> None:
        with self._count_lock:
            self.downloads += 1

    @property
    def running(self) -> bool:
        return self._thread is not None and not self._stopped

    def start(self) -> None:
        self._thread = threading.Thread(target=self._httpd.serve_forever, kwargs={"poll_interval": 0.2},
                                        name="pp-apk-server", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        with self._stop_lock:
            if self._stopped:
                return
            self._stopped = True
        if self._thread is not None:
            self._httpd.shutdown()
        self._httpd.server_close()
