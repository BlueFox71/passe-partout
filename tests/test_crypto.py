import pytest

from app import crypto
from app.crypto import CryptoError, decrypt, encrypt


@pytest.fixture(autouse=True)
def scrypt_rapide(monkeypatch):
    monkeypatch.setattr(crypto, "SCRYPT_N", 2**14)


def test_aller_retour():
    assert decrypt(encrypt(b"secret", "123456"), "123456") == b"secret"


def test_mauvais_code():
    with pytest.raises(CryptoError):
        decrypt(encrypt(b"x", "123456"), "654321")


def test_blob_modifie():
    b = bytearray(encrypt(b"x" * 50, "c"))
    b[-5] ^= 1
    with pytest.raises(CryptoError):
        decrypt(bytes(b), "c")


def test_blob_tronque():
    with pytest.raises(CryptoError):
        decrypt(encrypt(b"x", "c")[:20], "c")


def test_pas_un_blob():
    with pytest.raises(CryptoError):
        decrypt(b'{"json": true}', "c")


def test_sel_aleatoire():
    assert encrypt(b"x", "c") != encrypt(b"x", "c")


def test_parametres_par_defaut_lents():
    assert crypto.DEFAULT_SCRYPT_N == 2**18


def test_cle_reutilisable_nonce_neuf():
    salt = b"s" * 16
    key = crypto.derive_key("c", salt, 2**14)
    a = crypto.encrypt_with_key(b"x", key, salt, 2**14)
    b = crypto.encrypt_with_key(b"x", key, salt, 2**14)
    assert a != b  # nonce différent à chaque écriture
    assert crypto.header(a) == (2**14, salt)
    assert decrypt(a, "c") == b"x" and crypto.decrypt_with_key(b, key) == b"x"
