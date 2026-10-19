"""Une seule instance de Passe-Partout à la fois : verrou exclusif sur un fichier du dossier des données."""
from __future__ import annotations

import msvcrt
from pathlib import Path

LOCK_NAME = ".instance.lock"


def acquire_instance_lock(data_dir: Path) -> object | None:
    """Verrou exclusif sur data_dir/.instance.lock, à garder ouvert toute la vie du processus.

    None si une autre instance le détient. Le système le libère si le processus s'arrête brutalement.
    """
    data_dir = Path(data_dir)
    data_dir.mkdir(parents=True, exist_ok=True)
    f = open(data_dir / LOCK_NAME, "a+b")
    try:
        f.seek(0)
        msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
    except OSError:
        f.close()
        return None
    return f


def release_instance_lock(lock) -> None:
    if lock is None:
        return
    try:
        lock.seek(0)
        msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
    except OSError:
        pass
    lock.close()
