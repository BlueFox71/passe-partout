"""Vrai PC pour mobile/test/e2e-pc.test.js : Api + SyncServer sur 127.0.0.1, piloté en lignes JSON.

Usage : python -I pc_server.py <dépôt> <dossier temporaire>
« set_apk » simule l'APK embarqué dans l'exe (app.apk.APK_OVERRIDE).
Chaque ligne reçue : {"pc": "main"|"forger", "op": ..., ...} ; réponse : {"ok": true, "r": ...} ou
{"ok": false, "error": "..."}. Deux PC indépendants : « main » (le vrai) et « forger » (un autre PC dont
le QR est montré au téléphone). Rien de secret n'est écrit ailleurs que dans le dossier temporaire.
"""
import hashlib
import json
import os
import pathlib
import sys
import threading

repo, tmp = sys.argv[1], pathlib.Path(sys.argv[2])
sys.path.insert(0, repo)

from app import api as api_mod  # noqa: E402
from app import apk as apk_mod  # noqa: E402
from app.api import Api  # noqa: E402
from app.store import VaultStore  # noqa: E402
from app.sync import SyncServer  # noqa: E402

qrs = []
api_mod.qr_svg = lambda payload: (qrs.append(payload), "<svg/>")[1]


class FastServer(SyncServer):
    """Vrai SyncServer, boucle interrogée toutes les 10 ms (arrêt rapide)."""

    def __init__(self, session):
        super().__init__(session, host="127.0.0.1")

    def start(self):
        self._thread = threading.Thread(target=self._httpd.serve_forever, kwargs={"poll_interval": 0.01},
                                        daemon=True)
        self._thread.start()


class Clip:
    text = ""

    def get(self):
        return self.text

    def set(self, t, secret=False):
        self.text = t

    def clear(self):
        self.text = ""


def make(name):
    folder = tmp / name
    folder.mkdir(parents=True, exist_ok=True)
    return Api(VaultStore(folder / "vault.json"), Clip(), schedule=lambda s, f: None, sync_server=FastServer,
               sync_hosts=lambda: ["127.0.0.1"])


pcs = {"main": make("main"), "forger": make("forger")}


def out(x):
    sys.stdout.write(json.dumps(x) + "\n")
    sys.stdout.flush()


for line in sys.stdin:
    cmd = json.loads(line)
    try:
        api = pcs[cmd.get("pc", "main")]
        op = cmd["op"]
        if op == "sync_start":
            api.sync_start()
            out({"ok": True, "r": json.dumps(qrs[-1])})
        elif op == "call":  # méthode publique de l'Api
            out({"ok": True, "r": getattr(api, cmd["name"])(*cmd.get("args", []))})
        elif op == "set_apk":  # faux APK embarqué (octets aléatoires) : renvoie son SHA-256
            path = tmp / "apk" / "passe-partout.apk"
            path.parent.mkdir(parents=True, exist_ok=True)
            data = os.urandom(int(cmd["size"]))
            path.write_bytes(data)
            apk_mod.APK_OVERRIDE = path
            out({"ok": True, "r": hashlib.sha256(data).hexdigest()})
        elif op == "devices":  # registre brut (présence des secrets d'appairage seulement)
            devices = api._store.vault.sync.get("devices", {})
            out({"ok": True, "r": {k: sorted(v) for k, v in devices.items()}})
        else:
            out({"ok": False, "error": "op"})
    except Exception as e:  # noqa: BLE001
        out({"ok": False, "error": type(e).__name__})
