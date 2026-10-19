# Passe-Partout dans Le Grenier — Document de conception

*20/10/2026 — projets : Passe-Partout (`D:\Documents\Logiciels persos\gestionnaire-mdp\`, dépôt
`github.com/BlueFox71/passe-partout`) et Le Grenier (`D:\Documents\Logiciels persos\le-grenier\`).*

Légende : **[Jules]** = décidé par l'utilisateur ; **[choix Claude]** = décision de conception, contestable.

## 1. Intention

Jules installe et met à jour ses projets depuis **Le Grenier**, son launcher de bureau (catalogue +
GitHub Releases, notice : `le-grenier/docs/AJOUTER-UN-PROJET.md`). Passe-Partout doit y entrer comme
les autres, et l'appli Android doit suivre **sans effort** : Jules ne veut jamais aller chercher l'APK
ailleurs ni brancher un câble. [Jules]

## 2. Objectifs / non-objectifs / anti-objectifs

**Objectifs**
- Le Grenier installe, lance (« Ouvrir ») et met à jour **un seul produit** : le logiciel PC
  Passe-Partout, publié en GitHub Release. [Jules]
- Le logiciel PC **embarque l'APK Android** de la même version. [Jules]
- Bouton PC **« Installer l'appli sur le téléphone »** : affiche un QR code ; l'appareil photo du
  téléphone le scanne et télécharge l'APK depuis le PC, sur le Wi-Fi local. [Jules]
- **Mise à jour du téléphone par la synchro** : à chaque synchro, le PC compare la version de l'appli
  du téléphone à celle de l'APK qu'il embarque ; si le téléphone est plus ancien, **la mise à jour
  passe en priorité** : pas de synchro, le téléphone propose « Mettre à jour » et installe l'APK reçu
  du PC. Les modifications locales du téléphone attendent la synchro suivante. [Jules]
- Première version publiée : **1.0.0**. [Jules]
- Visuels et textes de la fiche du Grenier : carte blanche. [Jules]

**Non-objectifs**
- Pas de fiche séparée pour l'appli Android dans le Grenier.
- Pas de Play Store, pas de serveur, pas de téléchargement de l'APK depuis Internet par le téléphone.
- Pas d'updater propre à Passe-Partout côté PC : c'est le Grenier qui met à jour le logiciel PC.

**Anti-objectifs**
- Une mise à jour qui fait perdre des données du téléphone (coffre, code, empreinte, appairage).
- Une fausse appli installée sur le téléphone via un faux PC ou le Wi-Fi.
- Une synchro entre deux versions incompatibles qui abîme des données.
- Des vrais mots de passe de Jules visibles sur les captures d'écran publiées dans le Grenier.
- La clé de signature Android qui quitte le PC de Jules (jamais sur GitHub, ni dans GitHub Actions).

## 3. Contraintes

- Le Grenier exige un **exécutable autonome** (pas d'installeur), dont le nom porte la version
  (`assetPattern`, attention : GitHub remplace les espaces par des tirets), et une release dont les
  **notes** forment le rapport de version (`RELEASE_NOTES.md` + marqueur `<!-- version: X.Y.Z -->`,
  convention commune de ses projets, modèle `le-grenier/docs/modeles/publish-notes.mjs`).
- Les données restent dans `%APPDATA%\PassePartout\` (indépendantes du dossier d'installation du
  Grenier `games/<id>/`).
- La clé de signature Android est dans `%APPDATA%\PassePartout\android-signing\` : la construction de
  l'APK et donc la publication se font **sur le PC de Jules**. [choix Claude, imposé par l'anti-objectif]
- Android n'accepte une mise à jour que si l'APK est signé avec la même clé que l'appli installée :
  c'est ce qui empêche une fausse appli de remplacer la vraie.
- 100 % local pour l'APK : PC → téléphone sur le réseau de la maison uniquement.

## 4. Conception

### 4.1 Un seul numéro de version [choix Claude]
Une seule source de vérité pour la version (fichier au choix du bâtisseur), utilisée par : le logiciel
PC (affichée dans les Réglages), l'appli Android (`versionName` ; `versionCode` dérivé et toujours
croissant, ex. `major*10000 + minor*100 + patch`), l'affichage de version de l'appli (`PPM.VERSION`,
aujourd'hui codé en dur à 0.1.0), le tag `vX.Y.Z` et le nom de l'asset.

### 4.2 L'exécutable publié [choix Claude]
- PyInstaller en **un seul fichier** : `Passe-Partout-X.Y.Z.exe` (sans espace), qui contient l'interface
  et l'APK de la même version. Démarrage un peu plus lent (décompression) : accepté.
- `catalog.json` du Grenier : `"type": "exe"`, `"repo": "BlueFox71/passe-partout"`,
  `"assetPattern": "^Passe-Partout[ .-]\\d.*\\.exe$"`, `"launchLabel": "Ouvrir"`.
- Le `build.ps1` actuel reste pour le développement ; il ne crée plus le raccourci du bureau (le Grenier
  sait faire les raccourcis Windows). [choix Claude]
- L'ancienne copie `dist\Passe-Partout\` et son raccourci du bureau (construits avant la gestion des
  versions, donc capables de synchroniser avec un téléphone d'une autre version) sont **supprimés** une
  fois la 1.0.0 installée par le Grenier — étape de la recette, avec l'accord de Jules au moment de le
  faire. [choix Claude]
- **Une seule instance à la fois** : un deuxième Passe-Partout lancé sur le même dossier de données
  (copie de développement + copie du Grenier) refuse de démarrer et le dit en français. [choix Claude]

### 4.3 Installer l'appli depuis le PC
- Bouton **« Installer l'appli sur le téléphone »** dans les Réglages PC (carte « Téléphones »), et lien
  dans la fenêtre de synchro quand aucun téléphone n'est appairé. [choix Claude]
- Le PC ouvre un petit serveur HTTP local (même logique que la synchro : IP privées, port aléatoire,
  quelques minutes, arrêt à la fermeture de la fenêtre) qui ne sert **que l'APK**, sous une adresse
  contenant un jeton aléatoire ; le QR code contient cette adresse (`http://<IP>:<port>/<jeton>/passe-partout-X.Y.Z.apk`).
  Le téléphone l'ouvre avec son appareil photo → navigateur → téléchargement → installation (Android
  demande une fois l'autorisation « installer des applis inconnues » pour le navigateur).
- Fenêtre PC : QR, consigne en 3 étapes illustrées, compte à rebours, « ✓ Appli téléchargée par le
  téléphone » quand le fichier a été servi en entier. Si le PC a plusieurs IP, toutes sont proposées
  (un QR par IP ou une liste, au choix du bâtisseur).
- L'APK n'est pas secret (il ne contient aucune donnée) : le jeton dans l'adresse évite seulement un
  téléchargement par hasard. Une première installation par le navigateur ne peut pas vérifier le PC :
  accepté (même réseau, Jules présent). [choix Claude]
- Sert aussi de rattrapage : l'appli 0.1.0 actuellement sur le téléphone de Jules ne sait pas se mettre
  à jour par la synchro, elle se met à jour une dernière fois par ce bouton.

### 4.4 Mise à jour du téléphone par la synchro
- Le `hello` du téléphone porte la version de son appli. Le PC la compare à la version de l'APK embarqué.
  - **Téléphone plus ancien** (ou version absente : appli 0.1.0) → le PC **refuse la synchro** avec une
    réponse dédiée « mise à jour requise » (version disponible, taille, empreinte SHA-256 de l'APK).
    L'appli 0.1.0 ne la comprend pas : elle doit afficher un message lisible, donc le PC renvoie aussi
    un `message` français du type « Mets à jour l'appli : sur le PC, Réglages → Installer l'appli sur
    le téléphone. ». [choix Claude]
  - **Téléphone plus récent que le PC** → synchro refusée : « Mets à jour Passe-Partout sur le PC
    (Le Grenier). ». [choix Claude — évite toute synchro entre versions incompatibles]
  - **Même version** → synchro normale.
- Sur « mise à jour requise », le téléphone affiche « Une nouvelle version est disponible
  (A.B.C → X.Y.Z) : mets-la à jour pour synchroniser » + bouton **« Mettre à jour »** ; il télécharge
  l'APK **dans la même session chiffrée** (nouveau type de message, réponse scellée ; la limite de
  taille des réponses doit permettre ~15 Mo), vérifie l'empreinte SHA-256 annoncée, puis lance
  l'installateur Android (permission `REQUEST_INSTALL_PACKAGES`, `FileProvider`, intention
  d'installation ; Android demande une fois d'autoriser Passe-Partout à installer des applis).
- Côté PC, la fenêtre de synchro affiche « Le téléphone de <nom> doit être mis à jour (A.B.C → X.Y.Z) »,
  puis « ✓ Appli envoyée au téléphone » quand l'APK est parti.
- Un téléphone non appairé peut recevoir l'APK aussi : la vraie protection est la signature (Android
  refuse un APK signé par une autre clé) ; l'empreinte SHA-256 protège contre un transfert abîmé.
- Rien n'est effacé ni modifié sur le téléphone par la mise à jour (coffre, clés Keystore, préférences,
  appairage conservés par Android) ; après redémarrage de l'appli, Jules relance la synchro.

### 4.5 Publier une version
- Script `release.ps1` lancé sur le PC de Jules [choix Claude] :
  1. vérifie : arbre git propre, sur `main`, version cohérente partout, `RELEASE_NOTES.md` dont le
     marqueur correspond à la version, tests PC et téléphone verts, et — le dépôt étant **public** —
     qu'aucun fichier sensible n'est suivi par git (clé `.jks`, `signing.properties`, `vault.json`,
     `config.json` de données, fichiers Excel, jeton) ;
  2. construit l'APK signé (clé locale), puis l'exe unique qui l'embarque ;
  3. crée le tag `vX.Y.Z`, le pousse, crée la GitHub Release avec l'exe en pièce jointe et
     `RELEASE_NOTES.md` comme notes (sans le marqueur), via l'API GitHub et un jeton en écriture lu
     dans `GH_TOKEN` (jamais écrit dans le dépôt). Ce jeton en écriture sur `passe-partout` est fourni
     par Jules au moment de publier ; sans lui, le script s'arrête avec un message clair avant le tag.
- Rattrapage : l'appli 0.1.0 du téléphone de Jules a été signée avec la clé actuelle (empreinte
  SHA-256 `a3ea3192…16ff52`, vérifiée le 19/10/2026), donc l'installation de la 1.0.0 par-dessus
  conserve ses données.
- Un `CLAUDE.md` à la racine de Passe-Partout demande, comme dans les autres projets, de rédiger
  `RELEASE_NOTES.md` à chaque montée de version et de le faire valider par Jules. Le rapport parle à
  l'utilisateur (ce qui change pour lui), pas au développeur.

### 4.6 La fiche dans Le Grenier [choix Claude, carte blanche]
- `id` `passe-partout`, nom « Passe-Partout », tags « Outil · Sécurité · Hors ligne », accroche du
  type « Tes mots de passe, chez toi, sur ton PC et ton téléphone », description : gestionnaire de mots
  de passe et de cartes cadeaux 100 % local (aucun compte, aucun cloud), profils, synchro avec le
  téléphone par QR code sur le Wi-Fi.
- Visuels, avec les scripts du Grenier et sources dans `le-grenier/assets-sources/` :
  icône depuis la clé néon (`make-project-icon.cjs`), jaquette composée (`compose-cover.cjs`, charte
  commune avec Convertout), 3 captures 16:9 (`make-screenshot.cjs`) : liste des comptes sur le PC,
  fenêtre de synchro avec QR, appli téléphone (aperçu navigateur à taille de téléphone, les captures
  du vrai téléphone étant bloquées). **Uniquement des données de démonstration** (maquette PC et
  aperçu téléphone), jamais le vrai coffre.
- **Les quatre textes de la jaquette (nom, tags, pastille, accroche) sont validés par Jules avant de
  générer l'image** (règle du Grenier, `--dry-run`).
- Images locales dans `le-grenier/public/` : il faut reconstruire et republier Le Grenier (nouvelle
  version + son propre `RELEASE_NOTES.md`) pour qu'elles apparaissent. [choix Claude : chemin standard
  de la notice]
- Le dépôt `passe-partout` est **public** et Jules a déjà réglé l'accès du Grenier [Jules] ;
  `node scripts/check-token.mjs` confirme que l'asset est trouvé.

## 5. Tests attendus
- Fusion/synchro inchangées (suites existantes vertes).
- Protocole de mise à jour : téléphone plus ancien / sans version / plus récent / identique, téléchargement
  de l'APK par la session chiffrée, empreinte vérifiée, refus d'un APK abîmé — côté PC (pytest) et
  côté téléphone (tests Node, faux natif) ; test d'intégration réel PC ↔ téléphone étendu.
- Serveur d'installation : sert l'APK entier sous le bon jeton, 404 sinon, arrêt au délai.
- Essai sur le téléphone de Jules : installation par le bouton PC (rattrapage 0.1.0 → 1.0.0) en gardant
  les données, puis une mise à jour par la synchro avec une version 1.0.1 de test (non publiée).
- Publication : `release.ps1` en mode « à blanc » (sans pousser) avant la vraie publication ;
  `check-token.mjs` du Grenier trouve l'asset.

## 6. Laissé au bâtisseur
Fichier de version, format exact des nouveaux messages du protocole, présentation des IP multiples du QR
d'installation, mise en page des fenêtres, outillage de l'appel à l'API GitHub (script PowerShell ou
Node), ordre des tâches entre les deux dépôts.
