"""Pont entre l'interface (JS, via pywebview) et la logique Python.

Chaque méthode publique correspond à une méthode `api.*` de ui/mock-api.js (mêmes noms, mêmes formes).
Les attributs privés (préfixe _) ne sont pas exposés au JS.
"""
from __future__ import annotations

import functools
import json
import math
import os
import re
import secrets
import socket
import subprocess
import sys
import threading
import time
from dataclasses import asdict
from datetime import date, datetime
from pathlib import Path

from app import apk as apk_mod
from app import giftcards as gc_logic
from app.apkserve import APK_SECONDS, ApkServer
from app.crypto import CryptoError
from app.exporter import export_png, export_text
from app.images import normalize_image as _normalize_image
from app.importer import import_xlsx
from app.lockout import Lockout
from app.model import Account, GiftCard, Profile, Vault, new_id, now_iso, tombstone
from app.store import VaultCorrupt, VaultStore
from app.sync import SYNC_SECONDS, SyncServer, SyncSession, b64u, private_ipv4s, qr_svg
from app.syncflow import SyncFlow
from app.textutil import normalize
from app.version import VERSION

CLIPBOARD_SECONDS = 30
COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


def _open_folder(path: str) -> None:
    if sys.platform == "win32":
        os.startfile(path)  # dossier local de l'appli
    else:
        subprocess.Popen(["xdg-open", path])


PALETTE = ["#ff3d9a", "#7c3aed", "#00b8d9", "#f97316", "#22c55e", "#e11d48", "#6366f1", "#14b8a6", "#eab308", "#a855f7"]


def _locked(fn):
    """Sérialise les appels (pywebview peut appeler l'API depuis plusieurs threads)."""
    @functools.wraps(fn)
    def wrapper(self, *args, **kwargs):
        with self._mutex:
            return fn(self, *args, **kwargs)
    return wrapper


def _timer(seconds, fn):
    t = threading.Timer(seconds, fn)
    t.daemon = True
    t.start()


class _SyncRun:
    """Une synchro en cours (QR affiché) : session à usage unique, serveur, dialogue, dernière erreur."""

    def __init__(self, flow: SyncFlow, deadline: float):
        self.flow = flow
        self.deadline = deadline
        self.session: SyncSession | None = None
        self.server = None
        self.error: str | None = None


class _ApkRun:
    """Un serveur d'installation de l'appli Android en cours (indépendant de la synchro)."""

    def __init__(self, server, deadline: float):
        self.server = server
        self.deadline = deadline
        self.stopped = False
        self.urls: list[str] = []


class Api:
    def __init__(self, store: VaultStore, clipboard, clock=time.monotonic, dialogs=None,
                 schedule=_timer, today=date.today, wall_clock=time.time,
                 sync_server=SyncServer, sync_hosts=private_ipv4s, apk_server=ApkServer):
        self._store = store
        self._clip = clipboard
        self._clock = clock
        self._dialogs = dialogs
        self._schedule = schedule
        self._today = today
        self._mutex = threading.RLock()
        self._pending = None  # (texte copié, échéance)
        self._sync_server = sync_server
        self._sync_hosts = sync_hosts
        self._sync: _SyncRun | None = None
        self._apk_server = apk_server
        self._apk: _ApkRun | None = None
        self._config_path = store.path.parent / "config.json"
        self._config = self._read_config()
        # le délai anti-essais survit à un redémarrage (horloge murale, état dans config.json)
        self._lockout = Lockout(wall_clock)
        self._lockout.restore(self._config.get("lockout") or {})
        self._corrupt = False
        if store.exists() and not store.is_encrypted():
            try:
                store.load(None)
            except VaultCorrupt:
                self._corrupt = True

    # ---------------------------------------------------------------- configuration en clair
    def _read_config(self) -> dict:
        try:
            return json.loads(self._config_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}

    def _write_config(self) -> None:
        self._config_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self._config_path.with_name(f"config.json.{threading.get_ident()}.tmp")
        tmp.write_text(json.dumps(self._config, indent=1), encoding="utf-8")
        os.replace(tmp, self._config_path)

    def _lock_mode(self) -> str:
        if not self._store.is_encrypted():
            return "none"
        mode = self._config.get("lock_mode")
        return mode if mode in ("pin", "password") else "unknown"  # config perdue : champ de saisie libre

    # ---------------------------------------------------------------- accès au coffre
    def _vault(self) -> Vault:
        if self._store.vault is None:
            raise PermissionError("Coffre verrouillé")
        return self._store.vault

    def _save(self) -> None:
        self._store.save(self._vault())

    def _profile_ids(self) -> set[str]:
        return {p.id for p in self._vault().profiles}

    @staticmethod
    def _in_profile(pid):
        return lambda x: pid is None or pid in x.profiles

    def _check_profiles(self, profiles: list[str]) -> list[str]:
        valid = self._profile_ids()
        out = [p for p in dict.fromkeys(profiles or []) if p in valid]
        if not out:
            raise ValueError("Choisis au moins un profil")
        return out

    # ---------------------------------------------------------------- état, verrou
    @_locked
    def get_state(self) -> dict:
        has_data = self._store.exists()
        locked = has_data and not self._corrupt and self._store.vault is None
        profiles = [asdict(p) for p in self._store.vault.profiles] if self._store.vault else []
        mode = self._lock_mode() if has_data else "none"
        pin_length = self._config.get("pin_length") if mode == "pin" else None
        return {"locked": locked, "lock_mode": mode, "pin_length": pin_length,
                "has_data": has_data, "corrupt": self._corrupt, "profiles": profiles}

    @_locked
    def unlock(self, code: str) -> dict:
        wait = self._lockout.wait_seconds()
        if wait > 0:
            return {"ok": False, "wait_seconds": wait, "error": "bad_code"}
        try:
            self._store.load(str(code))
        except CryptoError:
            self._lockout.fail()
            self._persist_lockout()
            return {"ok": False, "wait_seconds": self._lockout.wait_seconds(), "error": "bad_code"}
        except VaultCorrupt:
            self._corrupt = True
            return {"ok": False, "wait_seconds": 0, "error": "corrupt"}
        self._lockout.success()
        if self._lock_mode() == "pin" and str(code).isdigit():
            # longueur du PIN, pour valider automatiquement la saisie au prochain déverrouillage
            self._config["pin_length"] = len(str(code))
        self._persist_lockout()
        return {"ok": True, "wait_seconds": 0}

    def _persist_lockout(self) -> None:
        self._config["lockout"] = self._lockout.to_dict()
        try:
            self._write_config()
        except OSError:
            pass

    def lock(self) -> dict:
        with self._mutex:
            run = self._detach_sync()
            if self._lock_mode() != "none":
                self._clear_pending_secret()
                self._store.forget_key()
        self._stop_sync(run)  # hors du mutex : voir _stop_sync
        return {}

    def set_lock(self, mode: str, code: str | None) -> dict:
        with self._mutex:
            self._set_lock(mode, code)
            # une synchro ouverte a été préparée avec l'ancien code : on l'arrête, comme lock()
            run = self._detach_sync()
        self._stop_sync(run)  # hors du mutex : voir _stop_sync
        return {}

    def _set_lock(self, mode: str, code: str | None) -> None:
        self._vault()
        if mode not in ("none", "pin", "password"):
            raise ValueError("Mode de verrou inconnu")
        if mode == "pin" and not (code and code.isdigit() and 4 <= len(code) <= 12):
            raise ValueError("Le PIN doit contenir de 4 à 12 chiffres")
        if mode == "password" and not (code and len(code) >= 6):
            raise ValueError("Le mot de passe doit faire au moins 6 caractères")
        self._store.set_lock(code if mode != "none" else None)
        self._config["lock_mode"] = mode
        if mode == "pin":
            self._config["pin_length"] = len(code)
        else:
            self._config.pop("pin_length", None)
        self._write_config()

    @_locked
    def get_settings(self) -> dict:
        return dict(self._vault().settings)

    @_locked
    def save_settings(self, changes: dict) -> dict:
        v = self._vault()
        if "autolock_minutes" in changes:
            v.settings["autolock_minutes"] = max(0, int(changes["autolock_minutes"]))
        if changes.get("view") in ("list", "grid"):
            v.settings["view"] = changes["view"]
        self._save()
        return dict(v.settings)

    # ---------------------------------------------------------------- sauvegardes
    @_locked
    def list_backups(self) -> list[dict]:
        out = []
        for p in self._store.list_backups():
            try:
                d = datetime.strptime(p.stem[len("vault-"):][:15], "%Y%m%d-%H%M%S").strftime("%d/%m/%Y %H:%M:%S")
            except ValueError:
                d = p.stem
            out.append({"name": p.name, "date": d})
        return out

    def restore_backup(self, name: str) -> dict:
        with self._mutex:
            self._restore_backup(name)
            # le coffre a été remplacé sous une synchro ouverte : on l'arrête, comme lock()
            run = self._detach_sync()
        self._stop_sync(run)  # hors du mutex : voir _stop_sync
        return {}

    def _restore_backup(self, name: str) -> None:
        if "/" in name or "\\" in name:
            raise ValueError("Sauvegarde introuvable")
        self._store.restore(self._store.backup_dir / name)
        # nouvelle génération (jeton aléatoire) : chaque téléphone saura que le coffre a été remplacé
        # (et non modifié) et devra redonner le code du PC
        self._config["generation"] = new_id()
        self._write_config()
        self._corrupt = False
        try:
            self._store.reload()
        except CryptoError:
            self._store.forget_key()  # sauvegarde d'un autre code : il faudra le saisir
        except VaultCorrupt:
            self._corrupt = True

    # ---------------------------------------------------------------- comptes
    @_locked
    def list_accounts(self, profile_id: str | None) -> list[dict]:
        items = [a for a in self._vault().accounts if self._in_profile(profile_id)(a)]
        items.sort(key=lambda a: (not a.favorite, normalize(a.name)))
        return [asdict(a) for a in items]

    @_locked
    def save_account(self, data: dict) -> dict:
        v = self._vault()
        name = str(data.get("name") or "").strip()
        if not name:
            raise ValueError("Le nom est obligatoire")
        profiles = self._check_profiles(data.get("profiles"))
        existing = next((a for a in v.accounts if a.id == data.get("id")), None)
        category = self._category_label(str(data.get("category") or ""))
        acc = Account(
            id=existing.id if existing else new_id(),
            name=name,
            category=category,
            login=str(data.get("login") or "").strip(),
            password=str(data.get("password") or ""),
            login_mask=(data.get("login_mask") or None),
            password_mask=(data.get("password_mask") or None),
            image=data.get("image") or None,
            favorite=bool(data.get("favorite")),
            profiles=profiles,
            created=existing.created if existing else now_iso(),
            updated=now_iso(),
        )
        if existing:
            v.accounts[v.accounts.index(existing)] = acc
        else:
            v.accounts.append(acc)
        self._save()
        return asdict(acc)

    def _category_label(self, category: str) -> str:
        """« banque » devient « Banque » si cette catégorie existe déjà (évite les doublons de casse/accents)."""
        category = re.sub(r"\s+", " ", category).strip()
        key = normalize(category)
        for a in self._vault().accounts:
            if a.category and normalize(a.category) == key:
                return a.category
        return category

    @_locked
    def delete_account(self, account_id: str) -> dict:
        v = self._vault()
        v.accounts = [a for a in v.accounts if a.id != account_id]
        v.deleted.append(tombstone("account", account_id, now_iso()))
        self._save()
        return {}

    @_locked
    def bulk_update(self, ids: list[str], changes: dict) -> dict:
        v = self._vault()
        ids = set(ids)
        valid = self._profile_ids()
        add = [p for p in changes.get("add_profiles") or [] if p in valid]
        remove = set(changes.get("remove_profiles") or [])
        category = self._category_label(str(changes.get("category") or ""))
        for a in v.accounts:
            if a.id not in ids:
                continue
            if category:
                a.category = category
            profiles = list(dict.fromkeys([*a.profiles, *add]))
            kept = [p for p in profiles if p not in remove]
            a.profiles = kept or profiles  # un compte garde toujours au moins un profil
            a.updated = now_iso()
        self._save()
        return {}

    # ---------------------------------------------------------------- cartes cadeaux
    @_locked
    def list_giftcards(self, profile_id: str | None) -> list[dict]:
        items = [g for g in self._vault().giftcards if self._in_profile(profile_id)(g)]
        return [asdict(g) for g in items]

    @staticmethod
    def _money(value, allow_none=False):
        if value is None or value == "":
            if allow_none:
                return None
            return 0.0
        value = round(float(value), 2)
        if value < 0:
            raise ValueError("Les montants ne peuvent pas être négatifs")
        return value

    @_locked
    def save_giftcard(self, data: dict) -> dict:
        v = self._vault()
        name = str(data.get("name") or "").strip()
        if not name:
            raise ValueError("Le nom est obligatoire")
        end = data.get("end_date") or None
        if end:
            date.fromisoformat(end)  # lève ValueError si la date est invalide
        existing = next((g for g in v.giftcards if g.id == data.get("id")), None)
        card = GiftCard(
            id=existing.id if existing else new_id(),
            name=name,
            code=str(data.get("code") or "").strip(),
            pin=str(data.get("pin") or "").strip(),
            initial=self._money(data.get("initial"), allow_none=True),
            remaining=self._money(data.get("remaining")),
            end_date=end,
            image=data.get("image") or None,
            profiles=self._check_profiles(data.get("profiles")),
            history=existing.history if existing else [],
            updated=now_iso(),
        )
        if existing:
            v.giftcards[v.giftcards.index(existing)] = card
        else:
            v.giftcards.append(card)
        self._save()
        return asdict(card)

    @_locked
    def delete_giftcard(self, card_id: str) -> dict:
        v = self._vault()
        v.giftcards = [g for g in v.giftcards if g.id != card_id]
        v.deleted.append(tombstone("giftcard", card_id, now_iso()))
        self._save()
        return {}

    @_locked
    def spend(self, card_id: str, amount: float) -> dict:
        v = self._vault()
        card = next((g for g in v.giftcards if g.id == card_id), None)
        if card is None:
            raise ValueError("Carte introuvable")
        new = gc_logic.spend(card, amount, self._today())
        v.giftcards[v.giftcards.index(card)] = new
        self._save()
        return asdict(new)

    # ---------------------------------------------------------------- profils
    @_locked
    def save_profile(self, data: dict) -> dict:
        v = self._vault()
        name = str(data.get("name") or "").strip()
        if not name:
            raise ValueError("Le nom est obligatoire")
        existing = next((p for p in v.profiles if p.id == data.get("id")), None)
        prof = Profile(id=existing.id if existing else new_id(), name=name,
                       avatar=data.get("avatar") or None,
                       color=data.get("color") if COLOR_RE.match(str(data.get("color") or ""))
                       else PALETTE[len(v.profiles) % len(PALETTE)],
                       updated=now_iso())
        if existing:
            v.profiles[v.profiles.index(existing)] = prof
        else:
            v.profiles.append(prof)
        self._save()
        return asdict(prof)

    @_locked
    def delete_profile(self, profile_id: str, reassign_to: str) -> dict:
        v = self._vault()
        if len(v.profiles) <= 1:
            raise ValueError("Il faut garder au moins un profil")
        if reassign_to == profile_id or reassign_to not in self._profile_ids():
            raise ValueError("Choisis un autre profil pour récupérer les comptes")
        for item in [*v.accounts, *v.giftcards]:
            if profile_id in item.profiles:
                item.profiles = [p for p in item.profiles if p != profile_id] or [reassign_to]
                item.updated = now_iso()
        v.profiles = [p for p in v.profiles if p.id != profile_id]
        v.deleted.append(tombstone("profile", profile_id, now_iso()))
        self._save()
        return {}

    # ---------------------------------------------------------------- presse-papiers
    def _clear_pending_secret(self) -> bool:
        """Efface le secret copié s'il est encore dans le presse-papiers. Faux si celui-ci est occupé."""
        if not self._pending:
            return True
        current = self._clip.get()
        if current is None:
            return False  # presse-papiers momentanément inaccessible : on garde la tâche
        if current == self._pending[0]:
            self._clip.clear()
        self._pending = None
        return True

    @_locked
    def copy_secret(self, text: str) -> dict:
        self._clip.set(str(text), secret=True)
        self._pending = (str(text), self._clock() + CLIPBOARD_SECONDS)
        self._schedule(CLIPBOARD_SECONDS + 0.2, self.tick)
        return {}

    @_locked
    def copy_plain(self, text: str) -> dict:
        self._clip.set(str(text), secret=False)
        return {}

    @_locked
    def tick(self) -> None:
        """Efface le secret copié une fois le délai écoulé (si le presse-papiers le contient encore)."""
        if self._pending and self._clock() >= self._pending[1]:
            if not self._clear_pending_secret():
                self._schedule(1.0, self.tick)

    # ---------------------------------------------------------------- images
    # Les boîtes de dialogue s'ouvrent hors du verrou interne : sinon l'effacement du presse-papiers
    # et le verrouillage (session Windows, inactivité) attendraient leur fermeture.
    def _ask_file(self, kind: str) -> str | None:
        return self._dialogs.open_file(kind) if self._dialogs else None

    def pick_image(self) -> str | None:
        path = self._ask_file("image")
        if not path:
            return None
        return _normalize_image(Path(path).read_bytes())

    def normalize_image(self, data_url: str) -> str:
        return _normalize_image(data_url)

    # ---------------------------------------------------------------- import / premier lancement
    def _ensure_vault(self, profile_name: str) -> str:
        """Crée le coffre si besoin et renvoie l'id du profil de ce nom (créé s'il n'existe pas)."""
        if not self._store.exists():
            self._store.vault = Vault()
        v = self._vault()
        name = (profile_name or "").strip() or "Moi"
        prof = next((p for p in v.profiles if normalize(p.name) == normalize(name)), None)
        if prof is None:
            prof = Profile(id=new_id(), name=name, color=PALETTE[len(v.profiles) % len(PALETTE)])
            v.profiles.append(prof)
        return prof.id

    @_locked
    def start_empty(self, profile_name: str) -> dict:
        self._ensure_vault(profile_name)
        self._save()
        return {}

    def preview_import(self, path: str | None) -> dict | None:
        """Simule un import sur une copie du coffre : renvoie {path, added, skipped} sans rien modifier."""
        with self._mutex:
            self._vault()
        path = path or self._ask_file("excel")
        if not path:
            return None
        with self._mutex:
            copy = Vault.from_dict(self._vault().to_dict())
            pid = copy.profiles[0].id if copy.profiles else "?"
            try:
                added, skipped = import_xlsx(Path(path), copy, pid)
            except Exception as e:
                raise ValueError("Impossible de lire ce fichier Excel") from e
            return {"path": str(path), "added": added, "skipped": skipped}

    def import_excel(self, path: str | None, profile_name: str) -> dict | None:
        path = path or self._ask_file("excel")
        if not path:
            return None
        with self._mutex:
            first_launch = not self._store.exists()
            original = None if first_launch else self._vault()
            # l'import travaille sur une copie : en cas d'échec, rien n'est modifié
            self._store.vault = Vault() if first_launch else Vault.from_dict(original.to_dict())
            try:
                pid = self._ensure_vault(profile_name)
                added, skipped = import_xlsx(Path(path), self._store.vault, pid)
                self._save()
            except Exception as e:
                self._store.vault = original
                raise ValueError("Impossible de lire ce fichier Excel") from e
            return {"added": added, "skipped": skipped}

    @_locked
    def set_images(self, accounts: dict, giftcards: dict) -> int:
        """Pose des logos sur les comptes / cartes qui n'ont pas d'image, en un seul enregistrement."""
        v = self._vault()
        n = 0
        for items, wanted in ((v.accounts, accounts or {}), (v.giftcards, giftcards or {})):
            for item in items:
                img = wanted.get(item.id)
                if img and not item.image and str(img).startswith("data:image/png;base64,"):
                    item.image = img
                    item.updated = now_iso()
                    n += 1
        if n:
            self._save()
        return n

    @_locked
    def replace_images(self, accounts: dict, giftcards: dict | None = None) -> int:
        """Remplace des logos ({id: [ancien, nouveau]}) seulement si l'image actuelle est exactement l'ancienne.

        Sert à mettre à jour les logos de la bibliothèque sans jamais toucher une image choisie à la main.
        """
        v = self._vault()
        n = 0
        for items, wanted in ((v.accounts, accounts or {}), (v.giftcards, giftcards or {})):
            for item in items:
                pair = wanted.get(item.id)
                if (pair and len(pair) == 2 and item.image and item.image == pair[0]
                        and str(pair[1]).startswith("data:image/png;base64,")):
                    item.image = pair[1]
                    item.updated = now_iso()
                    n += 1
        if n:
            self._save()
        return n

    # ---------------------------------------------------------------- fenêtre, dossiers
    @_locked
    def save_window(self, geom: dict) -> None:
        self._config["window"] = {k: geom.get(k) for k in ("width", "height", "x", "y", "maximized")}
        self._write_config()

    @_locked
    def open_backups_folder(self) -> dict:
        self._store.backup_dir.mkdir(parents=True, exist_ok=True)
        _open_folder(str(self._store.backup_dir))
        return {}

    # ---------------------------------------------------------------- synchro téléphone
    def _detach_sync(self) -> _SyncRun | None:
        """Retire la synchro en cours (à appeler sous le mutex) ; l'arrêter ensuite avec _stop_sync."""
        run, self._sync = self._sync, None
        return run

    @staticmethod
    def _stop_sync(run: _SyncRun | None) -> None:
        """Ferme la session et arrête le serveur. Ne jamais l'appeler en tenant le mutex : un message en
        cours tient le verrou de session et attend le mutex (close() n'attend pas, mais stop() peut
        attendre la boucle du serveur)."""
        if run is None:
            return
        if run.session is not None:
            run.session.close()
        server, run.server = run.server, None
        if server is not None:
            server.stop()

    def _sync_generation(self) -> str:
        """Jeton de génération du coffre (à appeler sous le mutex) : créé et enregistré s'il manque ou n'est
        pas une chaîne (config perdue, ancien compteur entier)."""
        g = self._config.get("generation")
        if not isinstance(g, str) or not g:
            g = self._config["generation"] = new_id()
            try:
                self._write_config()
            except OSError:
                pass  # jeton gardé en mémoire : au pire, nouveau jeton au prochain lancement (code redemandé)
        return g

    def _on_sync_message(self, run: _SyncRun, msg: dict) -> dict:
        # appelé depuis un thread du serveur HTTP : même mutex que l'interface
        with self._mutex:
            if self._sync is not run:
                return {"ok": False, "error": "closed", "message": "Synchronisation arrêtée sur le PC."}
            try:
                reply = run.flow.handle(msg)
            except Exception:
                run.error = "Erreur inattendue pendant la synchronisation."
                raise
            if reply.get("error") == "update_required":
                run.error = None  # pas une erreur côté PC : l'écran l'indique par flow.notice
            elif reply.get("ok") is False:
                run.error = reply.get("message")
            elif msg.get("type") == "sync":
                run.error = None
            return reply

    def _sync_timeout(self, run: _SyncRun) -> None:
        with self._mutex:
            if self._sync is not run:
                return
            server, run.server = run.server, None  # la synchro reste lisible : « expirée »
        run.session.close()
        if server is not None:
            server.stop()

    def sync_start(self) -> dict:
        with self._mutex:
            if self._lock_mode() == "none":
                raise ValueError("Définis d'abord un code de verrouillage (Réglages) pour synchroniser un téléphone.")
            self._vault()
            self._sync_generation()
            hosts = list(self._sync_hosts())
            if not hosts:
                raise ValueError("Aucun réseau local détecté : connecte le PC au Wi-Fi ou au câble de la box.")
            old = self._detach_sync()
        self._stop_sync(old)

        pc_name = os.environ.get("COMPUTERNAME") or socket.gethostname()
        key = os.urandom(32)
        flow = SyncFlow(self._store, self._lockout, self._persist_lockout, lambda: self._config, pc_name,
                        qr_key=key, apk_provider=lambda: apk_mod.find_apk())
        run = _SyncRun(flow, self._clock() + SYNC_SECONDS)
        run.session = SyncSession(key, lambda msg: self._on_sync_message(run, msg), run.deadline, self._clock)
        run.server = self._sync_server(run.session)
        run.server.start()
        with self._mutex:
            old, self._sync = self._sync, run
        self._stop_sync(old)
        self._schedule(SYNC_SECONDS + 0.2, lambda: self._sync_timeout(run))
        qr = qr_svg({"v": 1, "hosts": hosts, "port": run.server.port, "key": b64u(key), "pc": pc_name})
        return {"qr": qr, "seconds": SYNC_SECONDS, "hosts": hosts}

    def sync_status(self) -> dict:
        with self._mutex:
            run = self._sync
            if run is None:
                return {"state": "closed", "seconds_left": 0, "device": None, "summary": None, "error": None,
                        "notice": None, "update": False}
            state = run.session.status  # lu sans le verrou de session
            left = max(0, math.ceil(run.deadline - self._clock())) if state in ("waiting", "syncing") else 0
            out = {"state": state, "seconds_left": left, "device": run.flow.device_name,
                   "summary": run.flow.summary, "error": run.error, "notice": run.flow.notice,
                   "update": run.flow.update_required}  # téléphone trop ancien : lien « Installer l'appli »
            server = None
            if state not in ("waiting", "syncing"):
                server, run.server = run.server, None  # usage unique : plus rien à servir
        if server is not None:
            server.stop()
        return out

    def sync_stop(self) -> dict:
        with self._mutex:
            run = self._detach_sync()
        self._stop_sync(run)
        return {}

    # ---------------------------------------------------------------- installer l'appli Android depuis le PC
    # Indépendant de la synchro et du verrouillage (l'APK est public, aucune donnée en jeu).
    def get_app_info(self) -> dict:
        return {"version": VERSION, "apk": apk_mod.find_apk() is not None}

    def apk_install_start(self) -> dict:
        path = apk_mod.find_apk()
        info = apk_mod.apk_info(path)
        if path is None or info is None:
            raise ValueError("Aucune appli Android n'est incluse dans cette version de Passe-Partout.")
        hosts = list(self._sync_hosts())
        if not hosts:
            raise ValueError("Aucun réseau local détecté : connecte le PC au Wi-Fi ou au câble de la box.")
        with self._mutex:
            old, self._apk = self._apk, None
        if old is not None:
            self._stop_apk(old)  # hors du mutex
        token = secrets.token_urlsafe(16)
        server = self._apk_server(path, token, info["filename"])
        server.start()
        run = _ApkRun(server, self._clock() + APK_SECONDS)
        with self._mutex:
            old, self._apk = self._apk, run
        if old is not None:
            self._stop_apk(old)
        self._schedule(APK_SECONDS + 0.2, lambda: self._apk_timeout(run))
        urls = [f"http://{h}:{server.port}/{token}/{info['filename']}" for h in hosts]
        run.urls = urls
        return {"qr": qr_svg(urls[0]), "url": urls[0], "urls": urls, "seconds": APK_SECONDS,
                "version": info["version"]}

    def apk_qr(self, url: str) -> str:
        with self._mutex:
            run = self._apk
            known = run is not None and url in run.urls
        if not known:
            raise ValueError("Adresse inconnue : relance l'installation.")
        return qr_svg(url)

    @staticmethod
    def _stop_apk(run: _ApkRun) -> None:
        run.stopped = True
        run.server.stop()

    def _apk_timeout(self, run: _ApkRun) -> None:
        if not run.stopped:
            self._stop_apk(run)

    def apk_install_status(self) -> dict:
        with self._mutex:
            run = self._apk
            if run is None:
                return {"state": "closed", "seconds_left": 0, "downloads": 0}
            downloads = int(getattr(run.server, "downloads", 0))
            expired = self._clock() >= run.deadline
            left = 0 if expired else max(0, math.ceil(run.deadline - self._clock()))
            if downloads > 0:
                state = "done"  # le serveur reste ouvert jusqu'à l'échéance (second téléphone possible)
            else:
                state = "expired" if expired else "waiting"
        if expired and not run.stopped:
            self._stop_apk(run)
        return {"state": state, "seconds_left": left if state == "waiting" else 0, "downloads": downloads}

    def apk_install_stop(self) -> dict:
        with self._mutex:
            run, self._apk = self._apk, None
        if run is not None:
            self._stop_apk(run)
        return {}

    @_locked
    def list_devices(self) -> list[dict]:
        devices = self._vault().sync.get("devices", {})
        out = [{"id": k, "name": d.get("name"), "last_sync": d.get("last_sync")} for k, d in devices.items()]
        out.sort(key=lambda d: d["last_sync"] or "", reverse=True)
        return out

    @_locked
    def forget_device(self, device_id: str) -> dict:
        devices = self._vault().sync.setdefault("devices", {})
        if devices.pop(device_id, None) is not None:
            self._save()
        return {}

    # ---------------------------------------------------------------- export
    def export(self, kind: str, account_ids: list[str], giftcards) -> dict | None:
        with self._mutex:
            self._vault()  # refuse tout de suite si le coffre est verrouillé
        folder = self._dialogs.pick_folder() if self._dialogs else None
        if not folder:
            return None
        with self._mutex:
            return self._export(kind, account_ids, giftcards, Path(folder))

    def _export(self, kind, account_ids, giftcards, folder: Path) -> dict:
        v = self._vault()
        wanted = set(account_ids or [])
        accounts = [a for a in v.accounts if a.id in wanted]
        if giftcards is True:
            cards = list(v.giftcards)
        else:
            ids = set(giftcards or [])
            cards = [g for g in v.giftcards if g.id in ids]
        if kind == "txt":
            files = [export_text(accounts, cards, folder)]
        elif kind == "png":
            files = export_png(accounts, cards, folder)
        else:
            raise ValueError("Format d'export inconnu")
        return {"files": [str(f) for f in files]}
