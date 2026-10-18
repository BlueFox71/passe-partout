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


def configure_webview_env() -> None:
    """Désactive l'accélération GPU de WebView2.

    Avec le GPU, la fenêtre reste noire après avoir été réduite puis réaffichée (la page est bien
    dessinée, mais plus transmise à la fenêtre Windows). Le rendu logiciel suffit largement ici.
    """
    args = os.environ.get("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "").split()
    if "--disable-gpu" not in args:
        args.append("--disable-gpu")
    os.environ["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = " ".join(args)


DEFAULT_SIZE = (1280, 800)


def window_geometry(saved: dict) -> dict:
    """Taille / position à l'ouverture. Une position négative (ancienne fenêtre maximisée) est ignorée."""
    w = int(saved.get("width") or DEFAULT_SIZE[0])
    h = int(saved.get("height") or DEFAULT_SIZE[1])
    x, y = saved.get("x"), saved.get("y")
    maximized = bool(saved.get("maximized"))
    if x is None or y is None or x < 0 or y < 0:
        if x is not None and y is not None:
            maximized = True  # x = -8 : c'était une fenêtre maximisée enregistrée comme normale
            w, h = DEFAULT_SIZE
        x = y = None
    return {"width": w, "height": h, "x": x, "y": y, "maximized": maximized}


def run(data_dir: Path | None = None) -> None:
    configure_webview_env()
    data_dir = Path(data_dir) if data_dir else default_data_dir()
    dialogs = Dialogs()
    clip = WinClipboard()
    api = Api(VaultStore(data_dir / "vault.json"), clip, dialogs=dialogs)

    geom = window_geometry(api._config.get("window") or {})
    window = webview.create_window(
        APP_NAME,
        url=str(ui_dir() / "index.html"),
        js_api=api,
        width=geom["width"],
        height=geom["height"],
        x=geom["x"],
        y=geom["y"],
        maximized=geom["maximized"],
        min_size=(1000, 650),
        background_color="#0b0716",
        text_select=True,
    )
    dialogs.window = window
    state = {"maximized": geom["maximized"], "normal": dict(geom)}

    def remember_normal():
        if not state["maximized"]:
            state["normal"] = {"width": window.width, "height": window.height, "x": window.x, "y": window.y}

    def on_maximized():
        state["maximized"] = True

    def on_restored():
        state["maximized"] = False

    def on_closing():
        try:
            remember_normal()
            api.save_window({**state["normal"], "maximized": state["maximized"]})
        except Exception:
            pass
        with api._mutex:
            api._clear_pending_secret()  # ne laisse pas un mot de passe copié derrière soi

    window.events.maximized += on_maximized
    window.events.restored += on_restored
    window.events.resized += lambda w, h: remember_normal()
    window.events.moved += lambda x, y: remember_normal()
    window.events.closing += on_closing
    threading.Thread(target=watch_session, args=(api, window), daemon=True).start()
    webview.start(http_server=True, private_mode=True)
