# Passe-Partout — Gestionnaire de mots de passe — Document de conception

*Nom du logiciel : **Passe-Partout** [Jules]. 18/10/2026 — dossier projet : `D:\Documents\App Web\gestionnaire-mdp\`*

Légende : **[Jules]** = décidé par l'utilisateur ; **[choix Claude]** = décision de conception prise par Claude, contestable.

## 1. Intention

Jules gère aujourd'hui ses mots de passe dans un fichier Excel
(`D:\Documents\Papiers officiels numériques\mots de passe\mdps.xlsx`). Ça marche, mais c'est peu
pratique à manier au quotidien. Le but : un **vrai logiciel Windows**, local, agréable, qui remplace
l'Excel — rechercher vite un compte, copier un identifiant/mot de passe en un clic, garder des logos,
et pouvoir emporter ses mots de passe sur son portable via un export.

Profil utilisateur : francophone, à l'aise avec l'informatique, préfère les solutions locales et
gratuites. Toute l'interface est en **français**.

## 2. Objectifs / non-objectifs / anti-objectifs

**Objectifs**
- Liste des comptes avec recherche instantanée. [Jules]
- Formulaire de création et de modification. [Jules]
- Une image par compte (fichier du PC ou copier/coller depuis le web). [Jules]
- Export en **texte** et en **image** pour consulter sur le téléphone. [Jules]
- Verrou **optionnel** configurable : aucun / code PIN / mot de passe. [Jules]
- Format d'affichage personnalisable sur l'identifiant (ex. numéro fiscal). [Jules]
- Favoris. [Jules]
- Section spéciale **Cartes cadeaux** : ranger les codes ET suivre solde + expiration. [Jules]
- **Profils** façon Netflix (ex. couple : comptes de X / de Y), pour **ranger**, pas pour protéger. [Jules]
- Import unique des 130 comptes de l'Excel existant.

**Non-objectifs**
- Pas de synchronisation cloud, pas d'appli mobile, pas d'extension navigateur, pas d'auto-remplissage.
- Pas de multi-utilisateur avec droits / codes par profil.
- Pas de champs URL ni notes (Jules a dit non). [Jules]
- Pas de générateur de mots de passe (non demandé ; ajout possible plus tard).

**Anti-objectifs (échec même si « ça marche »)**
- Un look générique/terne : Jules a explicitement trouvé les premières maquettes décevantes. Le design
  néon doit être soigné, c'est une exigence de premier rang.
- Un verrou purement cosmétique (données lisibles en clair alors qu'un code est défini).
- Perdre ou corrompre des données (un fichier de mots de passe abîmé = catastrophe).
- Envoyer quoi que ce soit sur Internet.

## 3. Contraintes

- Windows 11, PC de Jules. Python 3.13 installé.
- 100 % local, hors ligne.
- Livré comme **programme Windows** lancé depuis une icône (pas d'onglet de navigateur visible). [Jules]
- Rangé dans `D:\Documents\App Web\gestionnaire-mdp\` (un sous-dossier par projet).

## 4. Technique [choix Claude]

- **Python + pywebview** : fenêtre Windows native (WebView2) affichant une interface HTML/CSS/JS ;
  la logique (stockage, chiffrement, import, export) est en Python, exposée au JS via l'API pywebview.
  Raison : reproduire fidèlement le style néon (dégradés, lueurs, verre dépoli) que Qt rendrait mal.
- Interface en HTML/CSS/JS **sans framework lourd** ni CDN (tout embarqué, fonctionne hors ligne).
  Le bâtisseur peut choisir une petite lib front s'il la vend localement.
- Emballage **PyInstaller** en `.exe` + raccourci bureau avec icône.
- Lecture de l'Excel : `openpyxl`. Chiffrement : `cryptography`. Images d'export : rendu côté Python
  (Pillow) ou capture côté WebView — au choix du bâtisseur, tant que le rendu respecte le style néon.

## 5. Données

### Modèle
- **Profil** : id, nom, avatar (image ou initiale + couleur).
- **Catégorie** : nom (libre ; liste construite à partir des comptes, créable depuis le formulaire).
- **Compte** : id, nom (« Support » dans l'Excel), catégorie, identifiant, mot de passe,
  format d'identifiant (facultatif), format de mot de passe (facultatif), image (facultative),
  favori (bool), profils (liste d'ids, **au moins un**), dates de création/modification.
- **Carte cadeau** : id, nom/enseigne, code, PIN, montant initial (facultatif), montant restant,
  date de fin (facultative), image (facultative), profils (liste d'ids), historique de dépenses
  (date + montant) [choix Claude].

### Stockage [choix Claude]
- Un seul fichier de données (JSON) dans `%APPDATA%\PassePartout\`, images incluses (en base64,
  redimensionnées à ~256 px pour rester léger).
- **Sans verrou** : fichier en clair.
- **Avec verrou** : tout le fichier (images comprises) chiffré — dérivation de clé **scrypt** (ou
  Argon2id) à partir du code, chiffrement **AES-256-GCM**. Changer/retirer le code re-chiffre le
  fichier.
- **Écriture atomique** (fichier temporaire puis renommage) + **sauvegarde automatique** des
  5 dernières versions à chaque enregistrement, pour ne jamais perdre de données.
- **Protection contre les intrusions** [Jules a demandé un « anti-piratage » ; détails = choix Claude] :
  - aucune connexion réseau dans l'appli (aucune requête sortante, aucune télémétrie) ;
  - délai croissant après des codes erronés à l'écran de verrouillage (ex. 1 s, 2 s, 4 s… plafonné
    à 5 min) ;
  - dérivation de clé volontairement lente (≈0,5–1 s) pour freiner les essais en masse sur le fichier
    volé — c'est la seule défense réelle pour un PIN, d'où la recommandation d'au moins 6 chiffres ;
  - intégrité vérifiée par AES-GCM : un fichier modifié est refusé (avec proposition de restaurer
    une sauvegarde) ;
  - les mots de passe ne sont jamais écrits dans des journaux ni des fichiers temporaires.
  - Limite assumée et à dire à Jules : rien ne protège contre un logiciel espion déjà installé sur le PC.
- **Validation du design d'abord** [Jules] : la construction commence par un prototype visuel en
  taille réelle des écrans (choix du profil, verrouillage, écran principal, formulaire, cartes
  cadeaux, export) sur données fictives ; Jules valide le look avant le branchement Python.
- Avertissement honnête dans les réglages : un PIN court est beaucoup moins solide qu'un mot de passe.
- Pas de récupération possible si le code est oublié : le dire clairement au moment de le définir,
  et demander de le taper deux fois.

## 6. Écrans

### Style « Néon / gaming » [Jules]
Référence : maquette 3 validée (`.superpowers/brainstorm/.../content/style-v2.html`).
Fond dégradé radial violet nuit (#3b0f5c → #0b0716), accents dégradé rose → violet (#ff3d9a → #7c3aed),
cyan lumineux (#00e5ff) en touche secondaire, panneaux en verre dépoli translucide, coins arrondis,
lueurs douces sur les boutons principaux, police Segoe UI. Petites animations de survol/transition
bienvenues, sans excès.

### Écran de verrouillage (si un verrou est défini)
Champ PIN (pavé numérique) ou mot de passe selon le réglage. Erreur claire si mauvais code.

**Re-verrouillage** [choix Claude] : bouton « 🔒 Verrouiller » dans la navigation, verrouillage
automatique après une durée d'inactivité réglable (défaut 10 min, « jamais » possible) et au
verrouillage de session Windows. Au re-verrouillage, la clé et les données déchiffrées sont effacées
de la mémoire, un formulaire en cours est abandonné (pas d'enregistrement partiel), le presse-papiers
est vidé s'il contient un mot de passe copié. Les sauvegardes automatiques sont chiffrées comme le
fichier principal.

### Choix du profil (au lancement) [Jules : façon Netflix]
« Qui est-ce ? » : grandes tuiles néon (avatar + nom), une tuile « Tout le monde », une tuile
« + Ajouter ». S'il n'existe qu'un profil, l'écran peut être sauté [choix Claude].

### Écran principal — structure liste + fiche [choix Claude, non contesté]
- **Navigation à gauche** : avatar du profil actif (clic → changer de profil), ⭐ Favoris, Tous,
  puis les catégories avec leur nombre ; en bas 🎁 Cartes cadeaux, ⚙ Réglages.
- **Colonne centrale** : barre de recherche + liste (logo, nom, identifiant). Dans « Tous », les
  favoris apparaissent en premier [choix Claude], puis ordre alphabétique.
- **Recherche** : en direct, insensible à la casse et aux accents, sur nom, identifiant et catégorie
  (pas sur le mot de passe) [choix Claude].
- **Fiche à droite** : grand logo, nom, catégorie, étoile favori, identifiant (affiché formaté) +
  bouton copier, mot de passe masqué + afficher + copier, jauge de solidité [choix Claude],
  boutons Modifier / Supprimer (avec confirmation).
- **En haut** : « + Nouveau », « Exporter ».
- Sélection multiple dans la liste pour **assigner des profils / une catégorie** en masse
  [choix Claude — nécessaire pour répartir les 130 comptes importés].
- Le presse-papiers est **vidé automatiquement après 30 s** quand on a copié un mot de passe
  [choix Claude].

### Formulaire création / modification [Jules : ces champs-là]
Catégorie (liste + saisie libre), Nom, Identifiant, Format identifiant (facultatif),
Mot de passe (avec œil), Format mot de passe (facultatif), Image, Favori, Profils (cases à cocher).

**Image** [Jules] : bouton « Choisir un fichier… » **et** collage Ctrl+V d'une image copiée depuis
le web dans une zone dédiée ; aperçu ; bouton retirer. Sans image : tuile colorée avec l'initiale.

**Format** [Jules] : modèle où `#` = un caractère, le reste est inséré tel quel
(ex. `## ## ### ### ###` → `12 34 567 890 123`). Affichage seulement : la valeur est stockée brute,
et **le bouton copier copie la valeur brute, sans espaces** [Jules]. Aperçu en direct dans le
formulaire. Si la valeur est plus longue que le modèle, le surplus est affiché à la suite.

### Cartes cadeaux [Jules : ranger + suivre solde et expiration ; détails = choix Claude]
- Écran à part, tuiles néon : image/enseigne, nom, **montant restant en grand**, date de fin.
- Fiche : code et PIN masqués avec afficher/copier, bouton « J'ai dépensé… » (saisie d'un montant,
  le solde se recalcule et l'opération va dans l'historique), correction directe du solde possible.
- **Bandeau au lancement** si une carte expire dans les 30 jours.
- Cartes expirées ou à 0 € rangées dans une section « Terminées » repliée (pas supprimées).
- Formulaire : nom, code, PIN, montant initial, montant restant, date de fin, image, profils.

### Réglages
Verrou (aucun / PIN / mot de passe ; définir, changer, retirer), gestion des profils (renommer,
avatar, supprimer — un compte n'est jamais supprimé avec un profil : s'il n'appartient plus à aucun
profil il est rattaché au profil restant ou proposé à la réaffectation), import Excel,
dossier des sauvegardes.

## 7. Export [Jules : texte + image, pour le téléphone]
Porte sur la **liste actuellement affichée** (profil + catégorie/filtre/recherche en cours)
[choix Claude], avec une case « inclure les cartes cadeaux ». Avertissement avant export : les
fichiers produits ne sont pas protégés.
- **Texte** : `.txt` UTF-8 lisible, groupé par catégorie, identifiants affichés **formatés**.
- **Image** : PNG au style néon, format portrait adapté au téléphone (~1080 px de large),
  **une image par catégorie** (découpée en plusieurs si trop longue), logos inclus.
- Les fichiers vont dans un dossier choisi par l'utilisateur (sélecteur de dossier).

## 8. Import de l'Excel existant
Fichier : `mdps.xlsx` (protection retirée par Jules). Structure constatée :
- Feuille « Mots de passes » : en-têtes sur la 2ᵉ ligne, colonnes **B = Type, C = Support,
  D = Identifiant, E = Mot de passe** ; 130 lignes remplies. Colonne A vide.
- Les valeurs doivent être lues **en texte** (attention aux nombres et zéros en tête : `06092597`
  doit rester tel quel ; les dates éventuelles idem). Les identifiants avec lien `mailto:` → garder
  le texte affiché.
- 19 types → catégories ; **fusion des doublons d'écriture** (casse/accents/espaces, ex.
  « Réseau Social » / « Réseau social », « Plateforme  de jeu » / « Plateforme de jeu »).
- 17 images flottantes à droite du tableau (colonnes F–H) : les rattacher à la ligne de leur ancre
  **uniquement si** la correspondance est sans ambiguïté ; sinon les ignorer (Jules pourra les
  ajouter à la main).
- Feuille « Cartes cadeaux » (Carte cadeaux, Code, Pin, Montant restant, Date fin) : actuellement
  vide ; importer les lignes s'il y en a.
- Tous les comptes importés vont dans un premier profil (nom demandé à l'import).
- Import proposé au premier lancement, réimport possible depuis les réglages [choix Claude] :
  le réimport **ne modifie jamais** un compte existant ; il n'ajoute que les lignes absentes
  (comparaison sur catégorie + nom + identifiant + mot de passe) et affiche un récapitulatif
  « X ajoutés, Y ignorés car déjà présents » avant de valider.
- Ne jamais afficher ni journaliser les mots de passe pendant l'import.

## 9. Laissé au bâtisseur
Architecture interne du code, structure des fichiers, choix exact KDF (scrypt/Argon2id),
méthode de rendu des PNG, animations, icône de l'application, algorithme de la jauge de solidité,
taille de fenêtre par défaut (redimensionnable, mémorisée), raccourcis clavier (au minimum
Ctrl+F recherche, Ctrl+N nouveau).

## 10. Évolutions demandées après la première livraison [Jules]
- **Accueil** : plus de proposition d'import Excel au premier lancement ; on saisit le prénom du premier
  profil et on choisit la protection (PIN conseillé / mot de passe / aucune). L'import reste dans les Réglages.
- **Bibliothèque de logos** embarquée (`ui/logos.js`, ~3 800 marques, générée par `tools/build_logos.py`
  à partir de Simple Icons CC0, plus des pastilles aux couleurs des marques françaises absentes).
- **Formulaire** (comptes et cartes cadeaux) : en tapant le nom, une liste de noms connus est proposée ;
  choisir un nom connu ou le taper en entier pose son logo dans le formulaire (toujours modifiable).
  Le logo automatique ne remplace jamais une image choisie à la main.
- **Réglages** : bouton « Ajouter les logos manquants » (aussi appliqué après un import), lien vers le
  dossier des sauvegardes.
- Corrections de la relecture : formats numériques Excel, restaurations sans perte, données effacées de
  l'interface au verrouillage, dialogues non bloquants, réimport avec récapitulatif, import atomique,
  délai anti-essais conservé au redémarrage, presse-papiers occupé, rotation EXIF, exports sans écrasement,
  catégories et recherche insensibles aux ligatures/casse.
