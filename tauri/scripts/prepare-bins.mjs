// Télécharge rclone pour la plateforme HÔTE et le range dans src-tauri/binaries/
// sous le nom attendu par le mécanisme `externalBin` de Tauri :
//   binaries/rclone-<target-triple>[.exe]
//
// Usage : node scripts/prepare-bins.mjs
// Cross-plateforme (Windows / macOS / Linux) : téléchargement via fetch natif
// (Node 18+). Les binaires sont des exécutables BRUTS (pas des archives), donc
// aucun outil de décompression n'est nécessaire.
//
// AUTHENTIFICATION — facultative : le dépôt est public, les assets se
// téléchargent sans jeton. Si `GITHUB_TOKEN` (fourni d'office aux workflows
// GitHub Actions) ou `GH_TOKEN` est présent, on s'en sert quand même : ça
// évite la limite de requêtes anonymes de l'API GitHub.
//
// PARTICULARITÉ — on n'utilise PAS le rclone officiel mais une version PATCHÉE
// (rclone v1.74.4 + upload multi-thread SFTP : ~×5 en montée sur lien lointain).
// Les binaires patchés sont hébergés dans une release GitHub du dépôt Copiteur.
// Source du patch : backend/sftp/writerat.go (OpenWriterAt + pool de connexions)
// + option `disable_multithread_upload`. Fusionné upstream (rclone PR #9724),
// pas encore dans une version officielle ; d'ici là on embarque notre build.
//
// SÉCURITÉ — ce binaire finit DANS l'installeur qu'on signe et qu'on distribue.
// Deux garde-fous conservés :
//   1. la version est FIGÉE (URL de release immuable) ;
//   2. l'empreinte SHA-256 attendue est écrite ICI, dans le dépôt. On refuse
//      d'installer un binaire qui ne correspond pas. Les avoir en dur protège
//      même si l'hébergement de la release était un jour compromis.
//
// Mise à jour du binaire patché : reconstruire, republier la release (changer
// RELEASE), puis recopier les empreintes SHA-256 des nouveaux binaires ici.

import { createHash } from "node:crypto";
import { mkdirSync, existsSync, chmodSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN_DIR = join(__dirname, "..", "src-tauri", "binaries");
const isWin = process.platform === "win32";

// Release GitHub hébergeant les binaires rclone patchés.
const REPO = "Splainte/Copiteur";
const TAG = "rclone-mtsftp-v1.74.4";

const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
const GH_HEADERS = {
  ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "copiteur-prepare-bins",
};

// Plateforme Node -> (triple Rust, extension, empreinte SHA-256 du binaire
// patché). Le nom de l'asset dans la release EST `rclone-<triple>[.exe]`, donc
// identique au nom de destination.
const PLATFORMS = {
  "linux-x64": {
    triple: "x86_64-unknown-linux-gnu",
    ext: "",
    sha256: "8d04a7cf81a35a3094ca6e1ae83ce8cff16bb1d0b3e6f376d7e64eaf8f8b0404",
  },
  "linux-arm64": {
    triple: "aarch64-unknown-linux-gnu",
    ext: "",
    sha256: "497f22441f82883bc901e5155d7b039b99c154a805ef851d5c8537b1b8939954",
  },
  "win32-x64": {
    triple: "x86_64-pc-windows-msvc",
    ext: ".exe",
    sha256: "39f0fbaf2859ee1daa2278fc324bbb4330e3e5b9023cc16983bae796d74a51be",
  },
  "darwin-x64": {
    triple: "x86_64-apple-darwin",
    ext: "",
    sha256: "97a4479903bae1463e3cd631b971ba20261c6dc5f9b5159f77b2e6805fb12f79",
  },
  "darwin-arm64": {
    triple: "aarch64-apple-darwin",
    ext: "",
    sha256: "40529387c06c326760c3ec5513014b298db3c179b4398e66cb6044e081d61d49",
  },
};

const key = `${process.platform}-${process.arch}`;
const p = PLATFORMS[key];
if (!p) {
  console.error(`Plateforme non gérée : ${key}`);
  process.exit(1);
}

mkdirSync(BIN_DIR, { recursive: true });
const name = `rclone-${p.triple}${p.ext}`;
const dest = join(BIN_DIR, name);
if (existsSync(dest)) {
  console.log(`rclone déjà présent : ${dest}`);
  process.exit(0);
}

// 1. Récupère la release par tag pour trouver l'asset par NOM (pas d'ID en dur,
//    qui changerait si la release était recréée).
const relRes = await fetch(
  `https://api.github.com/repos/${REPO}/releases/tags/${TAG}`,
  { headers: { ...GH_HEADERS, Accept: "application/vnd.github+json" } },
);
if (!relRes.ok) {
  console.error(`Release introuvable (HTTP ${relRes.status}).`);
  process.exit(1);
}
const release = await relRes.json();
const asset = (release.assets || []).find((a) => a.name === name);
if (!asset) {
  console.error(`Asset « ${name} » absent de la release ${TAG}.`);
  process.exit(1);
}

// 2. Télécharge le binaire via l'endpoint API de l'asset (Accept: octet-stream
//    -> redirige vers le binaire ; fetch suit la redirection).
console.log(`Téléchargement du rclone patché : ${name}`);
const res = await fetch(asset.url, {
  headers: { ...GH_HEADERS, Accept: "application/octet-stream" },
});
if (!res.ok) {
  console.error(`Échec du téléchargement (HTTP ${res.status}).`);
  process.exit(1);
}
const bin = Buffer.from(await res.arrayBuffer());

// Vérification AVANT d'écrire sur le disque : un binaire qui ne correspond pas
// à l'empreinte attendue n'est jamais installé.
const got = createHash("sha256").update(bin).digest("hex");
if (got !== p.sha256) {
  console.error(
    "BINAIRE REFUSÉ : l'empreinte SHA-256 ne correspond pas.\n" +
      `  attendue : ${p.sha256}\n` +
      `  obtenue  : ${got}\n` +
      "Le téléchargement est corrompu ou altéré — on n'installe pas ce binaire.",
  );
  process.exit(1);
}
console.log(`Empreinte SHA-256 vérifiée : ${got.slice(0, 16)}…`);

writeFileSync(dest, bin);
if (!isWin) chmodSync(dest, 0o755);
console.log(`OK -> ${dest}`);
