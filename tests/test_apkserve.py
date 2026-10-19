import socket
import urllib.error
import urllib.request

import pytest

from app.apkserve import APK_MIME, ApkServer

DATA = bytes(range(256)) * 2000  # ~500 Ko : plusieurs blocs


@pytest.fixture
def server(tmp_path):
    p = tmp_path / "x.apk"
    p.write_bytes(DATA)
    s = ApkServer(p, "tok123", "passe-partout-1.0.0.apk", host="127.0.0.1")
    s.start()
    yield s
    s.stop()


def url(s, path=None):
    return f"http://127.0.0.1:{s.port}{path or '/tok123/passe-partout-1.0.0.apk'}"


def test_serves_apk_under_token(server):
    with urllib.request.urlopen(url(server), timeout=5) as r:
        assert r.status == 200
        assert r.headers["Content-Type"] == APK_MIME
        assert int(r.headers["Content-Length"]) == len(DATA)
        assert r.read() == DATA


@pytest.mark.parametrize("path", ["/wrong/passe-partout-1.0.0.apk", "/tok123/other.apk", "/tok123/", "/",
                                  "/passe-partout-1.0.0.apk", "/tok123/passe-partout-1.0.0.apk/x"])
def test_wrong_token_or_path_404(server, path):
    with pytest.raises(urllib.error.HTTPError) as e:
        urllib.request.urlopen(url(server, path), timeout=5)
    assert e.value.code == 404
    assert server.downloads == 0


def test_post_refused(server):
    req = urllib.request.Request(url(server), data=b"x", method="POST")
    with pytest.raises(urllib.error.HTTPError) as e:
        urllib.request.urlopen(req, timeout=5)
    assert e.value.code == 405


def test_counts_complete_downloads(server):
    for _ in range(2):
        urllib.request.urlopen(url(server), timeout=5).read()
    # HEAD : accepté mais jamais compté
    urllib.request.urlopen(urllib.request.Request(url(server), method="HEAD"), timeout=5).read()
    assert server.downloads == 2


def test_interrupted_download_not_counted(tmp_path):
    big = tmp_path / "big.apk"
    big.write_bytes(b"x" * (32 * 1024 * 1024))  # bien plus que les tampons du système
    server = ApkServer(big, "tok123", "passe-partout-1.0.0.apk", host="127.0.0.1")
    server.start()
    s = socket.create_connection(("127.0.0.1", server.port), timeout=5)
    s.sendall(b"GET /tok123/passe-partout-1.0.0.apk HTTP/1.1\r\nHost: x\r\n\r\n")
    s.recv(1024)
    s.close()
    import time
    time.sleep(0.3)
    assert server.downloads == 0
    server.stop()


def test_stop_is_idempotent(tmp_path):
    p = tmp_path / "x.apk"
    p.write_bytes(b"a")
    s = ApkServer(p, "t", "f.apk", host="127.0.0.1")
    s.start()
    s.stop()
    s.stop()
