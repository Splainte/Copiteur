// ============================================================
//  Copiteur — BETA DESIGN : registre des interfaces proposees
//
//  Une seule app, plusieurs « habillages » qu'on bascule a chaud pour les
//  comparer : menu « Design (bêta) » de la barre de menus sur macOS, bouton
//  « Debug » de la barre de titre sur Windows. Le choix est memorise.
//
//  - actuelle  : l'interface de la 1.2, intacte (point de comparaison)
//  - volet     : A — serveurs + emplacements dans un volet lateral
//  - ilots     : B — deux panneaux flottants, transferts dans une pastille
//  - classique : C — la disposition actuelle, habillee pour le systeme
//
//  Les composants lisent la disposition avec `useDesign()`. Les styles propres
//  a chaque habillage vivent dans design.css, sous `[data-design=…]`.
// ============================================================
import { useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { t, type Key } from "./i18n";

// Seconde serie (03/11/2026) : Robin a retenu B « Îlots » sur les deux
// systemes ; les trois propositions declinent la zone des transferts. Les
// habillages de la premiere serie (volet, ilots, classique) restent dans le
// code mais ne sont plus proposes.
export type Layout = "actuelle" | "volet" | "ilots" | "classique" | "bas" | "colonne" | "vue";
export const LAYOUTS: Layout[] = ["actuelle", "bas", "colonne", "vue"];
// Famille d'habillage (styles communs des Îlots, cf. design.css).
export const familyOf = (d: Layout): string =>
  d === "actuelle" ? "actuelle" : d === "bas" || d === "colonne" || d === "vue" || d === "ilots" ? "ilots" : d;

const KEY = "copiteur.design";
const isMac = navigator.userAgent.includes("Macintosh");

const isLayout = (v: unknown): v is Layout =>
  typeof v === "string" && (LAYOUTS as string[]).includes(v);

// Premier lancement (ou ancien choix qui n'est plus propose) : B1.
let current: Layout = (() => {
  try {
    const v = localStorage.getItem(KEY);
    return isLayout(v) ? v : "bas";
  } catch {
    return "bas";
  }
})();
const listeners = new Set<() => void>();

export const getDesign = () => current;

export function setDesign(d: Layout) {
  if (d === current) return;
  current = d;
  try {
    localStorage.setItem(KEY, d);
  } catch {
    // stockage indisponible : le choix vaut pour la session
  }
  listeners.forEach((f) => f());
}

export function useDesign(): Layout {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
}

// Nom affiche (menus) : la variante C ne s'appelle pas pareil selon l'OS.
export function designName(d: Layout): string {
  if (d === "classique")
    return t(isMac ? "design.name.classiqueMac" : "design.name.classiqueWin");
  return t(`design.name.${d}` as Key);
}
export const designHint = (d: Layout): string => t(`design.hint.${d}` as Key);

// macOS : le menu natif « Design (bêta) » (cf. lib.rs) annonce le choix.
listen<string>("copiteur://design", (e) => {
  if (isLayout(e.payload)) setDesign(e.payload);
}).catch(() => {});
