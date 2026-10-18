"""Modèle de données : profils, comptes, cartes cadeaux et coffre complet."""
from __future__ import annotations

import uuid
from dataclasses import asdict, dataclass, field, fields
from datetime import datetime

DEFAULT_SETTINGS = {"autolock_minutes": 10, "view": "list"}


def new_id() -> str:
    return uuid.uuid4().hex


def now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _from_dict(cls, d: dict):
    """Construit une dataclass en ignorant les clés inconnues (compatibilité ascendante)."""
    names = {f.name for f in fields(cls)}
    return cls(**{k: v for k, v in d.items() if k in names})


@dataclass
class Profile:
    id: str
    name: str
    avatar: str | None = None
    color: str | None = None


@dataclass
class Account:
    id: str
    name: str
    category: str = ""
    login: str = ""
    password: str = ""
    login_mask: str | None = None
    password_mask: str | None = None
    image: str | None = None
    favorite: bool = False
    profiles: list[str] = field(default_factory=list)
    created: str = field(default_factory=now_iso)
    updated: str = field(default_factory=now_iso)


@dataclass
class GiftCard:
    id: str
    name: str
    code: str = ""
    pin: str = ""
    initial: float | None = None
    remaining: float = 0.0
    end_date: str | None = None  # "AAAA-MM-JJ"
    image: str | None = None
    profiles: list[str] = field(default_factory=list)
    history: list[dict] = field(default_factory=list)  # [{"date": "AAAA-MM-JJ", "amount": 12.5}]


@dataclass
class Vault:
    profiles: list[Profile] = field(default_factory=list)
    accounts: list[Account] = field(default_factory=list)
    giftcards: list[GiftCard] = field(default_factory=list)
    settings: dict = field(default_factory=lambda: dict(DEFAULT_SETTINGS))

    def to_dict(self) -> dict:
        return {
            "version": 1,
            "profiles": [asdict(p) for p in self.profiles],
            "accounts": [asdict(a) for a in self.accounts],
            "giftcards": [asdict(g) for g in self.giftcards],
            "settings": dict(self.settings),
        }

    @classmethod
    def from_dict(cls, d: dict) -> "Vault":
        return cls(
            profiles=[_from_dict(Profile, p) for p in d.get("profiles", [])],
            accounts=[_from_dict(Account, a) for a in d.get("accounts", [])],
            giftcards=[_from_dict(GiftCard, g) for g in d.get("giftcards", [])],
            settings={**DEFAULT_SETTINGS, **d.get("settings", {})},
        )
