# Passe-Partout

- Réponds toujours en français.
- À chaque montée de version (`VERSION`), rédige `RELEASE_NOTES.md` : première ligne `<!-- version: X.Y.Z -->`, puis `### Nouveautés` et `### Corrections`, en langage utilisateur (ce qui change pour lui, sans détails techniques). Fais-le valider par Jules avant de le committer.
- Publie une version avec `release.ps1` (depuis `main`, arbre propre, `GH_TOKEN` défini). `release.ps1 -DryRun` simule sans rien publier. Ne crée jamais la release ni le tag à la main.
