# Passe-Partout Mobile + synchronisation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Appli Android hors ligne (Capacitor) qui affiche et modifie le coffre Passe-Partout, synchronisée avec le logiciel PC par QR code sur le Wi-Fi local, sans perte de données.

**Architecture:** Côté PC : fusion pure (`app/merge.py`), enveloppe chiffrée + session + serveur HTTP (`app/sync.py`), logique du dialogue (`app/syncflow.py`), branchés dans `Api` et dans une fenêtre UI. Côté téléphone : UI web vanilla dans `mobile/www/` qui réutilise `ui/app.js` / `ui/logos.js` / `ui/style.css` (copiés au build) ; une `LocalApi` JS expose les mêmes noms de méthodes que l'`Api` Python, de sorte que `PP.call(...)` fonctionne tel quel ; un petit plugin Java maison gère Keystore, empreinte, presse-papiers sensible et `FLAG_SECURE`. Les modules JS sans dépendance au téléphone (crypto, fusion locale, lockout, client de synchro, LocalApi avec faux natif) sont testés sous Node (`node --test`).

**Tech Stack:** Python 3.13, cryptography, segno (QR, pur Python), pytest ; Node 22, Capacitor (dernière version stable ≥ 7 : core, cli, android, app, preferences, filesystem, device, barcode-scanner), WebCrypto, Java + androidx.biometric, JDK 21, Android SDK.

**Spec:** `docs/2026-10-19-mobile-conception.md` (le chemin `D:\Documents\App Web\…` qui y figure est obsolète : le dépôt est `D:\Documents\Logiciels persos\gestionnaire-mdp\`).

## Global Constraints

- Interface entièrement en français ; style néon identique au PC (variables et classes de `ui/style.css`).
- 100 % local : aucune requête Internet, ni du PC ni du téléphone ; aucune télémétrie ; aucun CDN.
- Jamais de mot de passe dans un `print`, un `console.log`, un message d'erreur, un fichier en clair ou une sortie de test sur les vraies données.
- Horodatages : format local naïf `AAAA-MM-JJTHH:MM:SS` (celui de `now_iso()`), identique PC et téléphone.
- Synchro : AES-256-GCM, clé de 32 octets aléatoires du QR, nonce de 12 octets aléatoire par message, serveur ouvert **120 s**, une seule synchro réussie par QR.
- QR : `{"v":1,"hosts":[IP…],"port":N,"key":<base64url>,"pc":"<nom du PC>"}`.
- Pierres tombales `{"kind":"account"|"giftcard"|"profile","id","at"}` gardées **180 jours** ; téléphone non synchronisé depuis plus de 180 jours → remplacement avec avertissement.
- Téléphone : PBKDF2-SHA256 **≥ 600 000** itérations ; verrouillage après **30 s** en arrière-plan et **5 min** d'inactivité par défaut ; presse-papiers vidé **30 s** après copie d'un secret ; délai croissant après codes faux `min(2^(n-1), 300)` s conservé au redémarrage.
- Paquet Android `fr.passepartout.app`, minSdk **28** (Android 9), APK `mobile/dist/passe-partout.apk`, clé de signature dans `%APPDATA%\GestionnaireMdp\android-signing\` (jamais dans le dépôt).
- Les réglages (`settings`) et le registre `sync` ne sont jamais envoyés au téléphone.

**Écarts assumés par rapport au spec** (à signaler à Jules dans le résumé final) :
- `generation` est stocké dans `config.json` (PC) et non dans le coffre : restaurer une sauvegarde remet aussi l'ancien coffre, donc un compteur dans le coffre reculerait. Le téléphone compare par `!=`. (Révisé : jeton aléatoire renouvelé à chaque restauration, et le code est redemandé après une restauration — Ruling 7.)
- Le serveur écoute sur `0.0.0.0` (le QR liste les IP privées) : tout message non chiffré avec la clé du QR est refusé, et le pare-feu Windows limite aux réseaux privés.
- Android n'a pas de permission « réseau local seulement » : l'APK déclare `INTERNET`, mais n'appelle que les IP du QR.

## Review Focus

1. **Horloges décalées** entre téléphone et PC (la plus récente version « gagne » à tort) → le PC refuse la synchro si l'écart dépasse 5 min, avec un message clair. → `test_hello_rejects_clock_skew` (Tâche 4).
2. **Wi-Fi coupé après l'enregistrement PC mais avant la réponse** : le téléphone renvoie son ancien état à la synchro suivante → aucune copie de conflit en double, aucune dépense comptée deux fois. → `test_retry_after_lost_response_is_idempotent` (Tâche 2).
3. **Données du téléphone mal formées** (ancienne version, bug, champ manquant ou mal typé) → refus « invalid », fichier PC inchangé octet pour octet. → `test_sync_invalid_payload_leaves_pc_untouched` (Tâche 4).
4. **PC verrouillé (auto-verrouillage, session Windows) pendant que le QR est affiché** → la session se ferme, le téléphone reçoit « QR expiré », rien n'est écrit. → `test_lock_closes_sync_session` (Tâche 5).
5. **PC injoignable** (autre Wi-Fi, pare-feu refusé, IP de VPN dans le QR) → le téléphone essaie chaque IP avec un délai court puis affiche « PC injoignable : … pare-feu … ». → `test_all_hosts_unreachable` (Tâche 12).

---

## Structure des fichiers

```
app/
  model.py        (mod.) updated sur GiftCard/Profile, Vault.deleted, Vault.sync, id des dépenses
  giftcards.py    (mod.) spend() donne un id à la dépense
  api.py          (mod.) horodatages, pierres tombales, generation, méthodes sync_* / devices
  store.py        (mod.) verify_code(), code_version()
  merge.py        (new)  merge() pure
  sync.py         (new)  seal/open_sealed, SyncSession, SyncServer, private_ipv4s, qr_svg
  syncflow.py     (new)  SyncFlow : hello / sync / cancel, validation des données du téléphone
tools/make_sync_vector.py  (new) écrit tests/fixtures/sync_vector.json (vecteur partagé Python/JS)
tests/  test_model_sync.py test_merge.py test_sync.py test_syncflow.py test_api_sync.py
ui/  app.js (mod. : touchstart)  index.html  style.css  mock-api.js  views/main.js  views/settings.js
     views/sync.js (new) fenêtre QR
mobile/
  package.json  capacitor.config.json  build.ps1  .gitignore
  scripts/assemble.mjs            copie ui/app.js, logos.js, style.css, assets/icon.svg → www/shared/
  resources/                      icônes générées par tools/make_icon.py --android
  www/index.html  www/mobile.css
  www/js/crypto.js       PPM.crypto   (WebCrypto : enveloppe de synchro, PBKDF2, coffre local)
  www/js/lockout.js      PPM.Lockout
  www/js/vaultlogic.js   PPM.vault    (validation + modifications du coffre, pierres tombales)
  www/js/syncclient.js   PPM.parseQr, PPM.SyncClient
  www/js/native.js       PPM.native   (Capacitor + plugin maison)
  www/js/native-fake.js  PPM.nativeFake (tests Node + aperçu navigateur)
  www/js/local-api.js    PPM.LocalApi (mêmes noms que l'Api Python)
  www/js/boot.js         choix du natif, PP.api, routes, auto-verrouillage
  www/views/ lock.js welcome.js shell.js accounts.js account-form.js cards.js sync.js settings.js
  test/*.test.js
  android/  (généré par cap add android) + PassePartoutPlugin.java, MainActivity.java, network_security_config.xml
```

Modèle de module JS (tous les fichiers `www/js/*.js`), pour être chargés par `<script>` et par `require()` :
`(function (root) { const api = {…}; root.PPM = root.PPM || {}; root.PPM.crypto = api; if (typeof module === "object") module.exports = api; })(typeof window !== "undefined" ? window : globalThis);`
`mobile/package.json` ne doit **pas** contenir `"type": "module"`.

---

### Task 1: Modèle prêt pour la synchro (PC)

**Files:**
- Modify: `app/model.py`, `app/giftcards.py`, `app/api.py`
- Test: `tests/test_model_sync.py`

**Interfaces:**
- Produces:
  - `Profile.updated: str`, `GiftCard.updated: str` (défaut `now_iso()`).
  - `Vault.deleted: list[dict]` (pierres tombales), `Vault.sync: dict` (défaut `{"devices": {}}`), tous deux dans `to_dict()` / `from_dict()`.
  - Toute entrée d'historique a une clé `id` ; `Vault.from_dict` donne aux entrées sans `id` l'id déterministe `f"legacy-{index}"` (même résultat sur PC et téléphone, puisque les données viennent de la même source).
  - `model.tombstone(kind: str, item_id: str, at: str) -> dict`.
  - `Api` : `config.json["generation"]` (int, défaut 0), incrémenté par `restore_backup`.

- [ ] **Step 1: Écrire les tests**

```python
def test_old_vault_loads_with_defaults():
    v = Vault.from_dict({"profiles": [{"id": "p1", "name": "Jules"}], "accounts": [],
                         "giftcards": [{"id": "g1", "name": "Fnac", "history": [{"date": "2026-01-02", "amount": 5}]}]})
    assert v.deleted == [] and v.sync == {"devices": {}}
    assert v.giftcards[0].history[0]["id"] == "legacy-0"
    assert v.profiles[0].updated and v.giftcards[0].updated

def test_roundtrip_keeps_deleted_and_sync():  # to_dict -> from_dict conserve deleted et sync

def test_spend_gives_history_id():
    card = gc_logic.spend(GiftCard(id="g", name="x", remaining=10), 3, date(2026, 10, 19))
    assert card.history[-1]["id"] and card.history[-1]["amount"] == 3.0

# dans le même fichier, avec les fixtures Api de tests/test_api.py (les importer)
def test_delete_account_adds_tombstone(api):        # kind "account", id, at non vide
def test_delete_giftcard_adds_tombstone(api):
def test_delete_profile_adds_tombstone_and_touches_reassigned(api):  # comptes réassignés : updated changé
def test_save_giftcard_and_spend_update_timestamp(api):
def test_save_profile_updates_timestamp(api):
def test_set_and_replace_images_update_timestamp(api):
def test_restore_backup_increments_generation(api):  # config.json["generation"] passe de 0 à 1
```

- [ ] **Step 2: Lancer** `.venv\Scripts\python -m pytest tests/test_model_sync.py -v` → échecs attendus (champs absents).
- [ ] **Step 3: Implémenter.** `updated=now_iso()` à chaque modification dans : `save_giftcard`, `spend`, `save_profile`, `delete_profile` (éléments réassignés), `set_images`, `replace_images` (éléments touchés). `delete_account` / `delete_giftcard` / `delete_profile` ajoutent `tombstone(...)` à `v.deleted`. `restore_backup` incrémente `self._config["generation"]` puis `_write_config()`, même si la sauvegarde restaurée est d'un autre code.
- [ ] **Step 4: Lancer toute la suite** `.venv\Scripts\python -m pytest -q` → tout passe (les anciens tests aussi).
- [ ] **Step 5: Commit** `feat(sync): horodatages, pierres tombales et génération dans le modèle`

---

### Task 2: Fusion PC ↔ téléphone

**Files:**
- Create: `app/merge.py`
- Test: `tests/test_merge.py`

**Interfaces:**
- Consumes: modèle de la Tâche 1.
- Produces:
```python
@dataclass
class MergeResult:
    vault: Vault          # settings et sync repris du PC
    to_pc: int            # éléments ajoutés/modifiés/supprimés côté PC
    to_phone: int         # idem côté téléphone
    deleted: int          # éléments supprimés (d'un côté ou de l'autre) à cause d'une pierre tombale
    conflicts: int        # copies de conflit créées

TOMBSTONE_DAYS = 180
def merge(pc: Vault, phone: Vault, last_sync: str | None, now: str) -> MergeResult  # ne modifie pas ses entrées
```

Règles (spec §5) — pour chaque type (profils, comptes, cartes), par `id` :
- Présent des deux côtés, contenus égaux hors `updated` → inchangé.
- Sinon le `updated` le plus récent gagne (égalité → PC). « Modifié des deux côtés » = `pc.updated > last_sync` **et** `phone.updated > last_sync` (`last_sync is None` → vrai).
  - Carte modifiée des deux côtés : historique = gagnant + entrées présentes seulement chez le perdant (triées par date) ; `remaining = max(0, round(gagnant.remaining − somme de ces entrées, 2))`.
  - Compte (champs hors `id/updated/created/favorite`) ou carte (hors `id/updated/history/remaining`) différents et modifiés des deux côtés → la version perdante est ajoutée en copie : nouvel id, nom `"<nom> (copie téléphone)"` ou `"<nom> (copie PC)"`, mêmes profils, `updated = now`, carte copiée avec `history = []`. **Pas de copie** si un élément du résultat a déjà ce contenu (même nom suffixé) — c'est ce qui rend une nouvelle tentative sans effet.
  - Profils : gagnant seul, jamais de copie.
- Présent d'un seul côté : supprimé si une pierre tombale de l'autre côté a `at > updated` ; sinon conservé et la pierre tombale retirée.
- Pierres tombales du résultat : union (par `kind+id`, la plus récente), sans celles dont l'élément a survécu, sans celles de plus de 180 jours avant `now`.
- Profils d'un élément : ids disparus retirés ; liste vide → premier profil restant.

- [ ] **Step 1: Écrire les tests** (helpers : `acc(id, name, updated, **kw)`, `card(...)`, `vault(...)` ; `LS = "2026-10-01T12:00:00"`, `NOW = "2026-10-19T12:00:00"`)

```python
def test_identical_vaults_no_change():           # to_pc == to_phone == conflicts == 0
def test_new_on_phone_goes_to_pc():              # to_pc == 1, to_phone == 0
def test_new_on_pc_goes_to_phone():
def test_newer_version_wins_when_one_side_changed():   # phone.updated < LS : pas de copie, version PC
def test_tombstone_newer_than_item_deletes():          # deleted == 1, élément absent
def test_item_modified_after_tombstone_survives():     # élément présent, pierre tombale retirée
def test_both_sides_spent_on_same_card():
    # base remaining 50 ; PC : dépense h1 de 10 → 40 ; téléphone : dépense h2 de 5 → 45 (plus récente)
    r = merge(pc, phone, LS, NOW)
    g = r.vault.giftcards[0]
    assert g.remaining == 35.0 and {h["id"] for h in g.history} == {"h1", "h2"}
def test_account_changed_both_sides_keeps_copy():
    # même compte, mot de passe changé des deux côtés, PC plus récent
    assert [a.name for a in r.vault.accounts] == ["Netflix", "Netflix (copie téléphone)"] and r.conflicts == 1
def test_favorite_only_difference_no_copy():
def test_retry_after_lost_response_is_idempotent():   # Review Focus 2
    first = merge(pc, phone, LS, NOW)
    again = merge(first.vault, phone, LS, NOW)          # le téléphone renvoie son ancien état
    assert again.conflicts == 0 and again.to_pc == 0
    assert again.vault.giftcards[0].remaining == first.vault.giftcards[0].remaining
def test_orphan_item_goes_to_first_profile():
def test_tombstones_older_than_180_days_purged():
def test_settings_and_sync_come_from_pc():
def test_inputs_not_mutated():                         # to_dict() des entrées identique avant/après
```

- [ ] **Step 2: Lancer** `.venv\Scripts\python -m pytest tests/test_merge.py -v` → échecs (module absent).
- [ ] **Step 3: Implémenter `merge`** dans `app/merge.py` selon les règles ci-dessus (comparaisons via `asdict`, dates comparées comme chaînes au format fixe).
- [ ] **Step 4: Lancer** → tout passe.
- [ ] **Step 5: Commit** `feat(sync): fusion des coffres sans perte (copies de conflit, dépenses fusionnées)`

---

### Task 3: Enveloppe chiffrée et session de synchro

**Files:**
- Create: `app/sync.py` (partie protocole), `tools/make_sync_vector.py`, `tests/fixtures/sync_vector.json`
- Test: `tests/test_sync.py`

**Interfaces:**
- Produces:
```python
AAD_REQ = b"pp-sync-v1:req"
AAD_RESP = b"pp-sync-v1:resp"
class SyncError(Exception): ...
def b64u(data: bytes) -> str; def unb64u(s: str) -> bytes          # base64url sans « = »
def seal(key: bytes, obj: dict, aad: bytes, nonce: bytes | None = None) -> bytes
    # corps = json.dumps({"n": b64u(nonce), "c": b64u(AESGCM(key).encrypt(nonce, json_compact(obj), aad))})
    # json_compact = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode()
def open_sealed(key: bytes, body: bytes, aad: bytes) -> tuple[dict, bytes]   # (objet, nonce) ; SyncError sinon
class SyncSession:
    def __init__(self, key: bytes, on_message: Callable[[dict], dict], expires_at: float, clock=time.monotonic)
    state: str          # "waiting" | "syncing" | "done" | "closed" | "expired"
    def handle(self, body: bytes) -> tuple[int, bytes]
        # 410 si fermée/expirée ; 403 si indéchiffrable ; 409 si nonce déjà vu ;
        # sinon 200 + seal(réponse, AAD_RESP). Ferme la session (state "done") après une réponse ok
        # à un message "sync", ou après "cancel" (state "closed"). state "syncing" dès le 1er message valide.
    def close(self) -> None
```
- Le vecteur `tests/fixtures/sync_vector.json` : `{"key", "nonce", "aad": "pp-sync-v1:req", "plaintext": {"type":"hello","nom":"Café €"}, "body"}` produit par `seal` avec nonce fixe ; il sert aussi aux tests JS (Tâche 8).

- [ ] **Step 1: Écrire les tests**

```python
def test_seal_open_roundtrip():
def test_wrong_key_or_tampered_body_raises():          # SyncError
def test_vector_file_matches_seal():                    # seal(key, plaintext, AAD_REQ, nonce) == body du fichier
def test_session_answers_and_closes_after_sync():       # hello → 200 ; sync ok → 200 puis tout appel → 410
def test_session_rejects_replayed_nonce():              # même corps deux fois → 409
def test_session_rejects_wrong_key():                   # 403
def test_session_expires():                             # horloge factice avancée de 121 s → 410, state "expired"
def test_response_cannot_be_replayed_as_request():      # corps de réponse renvoyé à handle → 403 (AAD différente)
```

- [ ] **Step 2: Lancer** `.venv\Scripts\python -m pytest tests/test_sync.py -v` → échecs.
- [ ] **Step 3: Implémenter** `app/sync.py` (protocole) puis `tools/make_sync_vector.py` ; lancer `.venv\Scripts\python tools/make_sync_vector.py` pour créer le fichier.
- [ ] **Step 4: Lancer** → tout passe.
- [ ] **Step 5: Commit** `feat(sync): enveloppe AES-GCM et session à usage unique`

---

### Task 4: Dialogue de synchro (hello / sync)

**Files:**
- Create: `app/syncflow.py`
- Modify: `app/store.py`
- Test: `tests/test_syncflow.py`

**Interfaces:**
- Consumes: `merge()` (Tâche 2), `Lockout`, `VaultStore`.
- Produces:
```python
# store.py
def verify_code(self, code: str) -> bool        # derive_key(code, self._salt, self._n) comparé par hmac.compare_digest
def code_version(self) -> str                   # sha256(b"pp-code-version" + sel).hexdigest()[:16] ; ne révèle pas le code

# syncflow.py
MAX_SKEW_SECONDS = 300
class SyncFlow:
    def __init__(self, store: VaultStore, lockout: Lockout, persist_lockout: Callable[[], None],
                 config: Callable[[], dict], pc_name: str, now: Callable[[], datetime] = datetime.now)
    def handle(self, msg: dict) -> dict          # aiguille sur msg["type"] : "hello" | "sync" | "cancel"
    device_name: str | None; summary: dict | None
def validate_phone_vault(d: dict) -> Vault       # ValueError si structure ou types invalides
```
- Messages (téléphone → PC) et réponses :
  - `hello` : `{"type","device_id","device_name","generation","last_sync","code_version","has_data","now"}` →
    `{"ok":True,"pc","lock_mode","pin_length","code_version","need_code","mode":"merge"|"replace","reason":None|"first"|"restored"|"stale","since"}`.
    `need_code` = `code_version` différent de celui du PC. `mode` = `"replace"` si `has_data` faux (`"first"`), si `generation != config["generation"]` (`"restored"`), si `last_sync` absent ou de plus de 180 jours (`"stale"`) ; sinon `"merge"`.
    **Révisé pendant l'exécution (Rulings 5–7 du suivi) :** `need_code` est vrai si l'appareil n'est pas dans le registre, si `code_version` diffère **ou** si `generation` diffère ; la réponse au `hello` ne contient `code_version` que si `need_code` est faux ; un seul `hello` par session ; le `last_sync` du `sync` doit être celui du `hello` ; `generation` est un jeton aléatoire (chaîne) renouvelé à chaque restauration. Une requête en cours pendant un verrouillage du PC reçoit `{"ok": false, "error": "closed"}` (à traiter comme « QR expiré »).
  - `sync` : `{"type","device_id","device_name","code","replace","vault":{profiles,accounts,giftcards,deleted},"last_sync","now"}` →
    `{"ok":True,"vault":<to_dict sans settings ni sync>,"summary":{"to_pc","to_phone","deleted","conflicts"},"code_version","generation","synced_at","lock_mode","pin_length"}`.
    `replace` vrai → coffre PC renvoyé tel quel, rien d'enregistré sauf le registre de l'appareil.
  - Erreurs : `{"ok":False,"error":<code>,"message":<texte français>}` avec codes `"clock"` (« L'heure du téléphone diffère de celle du PC de N min : active l'heure automatique. »), `"no_lock"`, `"locked"`, `"code_required"`, `"bad_code"` (+ `"wait_seconds"`), `"invalid"`.
  - Succès de `sync` : `store.save()` (sauvegarde automatique incluse), `vault.sync["devices"][device_id] = {"name", "last_sync": synced_at}`.

- [ ] **Step 1: Écrire les tests** (coffre chiffré réel dans `tmp_path`, scrypt rapide via conftest, `now` factice)

```python
def test_hello_first_sync_needs_code_and_replace():     # need_code True, mode "replace", reason "first"
def test_hello_known_device_merges():                  # code_version et generation identiques → mode "merge", need_code False
def test_hello_after_restore_is_replace_restored():
def test_hello_stale_after_180_days():
def test_hello_rejects_clock_skew():                   # Review Focus 1 : now du téléphone +6 min → error "clock"
def test_hello_requires_pc_lock():                     # coffre non chiffré → "no_lock"
def test_sync_requires_code_when_needed():             # code absent → "code_required"
def test_sync_bad_code_counts_in_lockout():            # "bad_code" ; 2e essai immédiat → wait_seconds > 0
def test_sync_merges_saves_backup_registers_device():  # nouvelle sauvegarde dans backups/, devices[device_id]
def test_sync_replace_returns_pc_vault():
def test_sync_response_has_no_settings_or_sync():
def test_sync_invalid_payload_leaves_pc_untouched():   # Review Focus 3
    before = store.path.read_bytes()
    for bad in ({"accounts": [{"id": 3}]}, {"accounts": "x"}, {"giftcards": [{"id": "g", "name": "x", "remaining": -1}]}):
        assert flow.handle(sync_msg(vault=bad))["error"] == "invalid"
    assert store.path.read_bytes() == before
def test_sync_when_pc_locked():                        # store.forget_key() puis sync → "locked"
```

- [ ] **Step 2: Lancer** `.venv\Scripts\python -m pytest tests/test_syncflow.py -v` → échecs.
- [ ] **Step 3: Implémenter** `verify_code`, `code_version` puis `SyncFlow`. Le code est vérifié via `lockout` (attente en cours → `bad_code` avec `wait_seconds`, échec → `fail()` + `persist_lockout()`). `validate_phone_vault` : listes, `id`/`name` chaînes non vides, `profiles` liste de chaînes, montants numériques ≥ 0, entrées d'historique `{id, date, amount>0}`, `image` `None` ou chaîne `data:image/…`.
- [ ] **Step 4: Lancer** → tout passe.
- [ ] **Step 5: Commit** `feat(sync): dialogue hello/sync, vérification du code, remplacement après restauration`

---

### Task 5: Serveur, QR code et méthodes `Api`

**Files:**
- Modify: `app/sync.py`, `app/api.py`, `requirements.txt` (`segno>=1.6`)
- Test: `tests/test_sync.py` (serveur), `tests/test_api_sync.py`

**Interfaces:**
- Consumes: `SyncSession` (Tâche 3), `SyncFlow` (Tâche 4).
- Produces:
```python
SYNC_SECONDS = 120
MAX_BODY = 64 * 1024 * 1024
class SyncServer:                       # ThreadingHTTPServer sur 0.0.0.0, POST /pp-sync uniquement
    def __init__(self, session: SyncSession, port: int = 0); port: int
    def start(self) -> None; def stop(self) -> None
    # 404 autre chemin, 405 autre méthode, 413 si Content-Length > MAX_BODY (corps non lu)
def private_ipv4s() -> list[str]        # getaddrinfo(gethostname()) filtré : is_private, ni loopback ni 169.254
def qr_svg(payload: dict) -> str        # segno, erreur "m", sombre sur blanc, marge incluse

# Api (paramètre de constructeur injectable : sync_server=SyncServer)
def sync_start(self) -> dict            # {"qr": svg, "seconds": 120, "hosts": [...]}
    # ValueError « Définis d'abord un code de verrouillage (Réglages) pour synchroniser un téléphone. »
    # ValueError « Aucun réseau local détecté : connecte le PC au Wi-Fi ou au câble de la box. »
def sync_status(self) -> dict           # {"state", "seconds_left", "device", "summary", "error"}
def sync_stop(self) -> dict
def list_devices(self) -> list[dict]    # [{"id","name","last_sync"}], plus récent d'abord
def forget_device(self, device_id: str) -> dict
```
- `lock()` et un nouveau `sync_start()` arrêtent la session en cours ; l'arrêt automatique à 120 s passe par `self._schedule`. `on_message` de la session appelle `SyncFlow.handle` sous `self._mutex`. Nom du PC : `os.environ.get("COMPUTERNAME") or socket.gethostname()`.

- [ ] **Step 1: Écrire les tests**

```python
# tests/test_sync.py
def test_server_roundtrip_on_loopback():        # urllib POST 127.0.0.1:port/pp-sync d'un hello scellé → 200 lisible
def test_server_rejects_other_paths_and_huge_body():   # GET → 405, /x → 404, Content-Length 70 Mo → 413
def test_qr_svg_contains_svg():
# tests/test_api_sync.py (serveur factice injecté)
def test_sync_start_requires_lock():
def test_sync_start_returns_qr_and_status_waiting():
def test_lock_closes_sync_session():            # Review Focus 4 : lock() → session « closed », message suivant → 410
def test_list_and_forget_device():
```

- [ ] **Step 2: Lancer** `.venv\Scripts\python -m pytest tests/test_sync.py tests/test_api_sync.py -v` → échecs.
- [ ] **Step 3: Implémenter**, puis `.venv\Scripts\pip install segno`.
- [ ] **Step 4: Lancer toute la suite** `.venv\Scripts\python -m pytest -q` → tout passe.
- [ ] **Step 5: Commit** `feat(sync): serveur local 2 min, QR code, méthodes Api`

---

### Task 6: Interface PC (bouton ⇅, fenêtre QR, carte « Téléphones »)

**Files:**
- Create: `ui/views/sync.js`
- Modify: `ui/views/main.js` (bouton barre du haut), `ui/views/settings.js` (carte « Téléphones »), `ui/mock-api.js`, `ui/index.html`, `ui/style.css`, `ui/app.js` (ajouter `"touchstart"` aux événements d'activité — sert au téléphone)

**Interfaces:**
- Consumes: `sync_start`, `sync_status`, `sync_stop`, `list_devices`, `forget_device` (Tâche 5).
- Produces: `PP.views.sync.open()`.

Fenêtre (via `PP.modal`) : titre « Synchroniser le téléphone », QR sur fond blanc arrondi, consigne « Sur le téléphone : Synchro → Scanner », compte à rebours `m:ss`, état interrogé toutes les 500 ms : « En attente du téléphone… », « Synchronisation avec <appareil>… », « ✓ Téléphone de <appareil> synchronisé — N reçus, M envoyés[, K supprimés][, 1 conflit : copie gardée] », « QR expiré » + bouton « Relancer ». Fermer la fenêtre appelle `sync_stop`. Note sous le QR : « Si Windows le demande, autorise Passe-Partout sur les réseaux privés. » Après succès, `PP.route()` recharge la liste. Carte Réglages « Téléphones » : nom, « dernière synchro le JJ/MM/AAAA à HH:MM », bouton « Oublier » (via `PP.confirm`), texte « Aucun téléphone synchronisé » sinon. La maquette (`mock-api.js`) renvoie un faux QR et fait défiler waiting → syncing → done en 4 s.

- [ ] **Step 1: Implémenter** les vues et la maquette.
- [ ] **Step 2: Vérifier dans le navigateur** : ouvrir `ui/index.html` (maquette) avec Claude in Chrome, cliquer ⇅, voir les trois états et le décompte ; ouvrir Réglages → carte Téléphones ; capture d'écran.
- [ ] **Step 3: Vérifier en vrai** : `.venv\Scripts\python lancer.pyw`, coffre avec PIN, cliquer ⇅ → QR affiché ; sans verrou → message de la Tâche 5.
- [ ] **Step 4: Lancer** `.venv\Scripts\python -m pytest -q` → tout passe.
- [ ] **Step 5: Commit** `feat(ui): fenêtre de synchronisation par QR et liste des téléphones`

---

### Task 7: Outils Android, squelette Capacitor, APK signé

**Files:**
- Create: `mobile/package.json`, `mobile/capacitor.config.json`, `mobile/scripts/assemble.mjs`, `mobile/www/index.html`, `mobile/www/mobile.css`, `mobile/build.ps1`, `mobile/.gitignore`, `mobile/android/…` (généré), `mobile/android/app/src/main/res/xml/network_security_config.xml`
- Modify: `tools/make_icon.py` (option `--android`)

**Interfaces:**
- Produces: `npm run assemble` (copie `ui/app.js`, `ui/logos.js`, `ui/style.css`, `ui/assets/icon.svg` vers `mobile/www/shared/`, ignoré par git), `npm test` (= `node --test test/`), `mobile/build.ps1` → `mobile/dist/passe-partout.apk`.

- [ ] **Step 1: Installer les outils** (accord de Jules requis pour winget) : `winget install -e --id Microsoft.OpenJDK.21` et `winget install -e --id Google.AndroidStudio` ; Jules ouvre Android Studio une fois (assistant : SDK Platform récente, Build-Tools, Platform-Tools). Définir `JAVA_HOME` et `ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk` (variables utilisateur).
- [ ] **Step 2: Vérifier** : `java -version` → 21 ; `& "$env:ANDROID_HOME\platform-tools\adb.exe" version` → affiche une version.
- [ ] **Step 3: Créer le projet** : `npm init`, installer `@capacitor/core @capacitor/cli @capacitor/android @capacitor/app @capacitor/preferences @capacitor/filesystem @capacitor/device @capacitor/barcode-scanner` (versions exactes figées par `package-lock.json`) ; `capacitor.config.json` = `{"appId":"fr.passepartout.app","appName":"Passe-Partout","webDir":"www"}` ; `npx cap add android` ; `minSdkVersion = 28` dans `android/variables.gradle` ; `network_security_config.xml` autorisant le trafic en clair (corps déjà chiffrés AES-GCM ; commentaire l'expliquant) et référencé dans le manifeste ; permissions `CAMERA`, `USE_BIOMETRIC`.
- [ ] **Step 4: Page de démarrage** : `www/index.html` charge `shared/style.css`, `mobile.css`, `shared/logos.js`, `shared/app.js` et affiche `PP.brand()` sur le fond néon (pas d'appel à `PP.start`).
- [ ] **Step 5: Icône** : `tools/make_icon.py --android` écrit `mobile/resources/icon-foreground.png` (1024 px, clé dans la zone sûre de 66 %) et `icon-background.png` (`#0b0716`) ; `npx @capacitor/assets generate --android`.
- [ ] **Step 6: `mobile/build.ps1`** : `npm run assemble` ; `npx cap sync android` ; au premier lancement, crée `%APPDATA%\GestionnaireMdp\android-signing\passe-partout.jks` (keytool, mot de passe aléatoire écrit dans `signing.properties` du même dossier) ; `android\gradlew.bat assembleRelease` avec la configuration de signature lue depuis ce fichier ; copie l'APK vers `mobile/dist/passe-partout.apk`.
- [ ] **Step 7: Vérifier** : `powershell -File mobile\build.ps1` → l'APK existe ; installé sur le téléphone de Jules (câble + `adb install -r`, ou copie du fichier), l'appli s'ouvre avec l'icône clé et le logo néon. `git status` ne montre ni `.jks` ni `signing.properties`.
- [ ] **Step 8: Commit** `feat(mobile): squelette Capacitor Android, icône, construction de l'APK signé`

---

### Task 8: Crypto et anti-essais côté téléphone

**Files:**
- Create: `mobile/www/js/crypto.js`, `mobile/www/js/lockout.js`
- Test: `mobile/test/crypto.test.js`, `mobile/test/lockout.test.js`

**Interfaces:**
- Consumes: `tests/fixtures/sync_vector.json` (Tâche 3).
- Produces:
```js
PPM.crypto = {
  b64u(bytes) -> string, unb64u(string) -> Uint8Array, randomBytes(n) -> Uint8Array,
  AAD_REQ: "pp-sync-v1:req", AAD_RESP: "pp-sync-v1:resp",
  seal(key, obj, aad, nonce?) -> Promise<string>      // même format octet pour octet que app/sync.py (JSON.stringify compact)
  open(key, body, aad) -> Promise<object>              // Error("bad_crypto")
  PBKDF2_ITERATIONS: 600000,
  wrapWithCode(dataKey, code, iterations?) -> Promise<{salt, iter, iv, ct}>
  unwrapWithCode(wrapped, code) -> Promise<Uint8Array>  // Error("bad_code")
  encryptVault(dataKey, obj) -> Promise<{v:1, iv, ct}>  // AAD "pp-vault-v1"
  decryptVault(dataKey, blob) -> Promise<object>        // Error("corrupt")
}
class PPM.Lockout { constructor(clock = Date.now, state = {}) ; waitSeconds() ; fail() ; success() ; toJSON() -> {fails, until} }
```

- [ ] **Step 1: Écrire les tests** (`node:test`, `node:assert`)

```js
test("ouvre le vecteur Python", async () => { assert.deepEqual(await open(key, v.body, v.aad), v.plaintext); });
test("seal avec le nonce du vecteur = corps Python", async () => { assert.equal(await seal(key, v.plaintext, v.aad, nonce), v.body); });
test("mauvaise clé → bad_crypto");
test("wrap/unwrap avec le code (1000 itérations en test)");
test("mauvais code → bad_code");
test("coffre altéré → corrupt");
test("itérations par défaut ≥ 600000", () => assert.ok(PBKDF2_ITERATIONS >= 600000));
test("lockout : 1, 2, 4 s… plafonné à 300 s, état restauré par le constructeur");
```

- [ ] **Step 2: Lancer** `cd mobile; npm test` → échecs.
- [ ] **Step 3: Implémenter** avec `globalThis.crypto.subtle` (présent dans Node 22 et la WebView).
- [ ] **Step 4: Lancer** `npm test` → tout passe.
- [ ] **Step 5: Commit** `feat(mobile): chiffrement WebCrypto compatible PC et délai anti-essais`

---

### Task 9: Logique du coffre côté téléphone

**Files:**
- Create: `mobile/www/js/vaultlogic.js`
- Test: `mobile/test/vaultlogic.test.js`

**Interfaces:**
- Produces (`v` = coffre au format `to_dict` du PC, sans `settings`/`sync`) :
```js
PPM.vault = {
  normalize(s),                         // mêmes règles que app/textutil.normalize (accents, œ/æ/ß, espaces)
  nowIso(d = new Date()), todayIso(d = new Date()), newId(),
  empty() -> {version:1, profiles:[], accounts:[], giftcards:[], deleted:[]},
  listAccounts(v, profileId|null)       // favoris d'abord puis nom normalisé
  listGiftcards(v, profileId|null),
  categoryLabel(v, category),
  saveAccount(v, data, now) -> account, saveGiftcard(v, data, now) -> card,
  stamp(now, lastSync, previous) -> string,   // max(now, lastSync + 1 s, previous + 1 s) — voir ci-dessous
  deleteItem(v, kind, id, now),         // retire + pierre tombale {kind, id, at: now}
  spend(v, id, amount, today, now) -> card,   // historique {id: newId(), date: today, amount}
  isFinished(card, today), expiringSoon(cards, today, days = 30),
}
```
Messages d'erreur identiques à `app/api.py` / `app/giftcards.py` (« Le nom est obligatoire », « Choisis au moins un profil », « Les montants ne peuvent pas être négatifs », « Le montant doit être positif », « Montant supérieur au solde restant »).
**Contrat d'horodatage (Ruling 8 du suivi, obligatoire) :** le PC juge « modifié depuis la dernière synchro » avec son horloge, alors que le téléphone date avec la sienne (jusqu'à 5 min d'écart). Toute modification faite sur le téléphone (`updated` d'un élément, `at` d'une pierre tombale) est donc datée `stamp(nowIso(), meta.last_sync, ancien updated)`, sinon une modification ou une dépense peut être perdue sans avertissement. `LocalApi` (Tâche 11) passe `last_sync` à chaque appel.

- [ ] **Step 1: Écrire les tests**

```js
test("normalize comme le PC", () => { assert.equal(normalize("  Réseau   SOCIAL "), "reseau social"); assert.equal(normalize("Œuvre"), "oeuvre"); });
test("saveAccount exige un nom et un profil connu");
test("saveAccount : updated = now, created conservé en modification");
test("categoryLabel : « banque » devient « Banque » si elle existe");
test("deleteItem ajoute une pierre tombale");
test("spend : id d'historique, solde arrondi, updated = now ; montant > solde refusé");
test("stamp : horloge du téléphone en retard sur le PC → date = last_sync + 1 s ; jamais ≤ l'updated précédent");
test("listAccounts : favoris d'abord, ordre alphabétique sans accents");
test("expiringSoon : 30 jours, ignore cartes finies");
```

- [ ] **Step 2: Lancer** `npm test` → échecs.
- [ ] **Step 3: Implémenter.**
- [ ] **Step 4: Lancer** `npm test` → tout passe.
- [ ] **Step 5: Commit** `feat(mobile): logique du coffre (validation, suppressions tracées, dépenses)`

---

### Task 10: Plugin natif (Keystore, empreinte, presse-papiers, FLAG_SECURE)

**Files:**
- Create: `mobile/android/app/src/main/java/fr/passepartout/app/PassePartoutPlugin.java`, `mobile/www/js/native.js`, `mobile/www/js/native-fake.js`
- Modify: `mobile/android/app/src/main/java/fr/passepartout/app/MainActivity.java`, `mobile/android/app/build.gradle` (`androidx.biometric:biometric`)

**Interfaces:**
- Produces:
```js
PPM.native / PPM.nativeFake = {
  wrap(alias, bytes, {biometric = false} = {}) -> Promise<string>
  unwrap(alias, blob, {title} = {}) -> Promise<Uint8Array>   // Error.code : "KEY_INVALIDATED" | "CANCELED" | "FAILED"
  deleteKey(alias), biometricAvailable() -> Promise<boolean>,
  copySensitive(text, seconds = 30), copyPlain(text),
  readFile(name) -> Promise<string|null>, writeFileAtomic(name, text), removeFile(name),   // Directory.Data
  getPref(key) -> Promise<any|null>, setPref(key, value),
  deviceName() -> Promise<string>,
  onPause(cb), onResume(cb),
  scanQr() -> Promise<string|null>,                       // @capacitor/barcode-scanner, indice QR_CODE
  post(url, body, timeoutMs) -> Promise<{status, text}>,  // CapacitorHttp (contourne le contenu mixte)
}
```
Java (`@CapacitorPlugin(name = "PassePartout")`) : clés AES/GCM `AndroidKeyStore` créées à la demande par alias ; alias biométrique : `setUserAuthenticationRequired(true)`, `setInvalidatedByBiometricEnrollment(true)`, `BIOMETRIC_STRONG`, chiffrement/déchiffrement via `BiometricPrompt.CryptoObject` (titre « Déverrouiller Passe-Partout ») ; blob = base64(iv ‖ texte chiffré). `copySensitive` : `ClipData` avec `ClipDescription.EXTRA_IS_SENSITIVE` (API 33+), puis `clearPrimaryClip()` après `seconds` s, sauf si une copie plus récente de l'appli a eu lieu. `MainActivity` : `registerPlugin(PassePartoutPlugin.class)` avant `super.onCreate`, puis `FLAG_SECURE`. `native-fake.js` : tout en mémoire (ou `localStorage` dans le navigateur), `wrap` réversible marqué par l'alias, `scanQr` demande le texte dans une fenêtre `PP.modal`.

- [ ] **Step 1: Implémenter** le plugin, `native.js`, `native-fake.js`.
- [ ] **Step 2: Vérifier sur le téléphone** (APK de debug via `npx cap run android` ou `build.ps1`, console via `chrome://inspect`) : `wrap`/`unwrap` aller-retour ; alias biométrique → la fenêtre d'empreinte apparaît, Annuler → `CANCELED` ; capture d'écran bloquée et aperçu noir dans les apps récentes ; texte copié par `copySensitive(…, 30)` absent du presse-papiers après 30 s.
- [ ] **Step 3: Commit** `feat(mobile): plugin natif Keystore/empreinte, presse-papiers sensible, captures bloquées`

---

### Task 11: LocalApi, verrouillage, premier lancement, coquille de navigation

**Files:**
- Create: `mobile/www/js/local-api.js`, `mobile/www/js/boot.js`, `mobile/www/views/lock.js`, `mobile/www/views/welcome.js`, `mobile/www/views/shell.js`
- Modify: `mobile/www/index.html`, `mobile/www/mobile.css`
- Test: `mobile/test/local-api.test.js`

**Interfaces:**
- Consumes: `PPM.crypto`, `PPM.Lockout`, `PPM.vault`, `PPM.native`/`PPM.nativeFake`.
- Produces:
```js
class PPM.LocalApi {
  constructor({native, clock = Date.now})
  // mêmes noms et formes que l'Api Python :
  get_state() -> {locked, lock_mode, pin_length, has_data, corrupt:false, profiles, biometric}
  unlock(code) -> {ok, wait_seconds, error?}   unlock_biometric() -> {ok, error?: "bio_invalidated"|"canceled"}
  lock()  get_settings() -> {autolock_minutes, biometric}  save_settings(changes)
  list_accounts(pid) save_account(d) delete_account(id) list_giftcards(pid) save_giftcard(d) delete_giftcard(id) spend(id, amount)
  copy_secret(text) copy_plain(text) normalize_image(dataUrl)   // ≤ 256 px PNG via canvas
  // synchro (Tâche 12) :
  sync_info() -> {device_id, device_name, generation, last_sync, code_version, has_data, now}
  sync_payload() -> {profiles, accounts, giftcards, deleted}
  apply_sync(resp, code|null)
}
```
Stockage : `vault.enc` = `encryptVault(dataKey, coffre)` ; `keys.json` = `{"code": wrap("pp-device", JSON(wrapWithCode(dataKey, code))), "bio": wrap("pp-bio", dataKey, {biometric:true}) | absent}` ; préférences `pp.meta` = `{device_id, last_sync, generation, code_version, pc_name, lock_mode, pin_length}` (device_id aléatoire créé au premier lancement), `pp.settings` = `{autolock_minutes: 5, biometric: false}`, `pp.lockout`. `apply_sync` écrit dans l'ordre `vault.enc` → `keys.json` (si code fourni : nouvelle clé de données au premier lancement, sinon réenveloppe la clé existante avec le nouveau code et refait `bio` si actif) → `pp.meta`. Toute modification réécrit `vault.enc`.
Vues : `lock` = pavé PIN (validation automatique à `pin_length` chiffres) ou champ mot de passe selon `lock_mode`, bouton empreinte affiché et lancé automatiquement si actif, « Réessaie dans N s » ; `welcome` (pas de données) = logo + « Synchroniser avec le PC » → `PP.views.sync.show()` ; `shell` = barre d'onglets du bas Comptes · Cartes · Synchro · Réglages (vues des Tâches 12–15 ; « Bientôt » tant qu'absentes). `boot.js` : natif réel si `window.Capacitor?.isNativePlatform()`, sinon `nativeFake` + badge « APERÇU — données de démonstration » + bouton qui charge un coffre de démo (code `1234`) ; `PP.api = new LocalApi(...)` ; remplace `PP.route` (verrou → `lock`, sans données → `welcome`, sinon `shell`) ; `onPause`/`onResume` : verrouille si > 30 s en arrière-plan ; l'inactivité reste gérée par `ui/app.js` (`PP.state.settings.autolock_minutes`).

- [ ] **Step 1: Écrire les tests** (avec `nativeFake`, itérations PBKDF2 réduites via option de test)

```js
test("après apply_sync(premier, '1234') : unlock('1234') ok, unlock('0000') refusé");
test("délai anti-essais : 1 s puis 2 s, conservé par une nouvelle instance sur les mêmes préférences");
test("vault.enc ne contient pas le mot de passe en clair");
test("lock() : list_accounts lève « Coffre verrouillé »");
test("empreinte : activée puis unlock_biometric ok ; KEY_INVALIDATED → biometric désactivé, error 'bio_invalidated'");
test("code changé sur le PC : apply_sync(resp, '5678') → nouveau code ok, ancien refusé, données intactes");
test("delete_account puis sync_payload contient la pierre tombale");
```

- [ ] **Step 2: Lancer** `npm test` → échecs.
- [ ] **Step 3: Implémenter** `local-api.js`, puis `boot.js` et les vues.
- [ ] **Step 4: Lancer** `npm test` → tout passe.
- [ ] **Step 5: Vérifier dans le navigateur** (largeur 390 px) : `npm run assemble`, ouvrir `mobile/www/index.html`, charger la démo, se verrouiller, saisir un faux code (délai), puis `1234`. Captures d'écran.
- [ ] **Step 6: Commit** `feat(mobile): coffre local chiffré, écran de verrouillage PIN/empreinte, navigation`

---

### Task 12: Client et écran de synchronisation

**Files:**
- Create: `mobile/www/js/syncclient.js`, `mobile/www/views/sync.js`
- Test: `mobile/test/syncclient.test.js`

**Interfaces:**
- Consumes: `PPM.crypto`, `LocalApi.sync_info/sync_payload/apply_sync`, `native.scanQr/post`, protocole de la Tâche 4.
- Produces:
```js
PPM.parseQr(text) -> {hosts, port, key: Uint8Array, pc}   // Error « Ce QR code ne vient pas de Passe-Partout. »
class PPM.SyncClient {
  constructor({qr, post, crypto, timeoutMs = 3000})
  hello(info) -> Promise<object>        // essaie chaque hôte dans l'ordre, retient le premier qui répond
  sync(payload) -> Promise<object>
  cancel() -> Promise<void>
}
// erreurs (Error.code / message affiché) :
//  "unreachable" « PC injoignable : vérifie que le téléphone est sur le même Wi-Fi et que le pare-feu Windows autorise Passe-Partout. »
//  "expired"     « QR code expiré : relance la synchronisation sur le PC. »   (410)
//  "forbidden"   « QR code refusé par le PC. »                                 (403/409)
```
Écran (maquette `.superpowers/brainstorm/1073-1792363529/content/mobile-ecrans.html`) : bouton « Scanner le QR code du PC » → `hello` → erreur PC affichée telle quelle (`message`) ; si `need_code` : pavé de saisie selon `lock_mode` (texte « Saisis le code du PC » ou, si déjà des données, « Le code du PC a changé : saisis le nouveau code ») ; si `mode == "replace"` et `reason == "restored"` : `PP.confirm` « Le PC a restauré une sauvegarde : tes modifications faites sur le téléphone depuis le <date> seront remplacées. » ; `reason == "stale"` : « Ce téléphone n'a pas été synchronisé depuis plus de 180 jours : ses données seront remplacées par celles du PC. » ; Annuler → `cancel()`. `bad_code` → message + nouvel essai (délai respecté). Succès → `apply_sync`, écran « ✓ Synchronisé avec <pc> », « ↓ <to_phone> reçus · ↑ <to_pc> envoyés », lignes « N supprimés » et « 1 conflit : copie gardée » si non nuls. Au premier lancement, l'écran est accessible sans déverrouillage ; sinon seulement déverrouillé.

- [ ] **Step 1: Écrire les tests** (`post` factice qui répond avec `PPM.crypto.seal(..., AAD_RESP)`)

```js
test("parseQr valide et refus d'un QR étranger");
test("hello passe au 2e hôte si le 1er ne répond pas");
test("all hosts unreachable", async () => { await assert.rejects(c.hello(info), { code: "unreachable" }); });  // Review Focus 5
test("410 → expired ; 403 → forbidden");
test("réponse chiffrée avec une autre clé → forbidden");
```

- [ ] **Step 2: Lancer** `npm test` → échecs.
- [ ] **Step 3: Implémenter.**
- [ ] **Step 4: Lancer** `npm test` → tout passe.
- [ ] **Step 5: Vérifier de bout en bout sur le téléphone** avec le vrai PC (APK via `build.ps1`) : premier lancement → scan → code du PC → données reçues ; code faux refusé ; PC verrouillé pendant l'affichage du QR → « QR expiré ». Le PC affiche « ✓ Téléphone de … synchronisé ».
- [ ] **Step 6: Commit** `feat(mobile): synchronisation par QR code (premier lancement, code, remplacement, résumé)`

---

### Task 13: Comptes (liste, fiche, formulaire)

**Files:**
- Create: `mobile/www/views/accounts.js`, `mobile/www/views/account-form.js`
- Modify: `mobile/www/mobile.css`

**Interfaces:**
- Consumes: `PP.call("list_accounts"|"save_account"|"delete_account"|"copy_secret"|"copy_plain")`, `PP.search`, `PP.logos`, `PP.logo`, `PP.avatar`, `PP.strength`, `PP.applyMask`, `PP.modal`, `PP.confirm`, `PP.copySecret/copyPlain` (de `ui/app.js` ; voir `ui/views/form.js` et `ui/views/main.js` pour leur usage).
- Produces: `PP.views.main` = `{show(), clear(), active(), focusSearch(), newItem()}` (noms attendus par `ui/app.js`).

Liste : recherche en haut, puces de profils « Tout le monde » / chaque profil / « ⭐ », index A–Z vertical à droite (toucher une lettre fait défiler), bouton rond « + ». Fiche (plein écran) : logo, nom, catégorie, identifiant (copier), mot de passe masqué (afficher / copier), favori, Modifier. Formulaire : nom avec suggestions de noms et logos de la bibliothèque, catégorie, identifiant, mot de passe avec jauge de force, profils (cases), Supprimer (confirmation). Cibles tactiles ≥ 44 px.

- [ ] **Step 1: Implémenter.**
- [ ] **Step 2: Vérifier dans le navigateur à 390 px** (démo) : rechercher « reseau » trouve « Réseau social », filtrer ⭐, toucher « N » dans l'index, ajouter / modifier / supprimer un compte, copier un mot de passe (toast 30 s). Captures d'écran.
- [ ] **Step 3: Vérifier sur le téléphone** : suppression faite sur le téléphone puis synchro → absente du PC ; ajout PC → visible sur le téléphone.
- [ ] **Step 4: Commit** `feat(mobile): liste des comptes, fiche et formulaire`

---

### Task 14: Cartes cadeaux

**Files:**
- Create: `mobile/www/views/cards.js`
- Modify: `mobile/www/mobile.css`

**Interfaces:**
- Consumes: `PP.call("list_giftcards"|"save_giftcard"|"delete_giftcard"|"spend")`, `PPM.vault.expiringSoon/isFinished`, `PP.money`, `PP.dateFr`, `PP.daysUntil` ; référence visuelle `ui/views/giftcards.js`.
- Produces: `PP.views.cards.show()`.

Bandeau d'alerte si des cartes expirent dans 30 jours ; liste (logo, nom, solde, fin), cartes terminées en bas et estompées ; fiche : code et PIN (copier, afficher), solde, « J'ai dépensé… » (montant, refus au-delà du solde), historique, Modifier / Supprimer ; formulaire nom, code, PIN, montant initial, solde, date de fin, profils.

- [ ] **Step 1: Implémenter.**
- [ ] **Step 2: Vérifier dans le navigateur à 390 px** : dépense de 10 € → solde et historique à jour ; dépense supérieure au solde refusée ; alerte d'expiration visible.
- [ ] **Step 3: Vérifier sur le téléphone** : dépense sur le téléphone **et** sur le PC sur la même carte, puis synchro → les deux dépenses comptées des deux côtés.
- [ ] **Step 4: Commit** `feat(mobile): cartes cadeaux (solde, dépenses, expiration)`

---

### Task 15: Réglages du téléphone et livraison

**Files:**
- Create: `mobile/www/views/settings.js`
- Modify: `mobile/www/mobile.css`, `docs/2026-10-19-mobile-conception.md` (section « Installation » : étapes réelles)

**Interfaces:**
- Consumes: `get_settings/save_settings`, `native.biometricAvailable`, `pp.meta`.
- Produces: `PP.views.settings.show()`.

Réglages : « Empreinte digitale » (interrupteur ; masqué si indisponible ; l'activer redemande le code puis lance la fenêtre d'empreinte), « Verrouillage automatique » (1, 2, 5, 10, 15 min), « Synchronisé avec <pc> le JJ/MM/AAAA à HH:MM » (ou « Jamais synchronisé »), nom de l'appareil, bouton « Verrouiller maintenant », version de l'appli.

- [ ] **Step 1: Implémenter.**
- [ ] **Step 2: Lancer** `cd mobile; npm test` et `.venv\Scripts\python -m pytest -q` → tout passe.
- [ ] **Step 3: Construire** `powershell -File mobile\build.ps1` → `mobile/dist/passe-partout.apk`.
- [ ] **Step 4: Recette sur le téléphone de Jules** (la noter dans le compte rendu) : installation de l'APK ; premier lancement et synchro ; ouverture par code puis par empreinte ; ajout d'une empreinte dans Android → empreinte désactivée dans l'appli, code toujours accepté ; arrière-plan > 30 s → verrouillé ; capture d'écran bloquée ; mot de passe copié effacé après 30 s ; mode avion → consultation OK ; modification des deux côtés → copie de conflit signalée ; « Oublier » sur le PC puis resynchro avec le code.
- [ ] **Step 5: Commit** `feat(mobile): réglages (empreinte, verrouillage auto) et livraison de l'APK`
