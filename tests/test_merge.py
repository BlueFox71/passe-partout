"""Fusion PC ↔ téléphone : aucune perte silencieuse, nouvelle tentative sans effet."""
from app.merge import TOMBSTONE_DAYS, merge
from app.model import Account, GiftCard, Profile, Vault, tombstone

LS = "2026-10-01T12:00:00"   # dernière synchro
NOW = "2026-10-19T12:00:00"
OLD = "2026-09-01T10:00:00"  # avant la dernière synchro
T1 = "2026-10-05T10:00:00"   # après la dernière synchro
T2 = "2026-10-06T10:00:00"   # plus récent que T1


def acc(id, name, updated, **kw):
    kw.setdefault("profiles", ["p1"])
    kw.setdefault("created", "2026-01-01T00:00:00")
    return Account(id=id, name=name, updated=updated, **kw)


def card(id, name, updated, **kw):
    kw.setdefault("profiles", ["p1"])
    return GiftCard(id=id, name=name, updated=updated, **kw)


def vault(accounts=(), giftcards=(), deleted=(), profiles=None, **kw):
    if profiles is None:
        profiles = [Profile(id="p1", name="Jules", updated=OLD)]
    return Vault(profiles=list(profiles), accounts=list(accounts), giftcards=list(giftcards),
                 deleted=list(deleted), **kw)


def copy_of(v: Vault) -> Vault:
    return Vault.from_dict(v.to_dict())


def test_identical_vaults_no_change():
    pc = vault([acc("a1", "Netflix", OLD, password="x")],
               [card("g1", "Fnac", OLD, remaining=20.0, history=[{"id": "h0", "date": "2026-08-01", "amount": 5}])])
    r = merge(pc, copy_of(pc), LS, NOW)
    assert r.to_pc == r.to_phone == r.conflicts == r.deleted == 0
    assert r.vault.to_dict() == pc.to_dict()


def test_new_on_phone_goes_to_pc():
    pc = vault([acc("a1", "Netflix", OLD)])
    phone = vault([acc("a1", "Netflix", OLD), acc("a2", "Spotify", T1)])
    r = merge(pc, phone, LS, NOW)
    assert [a.id for a in r.vault.accounts] == ["a1", "a2"]
    assert r.to_pc == 1 and r.to_phone == 0


def test_new_on_pc_goes_to_phone():
    pc = vault([acc("a1", "Netflix", OLD)], [card("g1", "Fnac", T1, remaining=10.0)])
    phone = vault([acc("a1", "Netflix", OLD)])
    r = merge(pc, phone, LS, NOW)
    assert [g.id for g in r.vault.giftcards] == ["g1"]
    assert r.to_pc == 0 and r.to_phone == 1


def test_newer_version_wins_when_one_side_changed():
    pc = vault([acc("a1", "Netflix", T1, password="nouveau")])
    phone = vault([acc("a1", "Netflix", OLD, password="ancien")])
    r = merge(pc, phone, LS, NOW)
    assert [(a.name, a.password) for a in r.vault.accounts] == [("Netflix", "nouveau")]
    assert r.conflicts == 0 and r.to_pc == 0 and r.to_phone == 1


def test_older_pc_loses_to_newer_phone_when_only_phone_changed():
    pc = vault([acc("a1", "Netflix", OLD, password="ancien")])
    phone = vault([acc("a1", "Netflix", T1, password="nouveau")])
    r = merge(pc, phone, LS, NOW)
    assert [a.password for a in r.vault.accounts] == ["nouveau"]
    assert r.conflicts == 0 and r.to_pc == 1 and r.to_phone == 0


def test_tie_goes_to_pc():
    pc = vault([acc("a1", "Netflix", OLD, password="pc")])
    phone = vault([acc("a1", "Netflix", OLD, password="tel")])
    r = merge(pc, phone, LS, NOW)
    assert [a.password for a in r.vault.accounts] == ["pc"]


def test_tombstone_newer_than_item_deletes():
    pc = vault(deleted=[tombstone("account", "a1", T1)])
    phone = vault([acc("a1", "Netflix", OLD)])
    r = merge(pc, phone, LS, NOW)
    assert r.vault.accounts == [] and r.deleted == 1
    assert r.to_phone == 1 and r.to_pc == 0
    assert r.vault.deleted == [tombstone("account", "a1", T1)]


def test_tombstone_from_phone_deletes_pc_item():
    pc = vault(giftcards=[card("g1", "Fnac", OLD)])
    phone = vault(deleted=[tombstone("giftcard", "g1", T1)])
    r = merge(pc, phone, LS, NOW)
    assert r.vault.giftcards == [] and r.deleted == 1 and r.to_pc == 1 and r.to_phone == 0


def test_item_modified_after_tombstone_survives():
    pc = vault(deleted=[tombstone("account", "a1", T1)])
    phone = vault([acc("a1", "Netflix", T2)])
    r = merge(pc, phone, LS, NOW)
    assert [a.id for a in r.vault.accounts] == ["a1"]
    assert r.vault.deleted == [] and r.deleted == 0 and r.to_pc == 1


def test_both_sides_spent_on_same_card():
    # base remaining 50 ; PC : dépense h1 de 10 → 40 ; téléphone : dépense h2 de 5 → 45 (plus récente)
    base = [{"id": "legacy-0", "date": "2026-08-01", "amount": 20}]
    pc = vault(giftcards=[card("g1", "Fnac", T1, initial=70.0, remaining=40.0,
                               history=[*base, {"id": "h1", "date": "2026-10-05", "amount": 10}])])
    phone = vault(giftcards=[card("g1", "Fnac", T2, initial=70.0, remaining=45.0,
                                  history=[*base, {"id": "h2", "date": "2026-10-06", "amount": 5}])])
    r = merge(pc, phone, LS, NOW)
    g = r.vault.giftcards[0]
    assert g.remaining == 35.0 and {h["id"] for h in g.history} == {"legacy-0", "h1", "h2"}
    assert [h["id"] for h in g.history] == ["legacy-0", "h1", "h2"]  # trié par date
    assert r.conflicts == 0 and len(r.vault.giftcards) == 1


def test_merged_spending_never_goes_below_zero():
    pc = vault(giftcards=[card("g1", "Fnac", T1, remaining=0.0,
                               history=[{"id": "h1", "date": "2026-10-05", "amount": 10}])])
    phone = vault(giftcards=[card("g1", "Fnac", T2, remaining=3.0,
                                  history=[{"id": "h2", "date": "2026-10-06", "amount": 7}])])
    r = merge(pc, phone, LS, NOW)
    assert r.vault.giftcards[0].remaining == 0.0


def test_account_changed_both_sides_keeps_copy():
    # même compte, mot de passe changé des deux côtés, PC plus récent
    pc = vault([acc("a1", "Netflix", T2, password="pc")])
    phone = vault([acc("a1", "Netflix", T1, password="tel")])
    r = merge(pc, phone, LS, NOW)
    assert [a.name for a in r.vault.accounts] == ["Netflix", "Netflix (copie téléphone)"] and r.conflicts == 1
    main, copy = r.vault.accounts
    assert main.id == "a1" and main.password == "pc"
    assert copy.id != "a1" and copy.password == "tel" and copy.profiles == ["p1"] and copy.updated == NOW
    assert r.to_pc == 1 and r.to_phone == 2


def test_phone_newer_keeps_pc_copy():
    pc = vault(giftcards=[card("g1", "Fnac", T1, code="AAA", remaining=10.0,
                               history=[{"id": "h1", "date": "2026-10-05", "amount": 5}])])
    phone = vault(giftcards=[card("g1", "Fnac", T2, code="BBB", remaining=15.0)])
    r = merge(pc, phone, LS, NOW)
    assert [(g.name, g.code) for g in r.vault.giftcards] == [("Fnac", "BBB"), ("Fnac (copie PC)", "AAA")]
    main, copy = r.vault.giftcards
    assert main.remaining == 10.0 and [h["id"] for h in main.history] == ["h1"]
    assert copy.history == [] and copy.updated == NOW and r.conflicts == 1


def test_no_last_sync_counts_as_modified_both_sides():
    pc = vault([acc("a1", "Netflix", OLD, password="pc")])
    phone = vault([acc("a1", "Netflix", "2026-08-01T10:00:00", password="tel")])
    r = merge(pc, phone, None, NOW)
    assert [a.name for a in r.vault.accounts] == ["Netflix", "Netflix (copie téléphone)"]


def test_favorite_only_difference_no_copy():
    pc = vault([acc("a1", "Netflix", T2, favorite=True)])
    phone = vault([acc("a1", "Netflix", T1, favorite=False)])
    r = merge(pc, phone, LS, NOW)
    assert [(a.name, a.favorite) for a in r.vault.accounts] == [("Netflix", True)] and r.conflicts == 0


def test_profiles_never_copied():
    pc = vault(profiles=[Profile(id="p1", name="Jules", updated=T1)])
    phone = vault(profiles=[Profile(id="p1", name="Julien", updated=T2)])
    r = merge(pc, phone, LS, NOW)
    assert [p.name for p in r.vault.profiles] == ["Julien"] and r.conflicts == 0


def test_retry_after_lost_response_is_idempotent():
    pc = vault([acc("a1", "Netflix", T2, password="pc")],
               [card("g1", "Fnac", T1, remaining=40.0, history=[{"id": "h1", "date": "2026-10-05", "amount": 10}])])
    phone = vault([acc("a1", "Netflix", T1, password="tel")],
                  [card("g1", "Fnac", T2, remaining=45.0, history=[{"id": "h2", "date": "2026-10-06", "amount": 5}])])
    first = merge(pc, phone, LS, NOW)
    again = merge(first.vault, phone, LS, NOW)          # le téléphone renvoie son ancien état
    assert again.conflicts == 0 and again.to_pc == 0
    assert again.vault.giftcards[0].remaining == first.vault.giftcards[0].remaining
    assert again.vault.to_dict() == first.vault.to_dict()


def test_orphan_item_goes_to_first_profile():
    profiles = [Profile(id="p1", name="Jules", updated=OLD), Profile(id="p2", name="Léa", updated=OLD)]
    pc = vault([acc("a1", "Netflix", OLD, profiles=["p2"]), acc("a2", "Spotify", OLD, profiles=["p1", "p2"])],
               profiles=profiles)
    phone = vault([acc("a1", "Netflix", OLD, profiles=["p2"]), acc("a2", "Spotify", OLD, profiles=["p1", "p2"])],
                  profiles=profiles[:1], deleted=[tombstone("profile", "p2", T1)])
    r = merge(pc, phone, LS, NOW)
    assert [p.id for p in r.vault.profiles] == ["p1"] and r.deleted == 1
    assert [a.profiles for a in r.vault.accounts] == [["p1"], ["p1"]]
    assert r.to_pc == 3 and r.to_phone == 2  # PC : profil + 2 comptes ; téléphone : 2 comptes


def test_tombstones_older_than_180_days_purged():
    assert TOMBSTONE_DAYS == 180
    pc = vault(deleted=[tombstone("account", "old", "2026-04-01T00:00:00"),
                        tombstone("account", "recent", "2026-10-10T00:00:00")])
    phone = vault(deleted=[tombstone("giftcard", "g9", "2026-04-23T00:00:00")])  # 179 jours : gardée
    r = merge(pc, phone, LS, NOW)
    assert {t["id"] for t in r.vault.deleted} == {"recent", "g9"}


def test_tombstones_union_keeps_most_recent():
    pc = vault(deleted=[tombstone("account", "x", T1)])
    phone = vault(deleted=[tombstone("account", "x", T2)])
    r = merge(pc, phone, LS, NOW)
    assert r.vault.deleted == [tombstone("account", "x", T2)]


def test_settings_and_sync_come_from_pc():
    pc = vault(settings={"autolock_minutes": 5, "view": "grid"},
               sync={"devices": {"d1": {"name": "Pixel", "last_sync": LS}}})
    phone = vault(settings={"autolock_minutes": 1, "view": "list"}, sync={"devices": {}})
    r = merge(pc, phone, LS, NOW)
    assert r.vault.settings == {"autolock_minutes": 5, "view": "grid"}
    assert r.vault.sync == {"devices": {"d1": {"name": "Pixel", "last_sync": LS}}}


def test_inputs_not_mutated():                         # to_dict() des entrées identique avant/après
    profiles = [Profile(id="p1", name="Jules", updated=OLD), Profile(id="p2", name="Léa", updated=OLD)]
    pc = vault([acc("a1", "Netflix", T2, password="pc", profiles=["p2"])],
               [card("g1", "Fnac", T1, remaining=40.0, history=[{"id": "h1", "date": "2026-10-05", "amount": 10}])],
               profiles=profiles, sync={"devices": {"d1": {"name": "Pixel", "last_sync": LS}}})
    phone = vault([acc("a1", "Netflix", T1, password="tel", profiles=["p2"])],
                  [card("g1", "Fnac", T2, remaining=45.0, history=[{"id": "h2", "date": "2026-10-06", "amount": 5}])],
                  profiles=profiles[:1], deleted=[tombstone("profile", "p2", T1)])
    before = (pc.to_dict(), phone.to_dict())
    r = merge(pc, phone, LS, NOW)
    assert (pc.to_dict(), phone.to_dict()) == before
    r.vault.sync["devices"]["d1"]["name"] = "autre"
    r.vault.giftcards[0].history.append({"id": "hx", "date": "2026-10-19", "amount": 1})
    assert (pc.to_dict(), phone.to_dict()) == before


def test_phone_version_adopted_gets_now_timestamp():
    pc = vault([acc("a1", "Netflix", OLD, password="ancien")])
    phone = vault([acc("a1", "Netflix", T1, password="nouveau")])
    r = merge(pc, phone, LS, NOW)
    assert r.vault.accounts[0].updated == NOW


def test_unchanged_pc_version_keeps_its_timestamp():
    pc = vault([acc("a1", "Netflix", T2, password="nouveau")])
    phone = vault([acc("a1", "Netflix", OLD, password="ancien")])
    r = merge(pc, phone, LS, NOW)
    assert r.vault.accounts[0].updated == T2


def test_two_phones_spend_not_lost():
    oct5, oct6, oct7, oct8, oct9, oct10 = (f"2026-10-{d:02d}T10:00:00" for d in (5, 6, 7, 8, 9, 10))
    h1 = {"id": "h1", "date": "2026-10-05", "amount": 10}
    h2 = {"id": "h2", "date": "2026-10-06", "amount": 5}
    h3 = {"id": "h3", "date": "2026-10-09", "amount": 1}
    pc = vault(giftcards=[card("g1", "Fnac", oct5, remaining=40.0, history=[h1])])
    phone_c = copy_of(pc)                                       # C se synchronise le 7 octobre
    phone_a = vault(giftcards=[card("g1", "Fnac", oct6, remaining=45.0, history=[h2])])  # A : dernière synchro le 1er
    after_a = merge(pc, phone_a, LS, oct8).vault
    phone_c.giftcards[0] = card("g1", "Fnac", oct9, remaining=39.0, history=[h1, h3])
    r = merge(after_a, phone_c, oct7, oct10)
    g = r.vault.giftcards[0]
    assert [h["id"] for h in g.history] == ["h1", "h2", "h3"] and g.remaining == 34.0
    assert r.conflicts == 0


def test_two_phones_account_edit_not_lost():
    oct6, oct7, oct8, oct9, oct10 = (f"2026-10-{d:02d}T10:00:00" for d in (6, 7, 8, 9, 10))
    pc = vault([acc("a1", "Netflix", OLD, password="base")])
    phone_c = copy_of(pc)                                       # C se synchronise le 7 octobre
    phone_a = vault([acc("a1", "Netflix", oct6, password="A")])  # A : dernière synchro le 1er
    after_a = merge(pc, phone_a, LS, oct8).vault
    phone_c.accounts[0] = acc("a1", "Netflix", oct9, password="C")
    r = merge(after_a, phone_c, oct7, oct10)
    assert sorted((a.name, a.password) for a in r.vault.accounts) == [("Netflix", "C"), ("Netflix (copie PC)", "A")]
    assert r.conflicts == 1


def test_retry_is_idempotent_when_phone_won_first_time():
    pc = vault([acc("a1", "Netflix", T1, password="pc")],
               [card("g1", "Fnac", T1, remaining=40.0, history=[{"id": "h1", "date": "2026-10-05", "amount": 10}])])
    phone = vault([acc("a1", "Netflix", T2, password="tel")],
                  [card("g1", "Fnac", T2, remaining=45.0, history=[{"id": "h2", "date": "2026-10-06", "amount": 5}])])
    first = merge(pc, phone, LS, NOW)
    assert [a.name for a in first.vault.accounts] == ["Netflix", "Netflix (copie PC)"]
    again = merge(first.vault, phone, LS, NOW)
    assert again.conflicts == 0 and again.to_pc == 0
    assert again.vault.to_dict() == first.vault.to_dict()


# ---------------------------------------------------------------- contrat d'horodatage du téléphone (Ruling 8)
# Quand le PC adopte la version d'un téléphone, il la date de l'heure de la synchro (Ruling 4) : l'élément
# porte alors updated == last_sync. Le téléphone peut avoir jusqu'à 5 min de retard sur le PC (MAX_SKEW_SECONDS) :
# une modification datée de sa seule horloge pourrait tomber AVANT last_sync, et la fusion la croirait antérieure
# à la synchro (ni « plus récente » ni « modifiée des deux côtés ») → perdue sans copie. D'où le contrat : le
# téléphone date toute modification (élément ou pierre tombale) de max(maintenant, last_sync + 1 s,
# updated précédent + 1 s).
LS_PLUS_1 = "2026-10-01T12:00:01"
LS_MINUS_30 = "2026-10-01T11:59:30"


def test_phone_edit_after_last_sync_survives_as_main_item():
    pc = vault([acc("a1", "Netflix", LS, password="adopté")])  # version adoptée à la dernière synchro
    phone = vault([acc("a1", "Netflix", LS_PLUS_1, password="modifié téléphone")])
    r = merge(pc, phone, LS, NOW)
    assert [a.password for a in r.vault.accounts] == ["modifié téléphone"]
    assert r.to_pc == 1 and r.conflicts == 0


def test_phone_edit_after_last_sync_survives_as_copy_when_pc_also_changed():
    pc = vault([acc("a1", "Netflix", T1, password="modifié PC")])
    phone = vault([acc("a1", "Netflix", LS_PLUS_1, password="modifié téléphone")])
    r = merge(pc, phone, LS, NOW)
    assert sorted(a.password for a in r.vault.accounts) == ["modifié PC", "modifié téléphone"]
    assert r.conflicts == 1


def test_phone_tombstone_after_last_sync_deletes_adopted_item():
    pc = vault([acc("a1", "Netflix", LS)])
    phone = vault(deleted=[tombstone("account", "a1", LS_PLUS_1)])
    r = merge(pc, phone, LS, NOW)
    assert r.vault.accounts == [] and r.deleted == 1


def test_phone_edit_stamped_before_last_sync_is_not_guaranteed():
    # horloge du téléphone en retard, contrat non respecté : la modification passe pour antérieure à la
    # synchro et la version du PC (adoptée à last_sync) l'emporte — c'est ce que le contrat évite
    pc = vault([acc("a1", "Netflix", LS, password="adopté")])
    phone = vault([acc("a1", "Netflix", LS_MINUS_30, password="modifié téléphone")])
    r = merge(pc, phone, LS, NOW)
    assert [a.password for a in r.vault.accounts] == ["adopté"] and r.conflicts == 0
