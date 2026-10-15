// Génère le jeu d'icônes Tauri de Copiteur à partir de l'ICÔNE COMPOSÉE
// (squircle sombre + glyphe, plein cadre 1024 — cf. src-tauri/icons/source/).
//
//   node scripts/make-icons.mjs [icone-composee.png]
//   (défaut : src-tauri/icons/source/copiteur-icone-v3-1024.png)
//
// `tauri icon` génère TOUTES les plateformes depuis une seule source, mais
// macOS et Windows ne veulent PAS le même cadrage :
//
//   - macOS (Dock) : grille officielle Apple = corps 824 centré dans 1024
//     (100 px de marge/côté) + squircle à COURBURE CONTINUE (r≈185,4). On
//     re-masque donc le contenu avec ce squircle (masque pré-calculé
//     source/apple-squircle-824.png) au lieu de garder les coins de la source.
//     -> .icns + PNG (Dock / Linux).
//
//   - Windows (barre des tâches / menu Démarrer) : l'icône doit REMPLIR la
//     tuile. => on régénère icon.ico en PLEIN CADRE (coins arrondis de la
//     source conservés). macOS applique tout seul un liseré/bevel "Liquid
//     Glass" au rendu (visible dans le Dock/Launchpad) ; Windows n'a rien
//     d'équivalent, donc on l'imite en dur sur cette source UNIQUEMENT : un
//     bevel clair en haut-gauche / ombre en bas-droite le long du contour du
//     squircle (cf. bevelWindows plus bas).
//
// D'où deux sources distinctes et deux passes de génération.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, copyFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const ICONS = join(ROOT, "src-tauri", "icons");
const TAURI = join(ROOT, "node_modules", ".bin", "tauri");
const MASK = join(ICONS, "source", "apple-squircle-824.png"); // squircle Apple (alpha)

const logo = process.argv[2] || join(ICONS, "source", "copiteur-icone-v3-1024.png");
if (!existsSync(logo)) {
  console.error(`Source introuvable : ${logo}`);
  process.exit(1);
}
if (!existsSync(MASK)) {
  console.error(`Masque squircle Apple introuvable : ${MASK}`);
  process.exit(1);
}

// Applique un bevel façon "Liquid Glass" (highlight haut-gauche + ombre
// bas-droite) le long du contour alpha d'une icône plein cadre, en place.
// Technique : la carte alpha lissée sert de heightmap à `-shade`, qui simule
// un relief eclaire depuis `azimuth x elevation` — plat (gris 50 %) partout
// sauf sur la bande de transition du contour, exactement l'effet recherché.
// On ne compose ce relief qu'en Overlay (contraste doux) puis on replaque
// l'alpha d'origine pour ne pas déborder sur les coins transparents.
function bevelWindows(src) {
  const mask = join(tmp, "mask.png");
  const maskBlur = join(tmp, "mask-blur.png");
  const shade = join(tmp, "shade.png");
  const beveled = join(tmp, "src-win-bevel.png");

  execFileSync("magick", [src, "-alpha", "extract", mask]);
  execFileSync("magick", [mask, "-blur", "0x4", maskBlur]);
  execFileSync("magick", [maskBlur, "-shade", "130x40", shade]);
  execFileSync("magick", [
    src, shade, "-compose", "Overlay", "-composite",
    mask, "-alpha", "off", "-compose", "CopyOpacity", "-composite",
    beveled,
  ]);
  return beveled;
}

const tmp = mkdtempSync(join(tmpdir(), "copiteur-icons-"));
const macSrc = join(tmp, "src-macos.png"); // corps 824 re-masqué + marge Dock
const winSrc = join(tmp, "src-win.png"); // plein cadre

// macOS : contenu -> 824, intersecté avec le squircle Apple, centré (marge 100).
execFileSync("magick", [
  logo, "-resize", "824x824",
  MASK, "-compose", "DstIn", "-composite",
  // IMPORTANT : remettre Over avant l'extent — sinon `-extent` compose l'image
  // sur le fond en DstIn (compose encore actif) et rend un canvas VIDE.
  "-compose", "Over",
  "-background", "none", "-gravity", "center", "-extent", "1024x1024",
  macSrc,
]);

// Windows : source remise à 1024², plein cadre (le squircle remplit la tuile).
execFileSync("magick", [
  logo, "-resize", "1024x1024",
  "-background", "none", "-gravity", "center", "-extent", "1024x1024",
  winSrc,
]);

// 1) Jeu complet (icns macOS + PNG + ico) depuis la source à marge macOS.
execFileSync(TAURI, ["icon", macSrc], { stdio: "inherit", cwd: ROOT });

// 2) On régénère UNIQUEMENT icon.ico en plein cadre pour la barre des tâches,
//    avec le bevel façon Liquid Glass.
const winOut = join(tmp, "winset");
const winSrcBevel = bevelWindows(winSrc);
execFileSync(TAURI, ["icon", winSrcBevel, "-o", winOut], { stdio: "inherit", cwd: ROOT });
copyFileSync(join(winOut, "icon.ico"), join(ICONS, "icon.ico"));

rmSync(tmp, { recursive: true, force: true });
console.log(
  "\nIcônes générées : .icns/PNG corps 824 squircle Apple (Dock macOS), icon.ico plein cadre + bevel Liquid Glass (Windows).",
);
