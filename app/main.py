"""Lancement de Passe-Partout : fenêtre pywebview, boîtes de dialogue, verrouillage avec la session Windows."""
from __future__ import annotations

import ctypes
import os
import sys
import threading
import time
from pathlib import Path

import webview

from app.api import Api
from app.store import VaultStore
from app.winclip import WinClipboard

APP_NAME = "Passe-Partout"
DESKTOP_SWITCHDESKTOP = 0x0100


def default_data_dir() -> Path:
    return Path(os.environ.get("APPDATA", Path.home())) / "GestionnaireMdp"


def ui_dir() -> Path:
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent))
    return base / "ui"


class Dialogs:
    """Sélecteurs de fichiers et de dossiers natifs (via pywebview)."""

    FILTERS = {
        "image": ("Images (*.png;*.jpg;*.jpeg;*.gif;*.bmp;*.webp;*.ico)",),
        "excel": ("Classeurs Excel (*.xlsx;*.xlsm)",),
    }

    def __init__(self):
        self.window = None

    def open_file(self, kind: str) -> str | None:
        r = self.window.create_file_dialog(webview.FileDialog.OPEN, file_types=self.FILTERS[kind])
        return r[0] if r else None

    def pick_folder(self) -> str | None:
        r = self.window.create_file_dialog(webview.FileDialog.FOLDER)
        return r[0] if r else None


def session_is_locked() -> bool:
    """Vrai quand la session Windows est verrouillée (le bureau d'entrée n'est plus accessible)."""
    user32 = ctypes.windll.user32
    h = user32.OpenInputDesktop(0, False, DESKTOP_SWITCHDESKTOP)
    if not h:
        return True
    user32.CloseDesktop(h)
    return False


def watch_session(api: Api, window) -> None:
    was_locked = False
    while True:
        time.sleep(2)
        try:
            locked = session_is_locked()
        except Exception:
            continue
        if locked and not was_locked and api.get_state()["lock_mode"] != "none":
            api.lock()
            try:
                window.evaluate_js("window.app && window.app.onLocked()")
            except Exception:
                pass
        was_locked = locked


def run(data_dir: Path | None = None) -> None:
    data_dir = Path(data_dir) if data_dir else default_data_dir()
    dialogs = Dialogs()
    clip = WinClipboard()
    api = Api(VaultStore(data_dir / "vault.json"), clip, dialogs=dialogs)

    geom = api._config.get("window") or {}
    window = webview.create_window(
        APP_NAME,
        url=str(ui_dir() / "index.html"),
        js_api=api,
        width=int(geom.get("width", 1280)),
        height=int(geom.get("height", 800)),
        x=geom.get("x"),
        y=geom.get("y"),
        min_size=(1000, 650),
        background_color="#0b0716",
        text_select=True,
    )
    dialogs.window = window

    def on_closing():
        try:
            api.save_window({"width": window.width, "height": window.height, "x": window.x, "y": window.y})
        except Exception:
            pass
        with api._mutex:
            api._clear_pending_secret()  # ne laisse pas un mot de passe copié derrière soi

    window.events.closing += on_closing
    threading.Thread(target=watch_session, args=(api, window), daemon=True).start()
    webview.start(http_server=True, private_mode=True)
