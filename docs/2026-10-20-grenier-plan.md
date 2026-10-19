# Passe-Partout dans Le Grenier — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publier Passe-Partout 1.0.0 dans Le Grenier : un exe unique qui embarque l'APK, installation de l'appli depuis le PC par QR code, mise à jour du téléphone imposée par la synchro, publication par un script local.

**Architecture:** Une seule version (fichier `VERSION`) alimente le PC, l'APK et la release. Côté PC : `app/version.py`, `app/apk.py` (APK embarqué), `app/apkserve.py` (serveur d'installation), contrôle de version + message `apk` dans `app/syncflow.py`, verrou d'instance unique. Côté téléphone : `app_version` dans le hello, écran « Mettre à jour », téléchargement chiffré + installateur Android (plugin natif). `release.ps1` + `tools/release.py` construisent et publient ; Le Grenier reçoit l'entrée de catalogue et les visuels.

**Tech Stack:** Python 3.13, PyInstaller (onefile), segno ; Capacitor 8, JS vanilla, Java (FileProvider, PackageInstaller intent) ; API REST GitHub (urllib) ; Le Grenier (Electron, scripts Node).

**Spec:** `docs/2026-10-20-grenier-conception.md`

## Global Constraints

- Version unique, première publiée : **1.0.0** ; tag `v1.0.0` ; asset `Passe-Partout-1.0.0.exe` (sans espace) ; `assetPattern` `^Passe-Partout[ .-]\\d.*\\.exe$` ; `launchLabel` « Ouvrir ».
- `versionCode` Android = `major*10000 + minor*100 + patch` (1.0.0 → 10000), toujours croissant.
- Mise à jour du téléphone **en priorité** : téléphone plus ancien (ou sans version) → pas de synchro ; téléphone plus récent → « Mets à jour Passe-Partout sur le PC (Le Grenier). ».
- APK seulement sur le réseau local ; empreinte SHA-256 vérifiée par le téléphone ; la clé de signature reste dans `%APPDATA%\PassePartout\android-signing\` et la publication se fait sur le PC de Jules.
- Dépôt **public** : aucune donnée sensible suivie par git ; captures du Grenier avec **données de démonstration uniquement**.
- Jeton GitHub en écriture lu dans `GH_TOKEN`, jamais écrit sur disque ni affiché.
- Interface en français ; fins de ligne : garder celles de chaque fichier existant, LF dans `mobile/` (`.gitattributes`).
- Textes de la jaquette du Grenier validés par Jules **avant** de générer l'image (`--dry-run`).

## Review Focus

1. **Téléphone 0.1.0 (sans `app_version`)** → le PC répond `update_required` avec un `message` lisible par l'ancienne appli (« Mets à jour l'appli : sur le PC, Réglages → Installer l'appli sur le téléphone. »). → `test_hello_without_app_version_requires_update` (Tâche 4).
2. **APK abîmé pendant le transfert** → empreinte refusée, rien n'est installé, message clair. → test « APK à l'empreinte fausse refusé » (Tâche 5).
3. **Exe de développement sans APK embarqué** → le PC démarre, le bouton d'installation explique qu'aucune appli n'est disponible, la synchro avec un téléphone d'une autre version répond `update_required` sans APK. → `test_find_apk_absent_returns_none` + `test_update_required_without_embedded_apk` (Tâches 2 et 4).
4. **Deux Passe-Partout ouverts en même temps** (copie de dev + copie du Grenier) → le second refuse de démarrer. → `test_second_instance_lock_refused` (Tâche 2).
5. **Publication avec un rapport oublié ou un fichier sensible suivi** → `release.py` s'arrête avant le tag. → `test_notes_marker_mismatch_refused`, `test_sensitive_tracked_file_refused` (Tâche 7).

---

## Structure des fichiers

```
VERSION                      1.0.0 (seule source de la version)
app/version.py      (new)    VERSION, parse_version(), compare_versions()
app/apk.py          (new)    find_apk(), apk_info()
app/instance.py     (new)    acquire_instance_lock()
app/apkserve.py     (new)    ApkServer (sert l'APK sous un jeton)
app/syncflow.py     (mod.)   contrôle de version au hello, message « apk »
app/api.py          (mod.)   apk_install_start/status/stop, get_app_info, avis de mise à jour dans sync_status
app/main.py         (mod.)   verrou d'instance au lancement
ui/views/settings.js, ui/views/sync.js, ui/views/apkinstall.js (new), ui/mock-api.js, ui/style.css, ui/index.html
build.ps1           (mod.)   plus de raccourci bureau ; spec onefile qui embarque l'APK
Passe-Partout.spec  (mod.)   onefile + datas apk
release.ps1         (new)    enchaîne vérifications, builds, publication
tools/release.py    (new)    vérifications et appels à l'API GitHub (testables)
RELEASE_NOTES.md    (new)    rapport de la 1.0.0
CLAUDE.md           (new)    consigne : RELEASE_NOTES.md à chaque version, validé par Jules
mobile/scripts/assemble.mjs (mod.) écrit www/js/version.js (PPM.VERSION) depuis VERSION
mobile/build.ps1, mobile/android/app/build.gradle (mod.) versionName/versionCode depuis VERSION
mobile/www/js/syncclient.js (mod.) compareVersions(), downloadApk()
mobile/www/js/local-api.js (mod.) app_version dans sync_info
mobile/www/js/native.js, native-fake.js, PassePartoutPlugin.java, AndroidManifest.xml, res/xml/file_paths.xml (mod./new) installApk()
mobile/www/views/sync.js, views/settings.js (mod.)
le-grenier/catalog.json, public/{covers,icons,pages}/passe-partout.*, assets-sources/ (mod./new)
```

---

### Task 1: Une seule version partout

**Files:**
- Create: `VERSION`, `app/version.py`, `tests/test_version.py`
- Modify: `mobile/scripts/assemble.mjs`, `mobile/.gitignore` (`www/js/version.js`), `mobile/www/index.html` (charger `js/version.js` avant les vues), `mobile/www/views/settings.js` (retirer `PPM.VERSION = "0.1.0"`), `mobile/build.ps1`, `mobile/android/app/build.gradle`, `mobile/www/js/syncclient.js`, `mobile/test/syncclient.test.js`

**Interfaces:**
- Produces: `app.version.VERSION: str` (lu dans `VERSION`, aussi dans l'exe gelé via PyInstaller datas) ; `parse_version(s: object) -> tuple[int, int, int] | None` (`"1.2.3"` uniquement, sinon None) ; `compare_versions(a: str, b: str) -> int` (-1/0/1 ; lève ValueError si l'une est invalide). JS : `PPM.VERSION` (fichier généré `www/js/version.js`), `PPM.compareVersions(a, b) -> -1|0|1` exporté par `syncclient.js`.

- [ ] **Step 1: Tests**

```python
def test_parse_version():
    assert parse_version("1.0.0") == (1, 0, 0)
    for bad in ("1.0", "v1.0.0", "1.0.0-beta", "", None, 1):
        assert parse_version(bad) is None
def test_compare_versions():
    assert compare_versions("1.0.0", "1.0.0") == 0
    assert compare_versions("0.1.0", "1.0.0") == -1
    assert compare_versions("1.10.0", "1.9.9") == 1
def test_version_file_matches_constant():  # VERSION lu depuis le fichier racine
    assert VERSION == Path("VERSION").read_text().strip() == "1.0.0"
```
JS : `compareVersions("1.10.0","1.9.9") === 1`, `("0.1.0","1.0.0") === -1`, version invalide → lève.

- [ ] **Step 2: Lancer** `.venv\Scripts\python -m pytest tests/test_version.py -v` et `cd mobile; npm test` → échecs.
- [ ] **Step 3: Implémenter.** `assemble.mjs` écrit `www/js/version.js` (`PPM.VERSION = "<VERSION>"`, même motif de module). `mobile/build.ps1` lit `VERSION`, calcule `versionCode`, passe `-PppVersionName=… -PppVersionCode=…` à Gradle ; `build.gradle` les utilise (défaut `1.0.0` / `10000` si absents).
- [ ] **Step 4: Vérifier** : tests verts ; `powershell -File mobile\build.ps1` puis `aapt2 dump badging mobile\dist\passe-partout.apk` montre `versionCode='10000' versionName='1.0.0'`.
- [ ] **Step 5: Commit** `feat: une seule version (fichier VERSION) pour le PC, l'APK et l'appli`

---

### Task 2: APK embarqué, exe unique, une seule instance

**Files:**
- Create: `app/apk.py`, `app/instance.py`, `tests/test_apk.py`, `tests/test_instance.py`
- Modify: `app/main.py`, `Passe-Partout.spec`, `build.ps1`

**Interfaces:**
- Consumes: `VERSION` (Tâche 1).
- Produces:
  - `find_apk() -> Path | None` : exe gelé → `<_MEIPASS>/apk/passe-partout.apk` ; sinon `mobile/dist/passe-partout.apk` du dépôt s'il existe ; sinon None.
  - `apk_info(path: Path | None) -> dict | None` : `{"version": VERSION, "size": int, "sha256": hex, "filename": f"passe-partout-{VERSION}.apk"}` (SHA calculé une fois, mis en cache par chemin+taille+mtime).
  - `acquire_instance_lock(data_dir: Path) -> object | None` : verrou exclusif sur `data_dir/.instance.lock` (msvcrt.locking) gardé ouvert pendant la vie du processus ; None si déjà pris.
  - `main.run()` : si le verrou échoue → boîte Windows (ctypes `MessageBoxW`) « Passe-Partout est déjà ouvert. » et sortie sans créer de fenêtre.
  - `Passe-Partout.spec` : onefile, nom `Passe-Partout-<VERSION>`, datas `ui`, `VERSION` et `mobile/dist/passe-partout.apk` → `apk/`. `build.ps1` : construit d'abord l'APK s'il manque ou est plus ancien que `VERSION`, ne crée plus de raccourci bureau, produit `dist\Passe-Partout-<VERSION>.exe`.

- [ ] **Step 1: Tests**

```python
def test_find_apk_absent_returns_none(tmp_path, monkeypatch):   # Review Focus 3 (pointer le dépôt vers tmp_path)
def test_apk_info_size_and_sha(tmp_path):                        # sha256 == hashlib.sha256(contenu).hexdigest()
def test_second_instance_lock_refused(tmp_path):                 # Review Focus 4
    first = acquire_instance_lock(tmp_path)
    assert first is not None and acquire_instance_lock(tmp_path) is None
def test_lock_released_after_close(tmp_path):                    # après fermeture du premier, on peut reprendre
```
- [ ] **Step 2: Lancer** → échecs. **Step 3: Implémenter.**
- [ ] **Step 4: Vérifier** : suite verte ; `powershell -File build.ps1` → `dist\Passe-Partout-1.0.0.exe` démarre ; un second lancement affiche « Passe-Partout est déjà ouvert. ».
- [ ] **Step 5: Commit** `feat: exe unique qui embarque l'APK, une seule instance à la fois`

---

### Task 3: Installer l'appli depuis le PC (serveur + Api)

**Files:**
- Create: `app/apkserve.py`, `tests/test_apkserve.py`
- Modify: `app/api.py`, `tests/test_api_sync.py` (ou nouveau `tests/test_api_apk.py`)

**Interfaces:**
- Consumes: `apk_info`, `find_apk` (Tâche 2), `private_ipv4s`, `qr_svg` (`app/sync.py`).
- Produces:
  - `APK_SECONDS = 300` ; `ApkServer(apk_path: Path, token: str, filename: str, port: int = 0)` : `start()`, `stop()`, `port`, `downloads: int` (téléchargements complets). Sert **uniquement** `GET /<token>/<filename>` (`Content-Type: application/vnd.android.package-archive`, `Content-Length`) ; 404 sinon ; journal muet ; arrêt sans blocage (même conception que `SyncServer`).
  - `Api.apk_install_start() -> dict` : `{"qr": svg, "url": str, "urls": [str], "seconds": 300, "version": "1.0.0"}` ; jeton `secrets.token_urlsafe(16)` ; ValueError « Aucune appli Android n'est incluse dans cette version de Passe-Partout. » si `find_apk()` est None, et le message réseau de `sync_start` si aucune IP. `apk_install_status() -> {"state": "waiting"|"done"|"expired"|"closed", "seconds_left", "downloads"}` ; `apk_install_stop() -> {}`. `lock()` n'arrête pas ce serveur (aucune donnée). Injectable : `apk_server=ApkServer`.
  - `Api.get_app_info() -> {"version": VERSION, "apk": bool}`.

- [ ] **Step 1: Tests** : `test_serves_apk_under_token` (contenu identique, bon Content-Type) ; `test_wrong_token_or_path_404` ; `test_counts_complete_downloads` ; `test_apk_install_start_without_apk_raises` ; `test_apk_install_status_expires` (horloge factice, 301 s).
- [ ] **Step 2–4: échecs → implémentation → verts.**
- [ ] **Step 5: Commit** `feat: installation de l'appli Android depuis le PC par QR code`

---

### Task 4: Contrôle de version et envoi de l'APK dans la synchro (PC)

**Files:**
- Modify: `app/syncflow.py`, `app/api.py` (`_on_sync_message`, `sync_status`), `tests/test_syncflow.py`, `tests/test_sync_e2e.py`

**Interfaces:**
- Consumes: `compare_versions`, `VERSION` (Tâche 1), `apk_info`/`find_apk` (Tâche 2).
- Produces (protocole, à respecter tel quel par la Tâche 5) :
  - `hello` porte `app_version` (chaîne `X.Y.Z` ou absent pour l'appli 0.1.0 ; autre type → `invalid`).
  - Après les contrôles d'horloge et de verrou, avant le code : téléphone plus ancien ou sans version → `{"ok": false, "error": "update_required", "message": "Une nouvelle version de l'appli est disponible (A → X.Y.Z) : mets-la à jour pour synchroniser.", "current": A|null, "available": "X.Y.Z", "size": int|null, "sha256": hex|null}` ; si `app_version` absent, `message` = « Mets à jour l'appli : sur le PC, Réglages → Installer l'appli sur le téléphone. » ; `size`/`sha256` null si aucun APK embarqué. Téléphone plus récent → `{"ok": false, "error": "pc_outdated", "message": "Mets à jour Passe-Partout sur le PC (Le Grenier)."}`.
  - `update_required` compte comme le hello de la session (un seul hello) ; seul un message `{"type": "apk"}` est ensuite accepté → `{"ok": true, "apk": b64u(bytes), "sha256": hex, "version": "X.Y.Z"}` ; tout `sync` après `update_required` → `invalid`. Le message `apk` ne ferme pas la session.
  - `SyncFlow` expose `notice: str | None` : « Le téléphone de <nom> doit être mis à jour (A → X.Y.Z) », puis « ✓ Appli envoyée au téléphone de <nom> » ; `Api.sync_status()` ajoute la clé `notice`.

- [ ] **Step 1: Tests**

```python
def test_hello_without_app_version_requires_update(env):     # Review Focus 1
    r = env.flow().handle(hello_msg(env))                      # pas d'app_version
    assert r["error"] == "update_required" and "Réglages → Installer l'appli" in r["message"]
def test_older_phone_gets_update_then_apk(env):                # 0.9.0 → update_required, puis apk : sha256 == empreinte du fichier
def test_sync_after_update_required_is_invalid(env):
def test_newer_phone_pc_outdated(env):                         # 2.0.0 → pc_outdated
def test_same_version_syncs_normally(env):                     # 1.0.0 → mode merge comme avant
def test_update_required_without_embedded_apk(env):            # Review Focus 3 : size/sha256 None, apk → invalid
def test_app_version_wrong_type_invalid(env):                   # 1, [], "1.0" → invalid
```
Mettre à jour `hello_msg` des tests existants pour envoyer `app_version=VERSION` ; e2e : un faux téléphone 0.9.0 reçoit et vérifie l'APK.
- [ ] **Step 2–4: échecs → implémentation → toute la suite verte.**
- [ ] **Step 5: Commit** `feat(sync): mise à jour de l'appli imposée avant la synchro, APK envoyé dans la session chiffrée`

---

### Task 5: Mise à jour côté téléphone

**Files:**
- Modify: `mobile/www/js/syncclient.js`, `local-api.js`, `native.js`, `native-fake.js`, `mobile/www/views/sync.js`, `mobile.css`, `PassePartoutPlugin.java`, `AndroidManifest.xml` ; Create: `mobile/android/app/src/main/res/xml/file_paths.xml` ; Test: `mobile/test/syncclient.test.js`, `local-api.test.js`, `e2e-pc.test.js`

**Interfaces:**
- Consumes: protocole de la Tâche 4, `PPM.VERSION`, `PPM.compareVersions` (Tâche 1).
- Produces:
  - `LocalApi.sync_info()` ajoute `app_version: PPM.VERSION`.
  - `SyncClient.hello()` rejette `Error` de code `"update_required"` portant `.details = {current, available, size, sha256, message}` et `"pc_outdated"` (message du PC) ; `SyncClient.downloadApk() -> Promise<Uint8Array>` (envoie `{"type":"apk"}`, vérifie `sha256` reçu == annoncé au hello **et** == SHA-256 calculé des octets, sinon `Error` code `"apk_corrupt"`, message « La mise à jour reçue est abîmée : relance la synchronisation. »). Délai de la requête apk : 60 s.
  - `native.installApk(bytes: Uint8Array) -> Promise<void>` : écrit dans le cache de l'appli, `FileProvider` (`fr.passepartout.app.fileprovider`), intent `ACTION_VIEW` + `FLAG_GRANT_READ_URI_PERMISSION` ; si `canRequestPackageInstalls()` est faux → ouvre `ACTION_MANAGE_UNKNOWN_APP_SOURCES` et rejette `code "INSTALL_PERMISSION"`. Permission `REQUEST_INSTALL_PACKAGES`. Compte comme écran natif (Ruling 23 : pas de verrouillage).
  - Écran (sync.js) : sur `update_required` avec `sha256` → « Une nouvelle version est disponible (A → X.Y.Z) : mets-la à jour pour synchroniser. » + bouton « Mettre à jour » → « Téléchargement… » → installateur ; message après lancement : « Installe la mise à jour, puis rouvre Passe-Partout et relance la synchronisation. » ; sans `sha256` : affiche `message` seul. Sur `INSTALL_PERMISSION` : « Autorise Passe-Partout à installer des applis, puis appuie à nouveau sur « Mettre à jour ». ». `pc_outdated` : message du PC. La session reste ouverte pendant ces étapes (le bouton « Mettre à jour » réutilise le même client).

- [ ] **Step 1: Tests (Node)** : `compareVersions` ; hello → `update_required` avec détails ; `downloadApk` renvoie les octets quand l'empreinte concorde ; **APK à l'empreinte fausse refusé** (Review Focus 2) ; `pc_outdated` ; `sync_info().app_version === PPM.VERSION` ; e2e réel : téléphone 0.9.0 simulé contre le vrai PC reçoit l'APK et l'empreinte concorde ; nativeFake `installApk` enregistre les octets.
- [ ] **Step 2–4: échecs → implémentation → verts ; `node --check` ; `powershell -File mobile\build.ps1`.**
- [ ] **Step 5: Commit** `feat(mobile): mise à jour de l'appli reçue du PC pendant la synchro`

---

### Task 6: Écrans du PC

**Files:**
- Create: `ui/views/apkinstall.js`
- Modify: `ui/views/settings.js` (carte Téléphones : bouton « Installer l'appli sur le téléphone » ; ligne « Passe-Partout X.Y.Z » en bas des Réglages), `ui/views/sync.js` (lien « Installer l'appli sur le téléphone » quand `list_devices()` est vide ; affichage de `notice`), `ui/mock-api.js`, `ui/style.css`, `ui/index.html`

**Interfaces:**
- Consumes: `apk_install_start/status/stop`, `get_app_info`, `sync_status().notice` (Tâches 3, 4).
- Produces: `PP.views.apkinstall.open()`.

Fenêtre : titre (icône `PP.icon.phone`) « Installer l'appli sur le téléphone », QR (fond blanc), 3 étapes numérotées (① Ouvre l'appareil photo du téléphone ② Vise ce QR code et ouvre le lien ③ Installe le fichier téléchargé — Android demandera d'autoriser l'installation), si plusieurs adresses : liste « Autre adresse » cliquable pour changer de QR, compte à rebours `m:ss`, « ✓ Appli téléchargée par le téléphone » quand `downloads > 0`, « QR expiré » + « Relancer ». Fermer → `apk_install_stop`. Sans APK : message de la Tâche 3. Mêmes garde-fous que la fenêtre de synchro (garde d'ouverture, arrêt du sondage sur toutes les sorties).

- [ ] **Step 1: Implémenter** (et la maquette dans `mock-api.js`).
- [ ] **Step 2: Vérifier dans le navigateur** (Edge sans affichage, maquette) : captures de la fenêtre d'installation, de la carte Téléphones et de la fenêtre de synchro avec un avis de mise à jour.
- [ ] **Step 3: Lancer** `.venv\Scripts\python -m pytest -q` → vert.
- [ ] **Step 4: Commit** `feat(ui): installer l'appli sur le téléphone depuis le PC, version affichée`

---

### Task 7: Publier une version

**Files:**
- Create: `tools/release.py`, `tests/test_release.py`, `release.ps1`, `RELEASE_NOTES.md`, `CLAUDE.md`

**Interfaces:**
- Consumes: `VERSION`, `build.ps1` (Tâche 2), `mobile/build.ps1` (Tâche 1).
- Produces:
  - `read_notes(path: Path, version: str) -> str` : exige la première ligne `<!-- version: X.Y.Z -->` égale à `version`, renvoie le texte sans le marqueur ; `ValueError` sinon (message : « RELEASE_NOTES.md est le rapport de la A, pas de la B : mets-le à jour. »).
  - `sensitive_tracked(files: list[str]) -> list[str]` : chemins suivis qui correspondent à `*.jks`, `*.keystore`, `signing.properties`, `vault.json`, `config.json` hors `mobile/`/`capacitor.config.json`, `*.xlsx`, `*.xlsm`, `*.env`, `update-config.cjs`.
  - `publish(version, exe_path, notes, token, repo="BlueFox71/passe-partout", dry_run=False)` : crée la release `v<version>` (titre = version, corps = notes) sur le tag déjà poussé, téléverse l'exe (`Content-Type: application/octet-stream`), via `urllib` sur `api.github.com` / `uploads.github.com` ; en `dry_run`, n'appelle rien et affiche ce qui serait fait.
  - `release.ps1 [-DryRun]` : arbre propre et sur `main` ; `sensitive_tracked(git ls-files)` vide ; notes valides ; pytest + `npm test` verts ; `mobile\build.ps1` puis `build.ps1` ; `GH_TOKEN` présent (sinon arrêt avant le tag : « Définis GH_TOKEN (jeton GitHub en écriture sur passe-partout) puis relance. ») ; tag `v<version>` + push ; `publish`. Le jeton n'est jamais affiché.
  - `RELEASE_NOTES.md` 1.0.0 (pour l'utilisateur : appli Android, synchro par QR, installation et mises à jour de l'appli depuis le PC) — **à faire valider par Jules avant le commit**.
  - `CLAUDE.md` : réponses en français ; à chaque montée de version, rédiger `RELEASE_NOTES.md` (marqueur + Nouveautés/Corrections, langage utilisateur) et le faire valider ; publier avec `release.ps1`.

- [ ] **Step 1: Tests**

```python
def test_notes_marker_mismatch_refused(tmp_path):      # Review Focus 5 : marqueur 0.9.0 pour 1.0.0 → ValueError
def test_notes_marker_removed(tmp_path):
def test_sensitive_tracked_file_refused():             # Review Focus 5
    assert sensitive_tracked(["app/api.py", "x/passe-partout.jks", "data/vault.json"]) == ["x/passe-partout.jks", "data/vault.json"]
def test_capacitor_config_not_sensitive():             # mobile/capacitor.config.json n'est pas signalé
def test_publish_dry_run_makes_no_request(monkeypatch):  # urllib.request.urlopen jamais appelé
```
- [ ] **Step 2–4: échecs → implémentation → verts ; `powershell -File release.ps1 -DryRun` va jusqu'au bout sans rien publier.**
- [ ] **Step 5: Commit** `feat: script de publication (vérifications, builds, release GitHub)`

---

### Task 8: Fiche dans Le Grenier

**Files (dépôt `D:\Documents\Logiciels persos\le-grenier`):**
- Modify: `catalog.json` ; Create: `assets-sources/passe-partout-*.png`, `public/icons/passe-partout.png`, `public/covers/passe-partout.png`, `public/pages/passe-partout*.webp` ; nouvelle version du Grenier (`package.json`) + son `RELEASE_NOTES.md`.

Entrée : `id` `passe-partout`, `name` « Passe-Partout », `tagline` « Tes mots de passe, chez toi, sur ton PC et ton téléphone », `tags` `["Outil", "Sécurité", "Hors ligne"]`, description de la conception §4.6, `type` `exe`, `repo` `BlueFox71/passe-partout`, `assetPattern` de Global Constraints, `launchLabel` « Ouvrir », `url` null, `cover`/`icon`/`screenshots` vers les fichiers ci-dessus.

- [ ] **Step 1: Captures (données de démonstration)** : PC (maquette `ui/index.html` sans pywebview : liste des comptes ; fenêtre de synchro avec QR) et téléphone (aperçu `mobile/www/?demo=1&code=1234` à 390×844, liste des comptes ou page Synchro) ; sources dans `assets-sources/` ; `make-screenshot.cjs` → `public/pages/`.
- [ ] **Step 2: Icône** depuis `ui/assets/icon.png` avec `make-project-icon.cjs`.
- [ ] **Step 3: Textes de la jaquette** : `compose-cover.cjs passe-partout --badge "100 % local, sans compte" --dry-run` ; **montrer les quatre textes à Jules et attendre sa validation**, puis générer.
- [ ] **Step 4: Vérifier** : `npm run electron:dev` montre la fiche (jaquette, icône, captures, bouton « Ouvrir ») ; `node scripts/check-token.mjs` (après la publication de la Tâche 9) trouve `Passe-Partout-1.0.0.exe`.
- [ ] **Step 5: Commit** dans le-grenier `feat: Passe-Partout dans le catalogue` (+ montée de version et rapport du Grenier, publication du Grenier avec son propre script — à lancer avec Jules).

---

### Task 9: Publication 1.0.0 et recette avec Jules

- [ ] **Step 1:** Jules valide `RELEASE_NOTES.md` ; `powershell -File release.ps1` avec `GH_TOKEN` fourni par Jules → release `v1.0.0` avec `Passe-Partout-1.0.0.exe`.
- [ ] **Step 2:** avec l'accord de Jules, à ce moment-là : fermer l'ancienne copie et supprimer `dist\Passe-Partout\` + son raccourci (et l'épingle de la barre des tâches) AVANT le premier lancement de la 1.0.0 (Ruling 6 : la 1.0.0 refuse de démarrer tant que « Passe-Partout.exe » tourne) ; puis le Grenier installe Passe-Partout ; il s'ouvre sur le coffre existant (`%APPDATA%\PassePartout`).
- [ ] **Step 3: Rattrapage du téléphone** : Réglages → « Installer l'appli sur le téléphone » → scan → installation par-dessus la 0.1.0 ; l'appli rouvre avec les mêmes données (code, empreinte, appairage) ; synchro normale.
- [ ] **Step 4: Mise à jour par la synchro** : construire localement une 1.0.1 de test (non publiée, `VERSION` modifié sans commit), la lancer, synchroniser → le téléphone propose la mise à jour, l'installe, garde ses données ; remettre `VERSION` à 1.0.0.
