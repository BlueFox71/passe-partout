# Cartes bancaires — conception (20/10/2026)

## Pourquoi

Une carte bancaire rangée comme un compte est mal décrite : le numéro va dans « Identifiant », le code
dans « Mot de passe » (avec une jauge de solidité qui n'a pas de sens), et l'expiration, le cryptogramme
ou le titulaire n'ont pas de place. Jules veut un vrai type « carte bancaire », sur le PC et le téléphone.

## Ce qui a été décidé avec Jules

- **Rubrique à part** « Cartes bancaires » dans le menu (à côté de « Cartes cadeaux »), les cartes
  dessinées comme de vraies cartes (maquette A).
- **Nom de la carte = la société** (Boursorama…), avec son logo (bibliothèque, logos livrés, logos de Jules).
- **Aperçu de la carte** : titulaire, 4 derniers chiffres, expiration, réseau (Visa, Mastercard…).
- **Fiche** : numéro, expiration, cryptogramme, code, titulaire ; **un bouton copier par champ**.
  Code et cryptogramme masqués, avec un œil pour les afficher. Les profils apparaissent en étiquettes.
- **Téléphone** : consulter, copier, **ajouter et modifier** ; même version que le PC.
- **Conversion automatique** des comptes qui sont en fait des cartes, une seule fois, à la mise à jour.
- **Pas d'alerte d'expiration.**

## Choix techniques (décisions de Claude)

- Nouveau type `BankCard` : `id, name, holder, number, expiry ("MM/AA" ou vide), cvv, pin, image,
  profiles, updated`. Collection `bankcards` dans le coffre, pierre tombale `kind = "bankcard"`.
- Synchro : même fusion que les autres éléments (le plus récent gagne, copie de conflit si modifié
  des deux côtés). Le PC exige déjà la même version d'appli que le téléphone : un téléphone pas encore à
  jour est bloqué et se voit proposer « Installer l'appli ».
- **Repérage pour la conversion** : identifiant de 13 à 19 chiffres (espaces et tirets acceptés).
  Le mot de passe va dans **Code** (4 chiffres ou autre texte) ou **Cryptogramme** (exactement 3 chiffres).
  Nom, image et profils sont repris ; le titulaire et l'expiration restent à compléter. Le compte est
  supprimé (pierre tombale, pour que le téléphone le supprime aussi). Faite sur le PC au déverrouillage,
  avec sauvegarde automatique avant ; un message indique combien de comptes ont été convertis.
- **Copie** : numéro (sans espaces), cryptogramme et code passent par la copie « secrète » (effacée du
  presse-papiers après 30 s) ; titulaire et expiration par la copie simple.
- **Réseau** déduit du numéro : 4 → Visa, 51-55 / 2221-2720 → Mastercard, 34 / 37 → American Express.
- Téléphone : onglets « Comptes · Cartes · Cadeaux · Synchro · Réglages » (« Cartes » = bancaires,
  l'ancien onglet des cartes cadeaux devient « Cadeaux »).
- Hors périmètre : export Excel des cartes, alerte d'expiration, recherche des cartes dans la liste des comptes.

# Cartes fidélité — ajout (20/10/2026)

- **Demande de Jules** : une carte fidélité = enseigne + **identifiant** et **code PIN**, tous deux facultatifs ;
  l'identifiant peut être **scanné depuis le code-barre** de la carte.
- PC : rubrique « Cartes fidélité » sous « Cartes bancaires » ; fiche avec copie par champ, PIN masqué.
- Téléphone : dans l'onglet « Cartes », deux boutons en haut : **Bancaires** / **Fidélité** (validé par Jules).
- Scan : téléphone seulement (scanner ZXing déjà embarqué pour le QR de synchro, ouvert aux codes-barres
  1D : EAN-13/8, UPC, Code 128/39/93, ITF, Codabar, et aussi QR / Data Matrix / PDF417).
- Choix techniques (Claude) : type `LoyaltyCard {id, name, number, pin, image, profiles, updated}`,
  collection `loyaltycards`, pierre tombale `kind = "loyaltycard"` ; même fusion que les autres éléments.
