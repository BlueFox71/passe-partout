"""Chiffrement du coffre : clé dérivée par scrypt, chiffrement authentifié AES-256-GCM.

Format d'un blob : MAGIC | log2(N) (1 octet) | sel (16) | nonce (12) | texte chiffré + tag.
"""
from __future__ import annotations

import os

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt

MAGIC = b"GMDP1"
DEFAULT_SCRYPT_N = 2**18  # ≈0,5 s : freine les essais en masse sur un fichier volé
SCRYPT_N = DEFAULT_SCRYPT_N
SCRYPT_R = 8
SCRYPT_P = 1
_HEADER = len(MAGIC) + 1 + 16 + 12


class CryptoError(Exception):
    """Mauvais code, ou données chiffrées abîmées / modifiées."""


def derive_key(code: str, salt: bytes, n: int) -> bytes:
    return Scrypt(salt=salt, length=32, n=n, r=SCRYPT_R, p=SCRYPT_P).derive(code.encode("utf-8"))


def encrypt(plaintext: bytes, code: str) -> bytes:
    n, salt = SCRYPT_N, os.urandom(16)
    return encrypt_with_key(plaintext, derive_key(code, salt, n), salt, n)


def encrypt_with_key(plaintext: bytes, key: bytes, salt: bytes, n: int) -> bytes:
    """Chiffre avec une clé déjà dérivée (évite de refaire scrypt à chaque enregistrement) ; nonce neuf."""
    nonce = os.urandom(12)
    return MAGIC + bytes([n.bit_length() - 1]) + salt + nonce + AESGCM(key).encrypt(nonce, plaintext, MAGIC)


def is_encrypted(blob: bytes) -> bool:
    return blob.startswith(MAGIC)


def header(blob: bytes) -> tuple[int, bytes]:
    """Renvoie (N, sel) lus dans l'en-tête ; lève CryptoError si le blob est illisible."""
    if not is_encrypted(blob) or len(blob) < _HEADER + 16:
        raise CryptoError("Données chiffrées illisibles")
    n_log2 = blob[len(MAGIC)]
    if not 10 <= n_log2 <= 20:
        raise CryptoError("Données chiffrées illisibles")
    pos = len(MAGIC) + 1
    return 1 << n_log2, blob[pos:pos + 16]


def decrypt_with_key(blob: bytes, key: bytes) -> bytes:
    header(blob)
    pos = len(MAGIC) + 1 + 16
    nonce, ct = blob[pos:pos + 12], blob[pos + 12:]
    try:
        return AESGCM(key).decrypt(nonce, ct, MAGIC)
    except InvalidTag as e:
        raise CryptoError("Code incorrect ou fichier modifié") from e


def decrypt(blob: bytes, code: str) -> bytes:
    n, salt = header(blob)
    return decrypt_with_key(blob, derive_key(code, salt, n))
