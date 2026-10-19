# Passe-Partout Mobile (Android) + synchronisation — Document de conception

*19/10/2026 — projet : `D:\Documents\Logiciels persos\gestionnaire-mdp\` (logiciel PC existant) ; appli dans le sous-dossier `mobile/`.*

Légende : **[Jules]** = décidé par l'utilisateur ; **[choix Claude]** = décision de conception, contestable.

## 1. Intention

Jules a besoin de ses mots de passe **quand il n'est pas chez lui** : se connecter à une appli sur le
téléphone, retrouver le code PIN d'une carte au moment de payer. Il veut une **appli Android** liée au
logiciel PC Passe-Partout, avec une **synchronisation par QR code** : chez lui, il scanne un code affiché
par le PC et les deux ont les mêmes données. [Jules]

Le logiciel PC existe déjà (Python + pywebview, UI HTML/CSS/JS néon dans `ui/`, logique dans `app/`,
spec : `docs/2026-10-18-conception.md`). Interface en français, style néon identique.

## 2. Objectifs / non-objectifs / anti-objectifs

**Objectifs**
- Appli Android installable par `.apk` (hors Play Store). [Jules : Android]
- Consultation **hors ligne** : les données sont stockées sur le téléphone. [Jules]
- Modification **dans les deux sens** : ajouts / modifications / suppressions faits sur le téléphone
  remontent au PC à la synchro suivante, et inversement. [Jules]
- Synchro **en scannant un QR code** affiché par le PC, sur le Wi-Fi de la maison. [Jules]
- Ouverture par **le même code que le PC** ou par **l'empreinte digitale**. [Jules : les deux]
- **Tous les profils** visibles sur le téléphone. [Jules]
- Écrans validés par Jules (maquette `.superpowers/brainstorm/1073-1792363529/content/mobile-ecrans.html`) :
  ouverture PIN/empreinte ; liste (recherche, filtres profils Tout le monde/Jules/Alexis/⭐, index A–Z,
  bouton +, onglets Comptes · Cartes · Synchro · Réglages) ; fiche (copier, afficher, favori, modifier) ;
  écran Synchro (caméra + résumé « ↓ reçus · ↑ envoyés ») ; fenêtre PC avec QR code. [Jules]
- Contenu [choix Claude, validé par Jules] : comptes (ajout/modif/suppression, favoris, recherche,
  suggestions de noms + bibliothèque de logos comme sur PC) ; cartes cadeaux (solde, code, PIN,
  « J'ai dépensé… », alerte d'expiration).
- Plusieurs téléphones possibles (ex. celui d'Alexis), chacun se synchronise avec le PC. [choix Claude]

**Non-objectifs**
- Pas de cloud, pas de serveur Internet, pas de compte en ligne. La synchro passe uniquement par le
  réseau local, PC ↔ téléphone.
- Pas d'iPhone.
- Restent sur le PC seulement : import Excel, exports, gestion des profils, changement du code/verrou,
  sauvegardes. [choix Claude, validé]
- Pas d'auto-remplissage Android (service d'accessibilité / autofill) dans cette version.

**Anti-objectifs**
- Perte ou écrasement silencieux de données lors d'une synchro.
- Données lisibles par quelqu'un qui récupère le téléphone ou écoute le Wi-Fi.
- Un téléphone non autorisé (quelqu'un sur le même réseau) qui récupère le coffre.
- Look générique : même exigence néon que le PC.

## 3. Contraintes

- PC : Windows 11, logiciel Passe-Partout existant (pywebview / WebView2, Python 3.13).
- Téléphone : Android récent (minSdk à choisir par le bâtisseur, au moins Android 9).
- Outils : Android Studio / SDK / JDK gratuits installés sur le PC de Jules pour construire l'APK. [Jules : OK]
- 100 % local, aucun envoi vers Internet (ni l'appli, ni le PC).

## 4. Architecture [choix Claude]

- **Appli** : **Capacitor** (Android) emballant une UI web (HTML/CSS/JS vanilla) dans `mobile/`.
  Réutilise autant que possible le code PC : `ui/app.js` (utilitaires, format, recherche, logos),
  `ui/logos.js`, les styles néon. Les écrans mobiles sont des vues dédiées adaptées au tactile.
- Plugins Capacitor (choix exacts laissés au bâtisseur, préférer les plus maintenus) : scan de QR code
  (caméra), authentification biométrique + stockage protégé par l'**Android Keystore**, presse-papiers,
  préférences/fichiers, blocage des captures d'écran (`FLAG_SECURE`).
- **PC** : nouveau module `app/sync.py` (serveur de synchro + fusion), boutons/fenêtre dans l'UI PC.
  QR code généré côté Python (bibliothèque pure Python, ex. `segno`, embarquée).

## 5. Données : modifications du modèle PC

Pour fusionner sans perte, le modèle (`app/model.py`) gagne :
- `updated` (horodatage ISO) aussi sur `GiftCard` et `Profile` (existe déjà sur `Account`), mis à jour à
  chaque modification (y compris « J'ai dépensé… », favori, assignation en masse).
- `Vault.deleted` : liste de **pierres tombales** `{"kind": "account"|"giftcard"|"profile", "id", "at"}`
  ajoutées à chaque suppression (PC et téléphone). Conservées au moins 180 jours, puis purgées.
- `Vault.sync` (côté PC) : `{"devices": {device_id: {"name", "last_sync"}}}` — liste des téléphones
  appairés, affichée dans les Réglages PC avec possibilité d'en retirer un.
- Compatibilité : un coffre existant sans ces champs se charge normalement (valeurs par défaut).

**Fusion** [choix Claude, validé par Jules] — faite **sur le PC uniquement** :
- Par élément (compte / carte / profil, identifié par `id`) : la version au `updated` le plus récent gagne.
- Suppression vs modification : si la pierre tombale est plus récente que le `updated` de l'élément, il
  est supprimé partout ; sinon l'élément (modifié après la suppression) est conservé et la pierre tombale
  retirée.
- **Aucune perte silencieuse quand un même élément a été modifié des deux côtés** depuis la dernière
  synchro de ce téléphone [choix Claude] :
  - **Cartes cadeaux** : chaque dépense de l'historique reçoit un `id` ; les historiques sont fusionnés
    entrée par entrée et le solde est recalculé en retirant du solde gagnant les dépenses présentes
    seulement de l'autre côté. Deux « J'ai dépensé… » faits chacun d'un côté sont donc tous les deux comptés.
  - **Comptes (et autres champs de carte)** : la version la plus récente reste l'élément normal ; si l'autre
    version diffère réellement (identifiant, mot de passe, nom…), elle est **gardée en copie** nommée
    « <nom> (copie téléphone) » ou « (copie PC) », dans les mêmes profils, et signalée dans le résumé
    (« 1 conflit : copie gardée »). Une différence portant seulement sur le favori ne crée pas de copie.
  - « Modifié depuis la dernière synchro » se juge avec `Vault.sync.devices[device_id].last_sync`.
- Les réglages (`settings`) ne sont **pas** synchronisés (propres à chaque appareil).
- **Restauration d'une sauvegarde sur le PC** [choix Claude] : la restauration l'emporte sur les
  téléphones. Le coffre porte un compteur `generation` incrémenté à chaque restauration ; à la synchro, un
  téléphone d'une génération antérieure voit ses données **remplacées** par celles du PC (pas de fusion), et
  l'appli affiche avant de confirmer : « Le PC a restauré une sauvegarde : tes modifications faites sur le
  téléphone depuis le <date> seront remplacées. » (Annuler possible.)
- **Téléphone non synchronisé depuis plus de 180 jours** (pierres tombales purgées) : même traitement
  que ci-dessus (remplacement avec avertissement). [choix Claude]
- Un élément dont tous les profils ont disparu est rattaché au premier profil restant.
- Le PC fait une **sauvegarde automatique** (mécanisme existant) avant d'enregistrer le résultat d'une synchro.
- Résumé renvoyé aux deux côtés : nombre d'éléments reçus / envoyés / supprimés.

## 6. Protocole de synchronisation [choix Claude]

1. Sur le PC : Réglages ou barre du haut → **« Synchroniser le téléphone »**. Exige que le coffre PC ait un
   verrou (PIN ou mot de passe) ; sinon message invitant à en définir un.
2. Le PC démarre un serveur HTTP sur toutes ses adresses IPv4 privées, port aléatoire, **pendant 2 min**
   (ou jusqu'à la fin de la synchro, ou fermeture de la fenêtre), et affiche un QR code contenant :
   `{"v":1, "hosts":[IP…], "port":N, "key":<32 octets aléatoires, base64url>, "pc":"<nom du PC>"}`.
3. Le téléphone scanne, essaie chaque IP, et dialogue en **POST JSON chiffré AES-256-GCM avec la clé du QR**
   (nonce aléatoire par message ; tout message mal chiffré est refusé ; une seule synchro par QR).
   Personne sur le réseau ne peut lire ni forger les échanges sans avoir vu le QR.
4. Le téléphone envoie : `device_id` (aléatoire, créé à l'installation), nom de l'appareil, son coffre en
   clair (**l'appli est déverrouillée pendant la synchro**), et, à la première synchro ou si le PC a changé
   de code, le **code saisi** par l'utilisateur pour vérification.
5. Le PC vérifie le code si fourni (dérivation avec le sel de son coffre, comparaison de clé), fusionne,
   enregistre, et renvoie : le coffre fusionné, un identifiant de « version du code » (dérivé du sel du
   coffre PC, sans révéler le code), le résumé.
6. Le téléphone remplace ses données par le coffre fusionné, enregistre chiffré, affiche le résumé.
7. Le PC affiche « ✓ Téléphone de <nom> synchronisé » et le résumé, et met à jour `Vault.sync.devices`.

Première synchro (appli neuve, sans données) : l'appli demande d'abord le **code du PC**, qui est vérifié
par le PC à l'étape 5 ; un code faux est refusé (avec le délai anti-essais du PC).

## 7. Sécurité du téléphone [choix Claude, validé par Jules]

- **Même code que le PC** : le téléphone ne connaît pas la dérivation scrypt du PC (trop lourde en JS
  mobile : 256 Mo). Il chiffre ses données avec sa **propre clé aléatoire** (AES-256-GCM), elle-même :
  - enveloppée par une clé dérivée du code (PBKDF2-SHA256 via WebCrypto, ≥ 600 000 itérations, sel
    aléatoire) **et**
  - enveloppée par une clé non exportable de l'**Android Keystore** (matériel).
  Ainsi le fichier copié hors du téléphone est inexploitable, même avec un PIN court.
- Si la « version du code » renvoyée par le PC change (code changé sur le PC), l'appli redemande le
  nouveau code à l'ouverture suivante (vérifié à la synchro suivante, ou localement s'il permet d'ouvrir).
  Le bâtisseur choisit le parcours exact, tant que l'utilisateur ne perd jamais l'accès à ses données locales.
- **Empreinte** : activable dans les Réglages de l'appli après une ouverture par code ; la clé de données
  est alors aussi stockée enveloppée par une clé Keystore exigeant l'authentification biométrique.
  Désactivée automatiquement si l'empreinte du téléphone change.
- Délai croissant après codes faux (comme le PC), conservé après redémarrage de l'appli.
- Verrouillage automatique : passage en arrière-plan (> 30 s) et inactivité (5 min, réglable).
- Captures d'écran et aperçu dans les apps récentes bloqués (`FLAG_SECURE`).
- Presse-papiers vidé 30 s après copie d'un mot de passe / code / PIN.
- Aucune permission réseau Internet n'est nécessaire au-delà du réseau local ; aucune télémétrie.

## 8. Côté PC : changements d'interface

- Bouton **« Synchroniser le téléphone »** (barre du haut, icône ⇅) → fenêtre avec QR code, compte à
  rebours 2 min, état (« En attente… », « Synchronisation… », « ✓ synchronisé + résumé », erreurs claires).
- Réglages → carte **« Téléphones »** : liste des appareils synchronisés (nom, dernière synchro), bouton
  « Oublier ». (Oublier n'efface rien sur le téléphone ; il pourra se resynchroniser avec le code.)
- Message au premier lancement d'écoute réseau : Windows demandera l'autorisation du pare-feu
  (accepter pour « réseaux privés »).

## 9. Livraison

- Projet `mobile/` (Capacitor) dans le dépôt existant ; l'icône est la même clé blanche au contour
  néon (`ui/assets/icon.svg`), en icône adaptative Android.

**Construire l'appli**

- `powershell -File mobileuild.ps1` produit `mobile\dist\passe-partout.apk`. Le premier build
  télécharge les bibliothèques Android (plus long, connexion nécessaire).
- L'APK est signé avec une clé locale, dans `%APPDATA%\GestionnaireMdpndroid-signing\`.
  **Sauvegarde ce dossier** : sans cette clé, les futures mises à jour ne pourront pas s'installer
  par-dessus l'appli existante ; il faudra la désinstaller, réinstaller, puis resynchroniser.

**Installer sur le téléphone**

- Copier l'APK sur le téléphone (câble USB, transfert de fichiers), l'ouvrir depuis le gestionnaire
  de fichiers et autoriser « installer des applis inconnues » pour ce gestionnaire de fichiers.
- Ou, avec le débogage USB activé : `adb install -r mobile\dist\passe-partout.apk`.

**Première synchronisation**

1. Sur le PC : « ⇅ Synchroniser le téléphone » (un QR code s'affiche).
2. Sur le téléphone : « Synchroniser avec le PC », scanner le QR, puis saisir le code du PC.
3. Au premier lancement, le pare-feu Windows demande une autorisation : l'accepter pour les
   réseaux privés.

**Ce qu'il faut savoir**

- Les données du téléphone ne sont jamais sauvegardées par Android : avec un nouveau téléphone, on
  resynchronise depuis le PC.
- Après avoir restauré une sauvegarde sur le PC, chaque téléphone redemande le code une fois.
- Si le téléphone affiche « PC non reconnu », utiliser « Ré-appairer » avec un nouveau QR code et le
  code du PC.
- Tant que le téléphone n'a jamais été appairé, il ne peut pas vérifier que le PC est le bon : ne
  scanner que le QR affiché par son propre PC.
- Quitter l'appli pendant que le scanner de QR est ouvert ne déclenche pas le verrouillage
  automatique après 30 s.
- Le téléphone et le PC doivent être à l'heure (heure automatique) : plus de 5 minutes d'écart
  bloquent la synchronisation.

## 10. Laissé au bâtisseur
Choix exacts des plugins Capacitor, structure du code mobile, minSdk, mise en page fine des écrans
(dans l'esprit de la maquette), stratégie de tests (la fusion PC doit être couverte par des tests
pytest ; le chiffrement mobile par des tests JS ou des essais documentés), nom du paquet Android
(ex. `fr.passepartout.app`).
