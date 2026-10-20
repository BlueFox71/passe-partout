"""Récupération du code oublié par questions de sécurité.

Une clé aléatoire R chiffre le code du coffre. R est elle-même chiffrée deux fois :
- avec les réponses (scrypt, comme le coffre) : les bonnes réponses redonnent le code ;
- avec la clé du coffre : quand le code change, R est relue et le code rechiffré sans redemander les réponses.

Tout est rangé dans config.json (en clair) ; rien n'y est lisible sans les réponses ou le code.
"""
from __future__ import annotations

import base64
import os
import re

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app import crypto
from app.crypto import CryptoError
from app.textutil import normalize

QUESTIONS = [
    "Quel était le nom de ton premier animal de compagnie ?",
    "Quel est le prénom de ton meilleur ami d'enfance ?",
    "Dans quelle rue habitais-tu à 10 ans ?",
    "Quel est le nom de famille de ton instituteur ou institutrice préféré(e) ?",
    "Quel était le surnom que te donnait ta famille enfant ?",
    "Quel était le nom de ton école primaire ?",
    "Quel était ton jouet ou ta peluche préféré(e) ?",
    "Quel métier voulais-tu faire quand tu étais petit(e) ?",
    "Quel était ton dessin animé préféré enfant ?",
    "Quel est le deuxième prénom de ton père ou de ta mère ?",
    "Quel est ton plat préféré cuisiné par tes grands-parents ?",
    "Quel est le prénom de ton grand-père paternel ?",
    "Quel était le modèle de ta première voiture ?",
    "Quel a été ton premier emploi (entreprise ou poste) ?",
    "Quel est le titre du premier film que tu as vu au cinéma ?",
    "Quel est le livre qui t'a le plus marqué ?",
    "Quel est le nom de la ville où tu rêves de vivre ?",
    "Quel est ton jeu vidéo préféré ?",
    "À quel jeu vidéo as-tu joué en premier ?",
    "Quelle a été ta première console de jeux vidéo ?",
]
COUNT = 3


def _b64(b: bytes) -> str:
    return base64.b64encode(b).decode("ascii")


def _unb64(s: str) -> bytes:
    return base64.b64decode(s.encode("ascii"), validate=True)


def answer_key(answers: list[str]) -> str:
    """Réponses comparées sans casse, accents, espaces ni ponctuation (« Médor » = « medor »)."""
    return "\x1f".join(re.sub(r"[^a-z0-9]", "", normalize(a)) for a in answers)


def check(questions: list[int], answers: list[str]) -> None:
    if (len(questions) != COUNT or len(set(questions)) != COUNT
            or not all(isinstance(q, int) and 0 <= q < len(QUESTIONS) for q in questions)):
        raise ValueError(f"Choisis {COUNT} questions différentes")
    if len(answers) != COUNT or any(len(k) < 2 for k in answer_key(answers).split("\x1f")):
        raise ValueError("Chaque réponse doit contenir au moins 2 lettres ou chiffres")


def _seal_code(code: str, r: bytes) -> str:
    nonce = os.urandom(12)
    return _b64(nonce + AESGCM(r).encrypt(nonce, code.encode("utf-8"), b"pp-recovery"))


def create(questions: list[int], answers: list[str], code: str, seal) -> dict:
    """`seal(bytes) -> bytes` chiffre avec la clé du coffre ouvert."""
    check(questions, answers)
    r = os.urandom(32)
    return {"questions": list(questions), "by_answers": _b64(crypto.encrypt(r, answer_key(answers))),
            "by_key": _b64(seal(r)), "code": _seal_code(code, r)}


def rekey(rec: dict, unseal_old, seal_new, new_code: str) -> dict:
    """Après un changement de code : mêmes réponses, code et clé du coffre mis à jour."""
    r = unseal_old(_unb64(rec["by_key"]))
    return {**rec, "by_key": _b64(seal_new(r)), "code": _seal_code(new_code, r)}


def recover(rec: dict, answers: list[str]) -> str:
    """Renvoie le code du coffre ; lève CryptoError si une réponse est fausse."""
    try:
        r = crypto.decrypt(_unb64(rec["by_answers"]), answer_key(answers))
        blob = _unb64(rec["code"])
        return AESGCM(r).decrypt(blob[:12], blob[12:], b"pp-recovery").decode("utf-8")
    except (InvalidTag, KeyError, ValueError, TypeError) as e:
        raise CryptoError("Réponses incorrectes") from e


def is_valid(rec) -> bool:
    return (isinstance(rec, dict) and isinstance(rec.get("questions"), list)
            and all(isinstance(rec.get(k), str) for k in ("by_answers", "by_key", "code")))
