// Génère mobile/www/js/version.js (ignoré par git) à partir du fichier VERSION à la racine du dépôt.
// Lancé par « npm run assemble » et par « npm test » (pretest).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export function writeVersionFile() {
  const version = readFileSync(join(here, "..", "..", "VERSION"), "utf8").trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`VERSION invalide : ${JSON.stringify(version)}`);
  const out = join(here, "..", "www", "js", "version.js");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(
    out,
    `// Généré par scripts/version.mjs depuis le fichier VERSION : ne pas modifier.\n` +
      `(function (root) {\n  root.PPM = root.PPM || {};\n  root.PPM.VERSION = ${JSON.stringify(version)};\n` +
      `})(typeof window !== "undefined" ? window : globalThis);\n`,
  );
  console.log(`version : ${version} → www/js/version.js`);
  return version;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeVersionFile();
}
