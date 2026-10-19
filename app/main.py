"""Lancement de Passe-Partout : fenêtre pywebview, boîtes de dialogue, verrouillage avec la session Windows."""
from __future__ import annotations

import ctypes
import os
import sys
import threading
import time
from collections.abc import Callable, Iterable
from pathlib import Path

import webview

from app.api import Api
from app.instance import acquire_instance_lock
from app.store import VaultStore
from app.version import VERSION  # lu dès le lancement : un exe sans fichier VERSION échoue tout de suite
from app.winclip import WinClipboard

APP_NAME = "Passe-Partout"
DESKTOP_SWITCHDESKTOP = 0x0100


DATA_DIR_NAME = "PassePartout"
OLD_DATA_DIR_NAME = "GestionnaireMdp"  # nom du dossier jusqu'au 19/10/2026


def default_data_dir(appdata: Path | None = None) -> Path:
    """Dossier des données ; l'ancien dossier « GestionnaireMdp » est renommé au premier lancement.

    Si les deux existent, le nouveau est gardé et l'ancien laissé intact (rien n'est écrasé).
    """
    base = Path(appdata or os.environ.get("APPDATA", Path.home()))
    new, old = base / DATA_DIR_NAME, base / OLD_DATA_DIR_NAME
    if not new.exists() and old.exists():
        try:
            os.replace(old, new)  # même disque : simple renommage, rien n'est recopié
        except OSError:
            return old  # dossier occupé (logiciel ouvert ailleurs) : on garde l'ancien pour cette fois
    return new


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


def show_message(text: str, title: str) -> None:
    """Boîte de message Windows (information), affichée sans fenêtre principale."""
    MB_ICONINFORMATION = 0x40
    ctypes.windll.user32.MessageBoxW(None, text, title, MB_ICONINFORMATION)


OLD_EXE_NAME = "Passe-Partout.exe"  # ancienne copie (dossier dist\Passe-Partout\), sans verrou d'instance
OLD_COPY_MESSAGE = f"Ferme l'ancienne copie de {APP_NAME}, puis relance."


class _ProcessEntry32W(ctypes.Structure):
    _fields_ = [
        ("dwSize", ctypes.c_uint32),
        ("cntUsage", ctypes.c_uint32),
        ("th32ProcessID", ctypes.c_uint32),
        ("th32DefaultHeapID", ctypes.c_size_t),
        ("th32ModuleID", ctypes.c_uint32),
        ("cntThreads", ctypes.c_uint32),
        ("th32ParentProcessID", ctypes.c_uint32),
        ("pcPriClassBase", ctypes.c_long),
        ("dwFlags", ctypes.c_uint32),
        ("szExeFile", ctypes.c_wchar * 260),
    ]


def running_process_names() -> list[str]:
    """Noms des exécutables en cours (Win32 : CreateToolhelp32Snapshot) ; liste vide en cas d'échec."""
    TH32CS_SNAPPROCESS = 0x2
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateToolhelp32Snapshot.restype = ctypes.c_void_p
    kernel32.CreateToolhelp32Snapshot.argtypes = [ctypes.c_uint32, ctypes.c_uint32]
    kernel32.Process32FirstW.argtypes = [ctypes.c_void_p, ctypes.POINTER(_ProcessEntry32W)]
    kernel32.Process32NextW.argtypes = [ctypes.c_void_p, ctypes.POINTER(_ProcessEntry32W)]
    kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
    snap = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if not snap or snap == ctypes.c_void_p(-1).value:
        return []
    names = []
    try:
        entry = _ProcessEntry32W()
        entry.dwSize = ctypes.sizeof(_ProcessEntry32W)
        ok = kernel32.Process32FirstW(snap, ctypes.byref(entry))
        while ok:
            names.append(entry.szExeFile)
            ok = kernel32.Process32NextW(snap, ctypes.byref(entry))
    finally:
        kernel32.CloseHandle(snap)
    return names


def old_copy_running(names: Iterable[str]) -> bool:
    """Vrai si l'ancienne copie (« Passe-Partout.exe », nom exact, sans numéro de version) tourne (Ruling 6)."""
    return any(n.lower() == OLD_EXE_NAME.lower() for n in names)


_instance_lock = None  # gardé ouvert toute la vie du processus


def run(data_dir: Path | None = None,
        process_names: Callable[[], Iterable[str]] = running_process_names) -> None:
    global _instance_lock
    # avant le verrou et tout accès au coffre : l'ancienne copie n'a pas de verrou et écrirait en même temps
    try:
        old = old_copy_running(process_names())
    except Exception:
        old = False
    if old:
        show_message(OLD_COPY_MESSAGE, APP_NAME)
        return
    data_dir = Path(data_dir) if data_dir else default_data_dir()
    lock = acquire_instance_lock(data_dir)
    if lock is None:
        show_message(f"{APP_NAME} est déjà ouvert.", APP_NAME)
        return
    _instance_lock = lock
    configure_webview_env()
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
