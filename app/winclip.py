"""Presse-papiers Windows (texte Unicode) via l'API Win32.

Les secrets copiés sont exclus de l'historique du presse-papiers (Win+V) et de la synchronisation cloud.
"""
from __future__ import annotations

import ctypes
import time
from ctypes import wintypes

CF_UNICODETEXT = 13
GMEM_MOVEABLE = 0x0002

_user32 = ctypes.WinDLL("user32", use_last_error=True)
_kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

_user32.OpenClipboard.argtypes = [wintypes.HWND]
_user32.OpenClipboard.restype = wintypes.BOOL
_user32.CloseClipboard.restype = wintypes.BOOL
_user32.EmptyClipboard.restype = wintypes.BOOL
_user32.GetClipboardData.argtypes = [wintypes.UINT]
_user32.GetClipboardData.restype = wintypes.HANDLE
_user32.SetClipboardData.argtypes = [wintypes.UINT, wintypes.HANDLE]
_user32.SetClipboardData.restype = wintypes.HANDLE
_user32.RegisterClipboardFormatW.argtypes = [wintypes.LPCWSTR]
_user32.RegisterClipboardFormatW.restype = wintypes.UINT
_kernel32.GlobalAlloc.argtypes = [wintypes.UINT, ctypes.c_size_t]
_kernel32.GlobalAlloc.restype = wintypes.HGLOBAL
_kernel32.GlobalLock.argtypes = [wintypes.HGLOBAL]
_kernel32.GlobalLock.restype = wintypes.LPVOID
_kernel32.GlobalUnlock.argtypes = [wintypes.HGLOBAL]
_kernel32.GlobalUnlock.restype = wintypes.BOOL
_kernel32.GlobalFree.argtypes = [wintypes.HGLOBAL]
_kernel32.GlobalFree.restype = wintypes.HGLOBAL


def _open() -> bool:
    for _ in range(10):  # le presse-papiers peut être brièvement occupé par une autre appli
        if _user32.OpenClipboard(None):
            return True
        time.sleep(0.02)
    return False


def _alloc(data: bytes) -> int:
    h = _kernel32.GlobalAlloc(GMEM_MOVEABLE, len(data))
    p = _kernel32.GlobalLock(h)
    ctypes.memmove(p, data, len(data))
    _kernel32.GlobalUnlock(h)
    return h


class WinClipboard:
    def __init__(self):
        self._no_history = _user32.RegisterClipboardFormatW("CanIncludeInClipboardHistory")
        self._no_cloud = _user32.RegisterClipboardFormatW("CanUploadToCloudClipboard")
        self._no_monitor = _user32.RegisterClipboardFormatW("ExcludeClipboardContentFromMonitorProcessing")

    def get(self) -> str | None:
        """Texte du presse-papiers ; None s'il est momentanément inaccessible."""
        if not _open():
            return None
        try:
            h = _user32.GetClipboardData(CF_UNICODETEXT)
            if not h:
                return ""
            p = _kernel32.GlobalLock(h)
            try:
                return ctypes.wstring_at(p) if p else ""
            finally:
                _kernel32.GlobalUnlock(h)
        finally:
            _user32.CloseClipboard()

    def set(self, text: str, secret: bool = False) -> None:
        if not _open():
            raise OSError("Presse-papiers indisponible")
        try:
            _user32.EmptyClipboard()
            _user32.SetClipboardData(CF_UNICODETEXT, _alloc((text + "\0").encode("utf-16-le")))
            if secret:
                zero = (0).to_bytes(4, "little")
                _user32.SetClipboardData(self._no_history, _alloc(zero))
                _user32.SetClipboardData(self._no_cloud, _alloc(zero))
                _user32.SetClipboardData(self._no_monitor, _alloc(b"\0"))
        finally:
            _user32.CloseClipboard()

    def clear(self) -> None:
        if _open():
            try:
                _user32.EmptyClipboard()
            finally:
                _user32.CloseClipboard()
