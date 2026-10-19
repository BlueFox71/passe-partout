"""Dialogue de synchro PC ↔ téléphone : messages « hello » puis « sync » (déjà déchiffrés par SyncSession).

Une instance de SyncFlow vit le temps d'une session : « sync » n'est accepté qu'après un « hello » réussi,
dont il reprend le mode (fusion ou remplacement) et le besoin de code. Toute erreur est renvoyée sous la
forme {"ok": False, "error": <code>, "message": <texte>} ; aucun code ni mot de passe n'y figure.
"""
from __future__ import annotations

import hashlib
import hmac
import math
import os
from datetime import date, datetime, timedelta
from typing import Callable

from app.lockout import Lockout
from app.merge import TOMBSTONE_DAYS, merge
from app.model import Vault
from app.store import VaultStore
from app.sync import b64u, unb64u

MAX_SKEW_SECONDS = 300
DEVICE_NAME_MAX = 60
DEFAULT_DEVICE_NAME = "Téléphone"
PAIR_BYTES = 32
# Appairage (Ruling 21) : preuves HMAC-SHA256(secret de l'appareil, clé du QR ‖ étiquette), en base64url
PROOF_PHONE = b"pp-phone-hello"
PROOF_PC = b"pp-pc-hello"

_MESSAGES = {
    "no_lock": "Définis d'abord un code (PIN ou mot de passe) sur le PC pour synchroniser le téléphone.",
    "locked": "Le coffre du PC est verrouillé : déverrouille-le puis recommence.",
    "code_required": "Saisis le code du PC.",
    "bad_code": "Code incorrect.",
    "invalid": "Message de synchronisation invalide.",
    "save_failed": "Impossible d'enregistrer les données reçues sur le PC.",
}
_KINDS = ("account", "giftcard", "profile")
_TOMBSTONE_KEYS = frozenset({"kind", "id", "at"})
_HISTORY_KEYS = frozenset({"id", "date", "amount"})


class _Refused(Exception):
    def __init__(self, error: str, message: str | None = None, **extra):
        super().__init__(error)
        self.reply = {"ok": False, "error": error, "message": message or _MESSAGES[error], **extra}


# ---------------------------------------------------------------- validation
def _invalid(what: str):
    raise ValueError(f"Champ invalide : {what}")


def _str(d: dict, key: str, *, required=False, nonempty=False, optional=False) -> str | None:
    if key not in d:
        if required:
            _invalid(key)
        return None
    v = d[key]
    if v is None and optional:
        return None
    if not isinstance(v, str) or (nonempty and not v):
        _invalid(key)
    return v


def _date(v, what: str) -> datetime:
    if not isinstance(v, str):
        _invalid(what)
    try:
        dt = datetime.fromisoformat(v)
    except ValueError:
        _invalid(what)
    # forme canonique exigée : la fusion compare ces dates comme des chaînes
    if dt.tzinfo is not None or dt.isoformat(timespec="seconds") != v:
        _invalid(what)
    return dt


def _day(v, what: str) -> None:
    """Date de dépense : exactement AAAA-MM-JJ (triée comme une chaîne par la fusion)."""
    if not isinstance(v, str):
        _invalid(what)
    try:
        ok = date.fromisoformat(v).isoformat() == v
    except ValueError:
        ok = False
    if not ok:
        _invalid(what)


def _amount(v, what: str, *, positive=False) -> float:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        _invalid(what)
    try:
        f = float(v)  # un entier JSON immense lève OverflowError
    except OverflowError:
        _invalid(what)
    if not math.isfinite(f) or f < 0 or (positive and f == 0):
        _invalid(what)
    return f


def _image(d: dict, key: str) -> None:
    v = d.get(key)
    if v is not None and not (isinstance(v, str) and v.startswith("data:image/")):
        _invalid(key)


def _only_keys(d: dict, allowed: frozenset, what: str) -> None:
    """Liste blanche : une clé inconnue (pierre tombale, dépense) est refusée plutôt que recopiée telle quelle."""
    if not set(d) <= allowed:
        _invalid(what)


def _device_name(msg: dict) -> str:
    """Nom affiché du téléphone : espaces retirés, 60 caractères au plus, « Téléphone » s'il est vide."""
    name = _str(msg, "device_name", required=True).strip()[:DEVICE_NAME_MAX].strip()
    return name or DEFAULT_DEVICE_NAME


def _profile_ids(d: dict) -> None:
    p = d.get("profiles", [])
    if not isinstance(p, list) or not all(isinstance(x, str) for x in p):
        _invalid("profiles")


def _item(d, kind: str, str_fields: tuple, opt_str_fields: tuple) -> dict:
    if not isinstance(d, dict):
        _invalid(kind)
    _str(d, "id", required=True, nonempty=True)
    _str(d, "name", required=True, nonempty=True)
    _date(d.get("updated"), "updated")
    for k in str_fields:
        _str(d, k)
    for k in opt_str_fields:
        _str(d, k, optional=True)
    return d


def validate_phone_vault(d: dict) -> Vault:
    """Vérifie le coffre envoyé par le téléphone et le convertit ; ValueError si structure ou types invalides."""
    if not isinstance(d, dict):
        _invalid("vault")
    for key in ("profiles", "accounts", "giftcards", "deleted"):
        if not isinstance(d.get(key), list):
            _invalid(key)

    profiles = []
    for p in d["profiles"]:
        _item(p, "profile", (), ("avatar", "color"))
        _image(p, "avatar")
        profiles.append(p)
    accounts = []
    for a in d["accounts"]:
        _item(a, "account", ("category", "login", "password"), ("login_mask", "password_mask"))
        _image(a, "image")
        _profile_ids(a)
        if not isinstance(a.get("favorite", False), bool):
            _invalid("favorite")
        if "created" in a:
            _date(a["created"], "created")
        accounts.append(a)
    giftcards = []
    for g in d["giftcards"]:
        _item(g, "giftcard", ("code", "pin"), ("end_date",))
        if g.get("end_date") is not None:
            _day(g["end_date"], "end_date")
        _image(g, "image")
        _profile_ids(g)
        if g.get("initial") is not None:
            _amount(g["initial"], "initial")
        _amount(g.get("remaining", 0.0), "remaining")
        history = g.get("history", [])
        if not isinstance(history, list):
            _invalid("history")
        for h in history:
            if not isinstance(h, dict):
                _invalid("history")
            _only_keys(h, _HISTORY_KEYS, "history")
            _str(h, "id", required=True, nonempty=True)
            _day(h.get("date"), "date")
            _amount(h.get("amount"), "amount", positive=True)
        giftcards.append(g)
    for t in d["deleted"]:
        if not isinstance(t, dict) or t.get("kind") not in _KINDS:
            _invalid("deleted")
        _only_keys(t, _TOMBSTONE_KEYS, "deleted")
        _str(t, "id", required=True, nonempty=True)
        _date(t.get("at"), "deleted")

    for name, items in (("profiles", profiles), ("accounts", accounts), ("giftcards", giftcards)):
        ids = [i["id"] for i in items]
        if len(ids) != len(set(ids)):
            _invalid(f"{name} (id en double)")
    try:
        return Vault.from_dict({"profiles": profiles, "accounts": accounts, "giftcards": giftcards,
                                "deleted": d["deleted"]})
    except (TypeError, AttributeError) as e:
        raise ValueError("Coffre du téléphone invalide") from e


def pair_proof(pair: str, qr_key: bytes, label: bytes) -> str | None:
    """Preuve d'appairage pour cette session ; None si le secret enregistré est illisible."""
    try:
        secret = unb64u(pair)
    except (ValueError, TypeError):
        return None
    if len(secret) != PAIR_BYTES or not qr_key:
        return None
    return b64u(hmac.new(secret, qr_key + label, hashlib.sha256).digest())


# ---------------------------------------------------------------- dialogue
class SyncFlow:
    def __init__(self, store: VaultStore, lockout: Lockout, persist_lockout: Callable[[], None],
                 config: Callable[[], dict], pc_name: str, now: Callable[[], datetime] = datetime.now, *,
                 qr_key: bytes):
        self._store = store
        self._lockout = lockout
        self._persist_lockout = persist_lockout
        self._config = config
        self._pc_name = pc_name
        self._now = now
        self._qr_key = bytes(qr_key or b"")  # clé du QR de cette session : les preuves d'appairage y sont liées
        self._hello: dict | None = None  # résultat du hello : device_id, need_code, mode
        self.device_name: str | None = None
        self.summary: dict | None = None

    def handle(self, msg: dict) -> dict:
        """Aiguille un message déchiffré du téléphone sur « hello », « sync » ou « cancel »."""
        kind = msg.get("type") if isinstance(msg, dict) else None
        if kind == "cancel":
            return {"ok": True}
        try:
            if kind == "hello":
                return self._on_hello(msg)
            if kind == "sync":
                return self._on_sync(msg)
            raise _Refused("invalid")
        except _Refused as r:
            return r.reply
        except ValueError:
            return _Refused("invalid").reply

    # ------------------------------------------------------------ communs
    def _pc_now(self) -> datetime:
        return self._now().replace(microsecond=0, tzinfo=None)

    def _check_clock(self, msg: dict) -> datetime:
        phone = _date(msg.get("now"), "now")
        pc = self._pc_now()
        skew = abs((phone - pc).total_seconds())
        if skew > MAX_SKEW_SECONDS:
            minutes = max(1, round(skew / 60))
            raise _Refused("clock", f"L'heure du téléphone diffère de celle du PC de {minutes} min : "
                                    "active l'heure automatique.")
        return pc

    def _check_store(self) -> None:
        if not self._store.is_encrypted():
            raise _Refused("no_lock")
        if self._store.vault is None:
            raise _Refused("locked")

    def _lock_info(self) -> tuple[str, int | None]:
        cfg = self._config()
        mode = cfg.get("lock_mode")
        mode = mode if mode in ("pin", "password") else "unknown"
        return mode, (cfg.get("pin_length") if mode == "pin" else None)

    def _generation(self) -> str | None:
        """Jeton de génération du coffre PC (créé par l'Api, remplacé à chaque restauration de sauvegarde)."""
        g = self._config().get("generation")
        return g if isinstance(g, str) and g else None

    @staticmethod
    def _last_sync(msg: dict) -> str | None:
        v = msg.get("last_sync")
        if v is not None:
            _date(v, "last_sync")
        return v

    # ------------------------------------------------------------ hello
    def _on_hello(self, msg: dict) -> dict:
        if self._hello is not None:
            raise _Refused("invalid")  # un seul hello par session : sinon on pourrait sonder la version du code
        device_id = _str(msg, "device_id", required=True, nonempty=True)
        device_name = _device_name(msg)
        generation = _str(msg, "generation", optional=True)
        last_sync = self._last_sync(msg)
        code_version = _str(msg, "code_version", optional=True)
        has_data = msg.get("has_data")
        if not isinstance(has_data, bool):
            _invalid("has_data")
        phone_proof = _str(msg, "proof", optional=True)
        now = self._check_clock(msg)
        self._check_store()

        # appareil inconnu (jamais vu ou « oublié »), sans preuve d'appairage valide (le device_id seul n'est
        # pas un secret : il est envoyé à quiconque montre un QR), code changé sur le PC ou coffre PC remplacé
        # (restauration d'une sauvegarde, config perdue : nouvelle génération) → le code est exigé. La
        # génération compte car une restauration ramène aussi l'ancien registre des appareils.
        entry = self._store.vault.sync.get("devices", {}).get(device_id)
        pair = entry.get("pair") if isinstance(entry, dict) else None
        proven = False
        if isinstance(pair, str) and phone_proof:
            expected = pair_proof(pair, self._qr_key, PROOF_PHONE)
            proven = expected is not None and hmac.compare_digest(expected.encode(), phone_proof.encode())
        pc_generation = self._generation()
        same_generation = pc_generation is not None and generation == pc_generation
        need_code = not proven or code_version != self._store.code_version() or not same_generation
        if not has_data:
            mode, reason = "replace", "first"
        elif not same_generation:
            mode, reason = "replace", "restored"
        elif last_sync is None or now - datetime.fromisoformat(last_sync) > timedelta(days=TOMBSTONE_DAYS):
            mode, reason = "replace", "stale"
        else:
            mode, reason = "merge", None
        self._hello = {"device_id": device_id, "need_code": need_code, "mode": mode, "last_sync": last_sync}
        self.device_name = device_name
        lock_mode, pin_length = self._lock_info()
        reply = {"ok": True, "pc": self._pc_name, "lock_mode": lock_mode, "pin_length": pin_length,
                 "need_code": need_code, "mode": mode, "reason": reason, "since": last_sync}
        if proven:
            # le téléphone vérifie que ce PC détient aussi le secret avant d'envoyer son coffre ou un code
            reply["proof_pc"] = pair_proof(pair, self._qr_key, PROOF_PC)
        if not need_code:
            # sinon la version du code n'est donnée qu'après vérification du code (réponse de sync)
            reply["code_version"] = self._store.code_version()
        return reply

    # ------------------------------------------------------------ sync
    def _check_code(self, code) -> None:
        if not isinstance(code, str) or not code:
            raise _Refused("code_required")
        wait = self._lockout.wait_seconds()
        if wait > 0:
            raise _Refused("bad_code", wait_seconds=wait)
        if not self._store.verify_code(code):
            self._lockout.fail()
            self._persist_lockout()
            raise _Refused("bad_code", wait_seconds=self._lockout.wait_seconds())
        self._lockout.success()
        self._persist_lockout()

    def _on_sync(self, msg: dict) -> dict:
        hello = self._hello
        if hello is None:
            raise _Refused("invalid")
        device_id = _str(msg, "device_id", required=True, nonempty=True)
        device_name = _device_name(msg)
        if device_id != hello["device_id"]:
            _invalid("device_id")
        replace = msg.get("replace", False)
        if not isinstance(replace, bool) or replace != (hello["mode"] == "replace"):
            _invalid("replace")
        last_sync = self._last_sync(msg)
        if last_sync != hello["last_sync"]:
            _invalid("last_sync")
        now = self._check_clock(msg)
        self._check_store()
        phone = None if replace else validate_phone_vault(msg.get("vault"))
        if hello["need_code"]:
            self._check_code(msg.get("code"))

        synced_at = now.isoformat(timespec="seconds")
        pc_vault = self._store.vault
        if replace:
            vault = Vault.from_dict(pc_vault.to_dict())
            items = len(vault.profiles) + len(vault.accounts) + len(vault.giftcards)
            summary = {"to_pc": 0, "to_phone": items, "deleted": 0, "conflicts": 0}
        else:
            result = merge(pc_vault, phone, last_sync, synced_at)
            vault = result.vault
            summary = {"to_pc": result.to_pc, "to_phone": result.to_phone, "deleted": result.deleted,
                       "conflicts": result.conflicts}
        # secret d'appairage : nouveau après chaque vérification du code (1re synchro, code changé, restauration,
        # téléphone oublié ou d'avant l'appairage), sinon celui du registre
        old = pc_vault.sync.get("devices", {}).get(device_id)
        new_pair = b64u(os.urandom(PAIR_BYTES)) if hello["need_code"] else None
        pair = new_pair or (old.get("pair") if isinstance(old, dict) else None)
        entry = {"name": device_name, "last_sync": synced_at}
        if isinstance(pair, str):
            entry["pair"] = pair
        vault.sync.setdefault("devices", {})[device_id] = entry
        # sauvegarde automatique seulement si les données du PC changent : sinon seul le registre des
        # appareils change, et des synchros sans effet ne doivent pas évincer les points de restauration
        changed = not replace and summary["to_pc"] > 0
        try:
            self._store.save(vault, backup=changed)
        except OSError as e:
            detail = e.strerror or type(e).__name__  # jamais str(e) : pas de chemin ni de contenu
            raise _Refused("save_failed", f"Impossible d'enregistrer les données reçues : {detail}.")

        self.device_name = device_name
        self.summary = summary
        out = vault.to_dict()
        out.pop("settings", None)
        out.pop("sync", None)
        lock_mode, pin_length = self._lock_info()
        reply = {"ok": True, "vault": out, "summary": summary, "code_version": self._store.code_version(),
                 "generation": self._generation(), "synced_at": synced_at, "lock_mode": lock_mode,
                 "pin_length": pin_length}
        if new_pair:
            reply["pair"] = new_pair  # donné une seule fois ; le téléphone le garde chiffré
        return reply
