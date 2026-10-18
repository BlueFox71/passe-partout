"""Stockage du coffre : fichier JSON (clair ou chiffré), écriture atomique, sauvegardes tournantes."""
from __future__ import annotations

import json
import os
import shutil
from datetime import datetime
from pathlib import Path

from app import crypto
from app.crypto import CryptoError
from app.model import Vault

MAX_BACKUPS = 5


class VaultCorrupt(Exception):
    """Le fichier de données est illisible (abîmé ou tronqué)."""


class VaultStore:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.backup_dir = self.path.parent / "backups"
        self.vault: Vault | None = None
        self._key: bytes | None = None
        self._salt: bytes | None = None
        self._n: int | None = None
        self._encrypted = False

    # ---------- lecture ----------
    def exists(self) -> bool:
        return self.path.exists()

    def is_encrypted(self) -> bool:
        if self.path.exists():
            with open(self.path, "rb") as f:
                return crypto.is_encrypted(f.read(len(crypto.MAGIC)))
        return self._encrypted

    def load(self, code: str | None) -> Vault:
        """Charge le coffre. Lève CryptoError (code absent / incorrect) ou VaultCorrupt."""
        blob = self.path.read_bytes()
        if crypto.is_encrypted(blob):
            if code is None:
                raise CryptoError("Code requis")
            try:
                n, salt = crypto.header(blob)
            except CryptoError as e:
                raise VaultCorrupt(str(e)) from e
            key = crypto.derive_key(code, salt, n)
            data = crypto.decrypt_with_key(blob, key)
            self._key, self._salt, self._n, self._encrypted = key, salt, n, True
        else:
            data = blob
            self._key = self._salt = self._n = None
            self._encrypted = False
        try:
            self.vault = Vault.from_dict(json.loads(data.decode("utf-8")))
        except (ValueError, UnicodeDecodeError, TypeError, AttributeError) as e:
            raise VaultCorrupt("Contenu illisible") from e
        return self.vault

    def reload(self) -> Vault:
        """Relit le fichier avec la clé déjà en mémoire (après une restauration).

        Lève CryptoError si le fichier est chiffré avec une autre clé, VaultCorrupt s'il est illisible.
        """
        blob = self.path.read_bytes()
        if crypto.is_encrypted(blob):
            try:
                n, salt = crypto.header(blob)
            except CryptoError as e:
                raise VaultCorrupt(str(e)) from e
            if self._key is None or salt != self._salt or n != self._n:
                raise CryptoError("Code requis")
            data = crypto.decrypt_with_key(blob, self._key)
        else:
            data = blob
            self._key = self._salt = self._n = None
            self._encrypted = False
        try:
            self.vault = Vault.from_dict(json.loads(data.decode("utf-8")))
        except (ValueError, UnicodeDecodeError, TypeError, AttributeError) as e:
            raise VaultCorrupt("Contenu illisible") from e
        return self.vault

    # ---------- écriture ----------
    def _encode(self, vault: Vault) -> bytes:
        data = json.dumps(vault.to_dict(), ensure_ascii=False, indent=1).encode("utf-8")
        if self._encrypted:
            if self._key is None:
                raise PermissionError("Coffre verrouillé")
            return crypto.encrypt_with_key(data, self._key, self._salt, self._n)
        return data

    def save(self, vault: Vault, backup: bool = True) -> None:
        payload = self._encode(vault)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_name(self.path.name + ".tmp")
        with open(tmp, "wb") as f:
            f.write(payload)
            f.flush()
            os.fsync(f.fileno())
        if backup and self.path.exists():
            self._backup_current()
        os.replace(tmp, self.path)
        self.vault = vault

    def _backup_current(self) -> None:
        self.backup_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
        shutil.copy2(self.path, self.backup_dir / f"vault-{stamp}.json")
        for old in self.list_backups()[MAX_BACKUPS:]:
            old.unlink(missing_ok=True)

    def list_backups(self) -> list[Path]:
        """Sauvegardes, la plus récente d'abord."""
        if not self.backup_dir.exists():
            return []
        return sorted(self.backup_dir.glob("vault-*.json"), reverse=True)

    def restore(self, backup: Path) -> None:
        """Remplace le coffre par une sauvegarde (l'état actuel est sauvegardé avant)."""
        backup = Path(backup)
        if backup.parent.resolve() != self.backup_dir.resolve() or not backup.exists():
            raise FileNotFoundError("Sauvegarde introuvable")
        content = backup.read_bytes()
        if self.path.exists():
            self._backup_current()
        tmp = self.path.with_name(self.path.name + ".tmp")
        tmp.write_bytes(content)
        os.replace(tmp, self.path)
        self.vault = None

    # ---------- verrou ----------
    def set_lock(self, code: str | None) -> None:
        """Active, change ou retire le verrou ; re-chiffre le coffre et les sauvegardes lisibles."""
        if self.vault is None:
            raise PermissionError("Coffre verrouillé")
        old_key = self._key
        readable = []
        for b in self.list_backups():
            try:
                blob = b.read_bytes()
                data = crypto.decrypt_with_key(blob, old_key) if crypto.is_encrypted(blob) else blob
                readable.append((b, data))
            except (CryptoError, TypeError, ValueError):
                pass  # sauvegarde d'un ancien code : laissée telle quelle
        if code:
            self._salt, self._n = os.urandom(16), crypto.SCRYPT_N
            self._key = crypto.derive_key(code, self._salt, self._n)
            self._encrypted = True
        else:
            self._key = self._salt = self._n = None
            self._encrypted = False
        for b, data in readable:
            out = crypto.encrypt_with_key(data, self._key, self._salt, self._n) if self._encrypted else data
            tmp = b.with_name(b.name + ".tmp")
            tmp.write_bytes(out)
            os.replace(tmp, b)
        # pas de sauvegarde ici : elle contiendrait l'ancien chiffrement, illisible avec le nouveau code
        self.save(self.vault, backup=False)

    def forget_key(self) -> None:
        """Efface la clé et les données déchiffrées de la mémoire (verrouillage)."""
        self._key = None
        self.vault = None
