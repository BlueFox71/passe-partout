// Copie le cœur d'interface partagé du PC (ui/) dans mobile/www/shared/ (ignoré par git).
// Lancer avant d'ouvrir l'aperçu ou de construire l'appli : npm run assemble
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeVersionFile } from "./version.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ui = join(here, "..", "..", "ui");
const out = join(here, "..", "www", "shared");

const FILES = ["app.js", "logos.js", "logos-perso.js", "style.css", "assets/icon.svg"];

for (const f of FILES) {
  const dest = join(out, f);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(join(ui, f), dest);
  console.log(`copié : ui/${f} → www/shared/${f}`);
}

writeVersionFile();
