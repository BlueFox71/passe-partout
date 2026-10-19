"""Fusion PC ↔ téléphone : réunit deux coffres sans jamais perdre de données en silence.

Faite sur le PC uniquement. Par élément (même `id`), la version au `updated` le plus récent gagne ;
si l'élément a été modifié des deux côtés depuis la dernière synchro, rien n'est perdu : les dépenses
des cartes sont fusionnées et la version perdante d'un compte ou d'une carte est gardée en copie.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, replace
from datetime import datetime, timedelta

from app.model import Vault, new_id

TOMBSTONE_DAYS = 180

# Champs ignorés pour juger qu'une version perdante diffère « réellement » (et mérite une copie)
_NOT_CONFLICT = {
    "account": frozenset({"id", "updated", "created", "favorite"}),
    "giftcard": frozenset({"id", "updated", "history", "remaining"}),
}
_COPY_SUFFIX = {"pc": " (copie PC)", "phone": " (copie téléphone)"}
_KINDS = (("profile", "profiles"), ("account", "accounts"), ("giftcard", "giftcards"))


@dataclass
class MergeResult:
    vault: Vault          # settings et sync repris du PC
    to_pc: int            # éléments ajoutés/modifiés/supprimés côté PC
    to_phone: int         # idem côté téléphone
    deleted: int          # éléments supprimés (d'un côté ou de l'autre) à cause d'une pierre tombale
    conflicts: int        # copies de conflit créées


def _content(item, ignored=frozenset({"updated"})) -> dict:
    return {k: v for k, v in asdict(item).items() if k not in ignored}


def _graves(deleted: list[dict]) -> dict:
    """Pierres tombales indexées par (kind, id), en gardant la plus récente."""
    out = {}
    for t in deleted:
        key = (t["kind"], t["id"])
        if key not in out or t["at"] > out[key]["at"]:
            out[key] = dict(t)
    return out


def _merge_history(winner, loser) -> None:
    """Ajoute au gagnant les dépenses connues seulement du perdant et les retire de son solde."""
    known = {h["id"] for h in winner.history}
    extra = [h for h in loser.history if h["id"] not in known]
    if extra:
        winner.history = sorted([*winner.history, *extra], key=lambda h: h.get("date") or "")
        winner.remaining = max(0.0, round(winner.remaining - sum(h["amount"] for h in extra), 2))


def _resolve(kind, pc_item, phone_item, last_sync, now):
    """Départage deux versions d'un même élément : (version gardée, copie de conflit éventuelle)."""
    if _content(pc_item) == _content(phone_item):
        return pc_item, None
    pc_wins = pc_item.updated >= phone_item.updated  # égalité → PC
    winner, loser = (pc_item, phone_item) if pc_wins else (phone_item, pc_item)
    both = last_sync is None or (pc_item.updated > last_sync and phone_item.updated > last_sync)
    if not both or kind == "profile":
        return winner, None
    if kind == "giftcard":
        _merge_history(winner, loser)
    ignored = _NOT_CONFLICT[kind]
    if _content(winner, ignored) == _content(loser, ignored):
        return winner, None
    copy = replace(loser, id=new_id(), name=loser.name + _COPY_SUFFIX["phone" if pc_wins else "pc"],
                   updated=now)
    if kind == "giftcard":
        copy.history = []
    return winner, copy


def _merge_kind(kind, pc_items, phone_items, pc_graves, phone_graves, last_sync, now, fix):
    """Fusionne une liste d'éléments : (résultat, nb supprimés par pierre tombale, nb de copies)."""
    pc_by_id = {i.id: i for i in pc_items}
    phone_by_id = {i.id: i for i in phone_items}
    result, copies, deleted = [], [], 0
    for item_id in dict.fromkeys([*pc_by_id, *phone_by_id]):
        pc_item, phone_item = pc_by_id.get(item_id), phone_by_id.get(item_id)
        if pc_item and phone_item:
            item, copy = _resolve(kind, pc_item, phone_item, last_sync, now)
            if copy:
                copies.append(copy)
        else:
            # présent d'un seul côté : supprimé seulement si l'autre côté l'a effacé après sa dernière modif
            item, other_graves = (pc_item, phone_graves) if pc_item else (phone_item, pc_graves)
            grave = other_graves.get((kind, item_id))
            if grave and grave["at"] > item.updated:
                deleted += 1
                continue
        result.append(fix(item))
    # copies ajoutées à la fin ; pas de copie si le résultat contient déjà ce contenu (nouvelle tentative)
    conflicts = 0
    for copy in copies:
        sig = _content(fix(copy), _NOT_CONFLICT[kind])
        if not any(_content(x, _NOT_CONFLICT[kind]) == sig for x in result):
            result.append(copy)
            conflicts += 1
    return result, deleted, conflicts


def _changes(before: list, after: list) -> int:
    """Nombre d'éléments ajoutés, modifiés (hors `updated`) ou supprimés pour passer de before à after."""
    old = {i.id: _content(i) for i in before}
    new = {i.id: _content(i) for i in after}
    return sum(1 for item_id in old.keys() | new.keys() if old.get(item_id) != new.get(item_id))


def merge(pc: Vault, phone: Vault, last_sync: str | None, now: str) -> MergeResult:
    """Fusionne le coffre du PC et celui du téléphone. Ne modifie pas ses entrées."""
    orig_pc, orig_phone = pc, phone  # intacts : servent à compter les changements de chaque côté
    pc, phone = Vault.from_dict(pc.to_dict()), Vault.from_dict(phone.to_dict())
    pc_graves, phone_graves = _graves(pc.deleted), _graves(phone.deleted)
    merged, deleted, conflicts = {}, 0, 0
    valid: list[str] = []

    def fix(item):
        """Retire les profils disparus ; un élément sans profil va au premier profil restant."""
        if hasattr(item, "profiles"):
            item.profiles = [p for p in item.profiles if p in valid] or valid[:1]
        return item

    for kind, attr in _KINDS:  # profils d'abord : leurs ids servent à réparer les autres éléments
        items, n_deleted, n_conflicts = _merge_kind(kind, getattr(pc, attr), getattr(phone, attr),
                                                    pc_graves, phone_graves, last_sync, now, fix)
        merged[attr] = items
        deleted += n_deleted
        conflicts += n_conflicts
        if kind == "profile":
            valid = [p.id for p in items]

    # pierres tombales : union, sans celles dont l'élément a survécu ni celles trop anciennes
    survivors = {(kind, i.id) for kind, attr in _KINDS for i in merged[attr]}
    cutoff = (datetime.fromisoformat(now) - timedelta(days=TOMBSTONE_DAYS)).isoformat(timespec="seconds")
    graves = _graves([*pc.deleted, *phone.deleted])
    tombstones = [t for key, t in graves.items() if key not in survivors and t["at"] >= cutoff]

    vault = Vault(profiles=merged["profiles"], accounts=merged["accounts"], giftcards=merged["giftcards"],
                  settings=pc.settings, deleted=tombstones, sync=pc.sync)
    to_pc = sum(_changes(getattr(orig_pc, attr), merged[attr]) for _, attr in _KINDS)
    to_phone = sum(_changes(getattr(orig_phone, attr), merged[attr]) for _, attr in _KINDS)
    return MergeResult(vault=vault, to_pc=to_pc, to_phone=to_phone, deleted=deleted, conflicts=conflicts)
