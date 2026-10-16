// ============================================================
//  Copiteur — traduction de l'interface
// ============================================================
//
// Pas de bibliotheque : un dictionnaire par langue (cf. `locales/`), une langue
// courante au niveau du module et quelques fonctions.
//
//   t("app.close.cancel")               texte simple
//   t("pane.renamed", { name })         avec variables : « {name} » dans le texte
//   tn("pane.items", n)                 pluriel : cles `pane.items_one` / `_other`
//   tx("pane.delAsk", { name: <b/> })   variables qui sont des elements React
//
// Les composants appellent `useT()` : il les abonne au changement de langue
// (reglages) et ils se re-rendent dans la nouvelle langue sans redemarrer.
// Les helpers hors composants (files.ts…) utilisent `t` directement : ils sont
// appeles pendant le rendu, donc toujours avec la langue courante.
//
// Ajouter une langue : copier `locales/en/` vers `locales/xx/`, traduire,
// l'ajouter a `DICTS` et a `LANGS`. TypeScript refuse une cle manquante.

import { useSyncExternalStore, type ReactNode, Fragment, createElement } from "react";
import { invoke } from "@tauri-apps/api/core";
import { fr } from "./locales/fr";
import { en } from "./locales/en";

export type Lang = "fr" | "en";
export type Key = keyof typeof fr;
// `tn("pane.items", n)` accepte toute base qui a une forme `_one` (et `_other`).
export type PluralBase = {
  [K in Key]: K extends `${infer B}_one` ? B : never;
}[Key];
type Vars = Record<string, string | number>;

const DICTS: Record<Lang, Record<Key, string>> = { fr, en };

// Nom de chaque langue DANS cette langue (on la reconnait sans la parler).
export const LANGS: { id: Lang; label: string }[] = [
  { id: "fr", label: "Français" },
  { id: "en", label: "English" },
];

const isLang = (v: unknown): v is Lang => v === "fr" || v === "en";

// Langue du systeme, faute de mieux : francais si le systeme l'est, anglais
// sinon (langue « internationale » par defaut).
export function systemLang(): Lang {
  return (navigator.language || "").toLowerCase().startsWith("fr") ? "fr" : "en";
}

let current: Lang = systemLang();
const listeners = new Set<() => void>();

export const getLang = () => current;

// Code de region pour Intl (dates, nombres). En anglais on garde la variante du
// systeme quand il est anglophone (jj/mm au Royaume-Uni, mm/jj aux Etats-Unis).
export function locale(): string {
  if (current === "fr") return "fr-FR";
  const sys = navigator.language || "";
  return sys.toLowerCase().startsWith("en") ? sys : "en-US";
}

let plural = new Intl.PluralRules(locale());
let numFmt = new Intl.NumberFormat(locale());

export function fmtNum(n: number, opts?: Intl.NumberFormatOptions): string {
  return opts ? new Intl.NumberFormat(locale(), opts).format(n) : numFmt.format(n);
}

function fill(s: string, vars?: Vars): string {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

export function t(key: Key, vars?: Vars): string {
  return fill(DICTS[current][key] ?? fr[key] ?? key, vars);
}

// Pluriel selon les regles de la langue (francais : 0 et 1 au singulier ;
// anglais : 1 seulement). `{n}` est rempli avec le nombre formate.
export function tn(base: PluralBase, n: number, vars?: Vars): string {
  const form = plural.select(n) === "one" ? "one" : "other";
  return t(`${base}_${form}` as Key, { n: fmtNum(n), ...vars });
}

// Comme `t`, mais les variables peuvent etre des elements React (gras, lien…).
export function tx(key: Key, nodes: Record<string, ReactNode>): ReactNode {
  const parts = (DICTS[current][key] ?? fr[key] ?? key).split(/\{(\w+)\}/);
  return createElement(
    Fragment,
    null,
    ...parts.map((p, i) =>
      i % 2 === 1 ? createElement(Fragment, { key: i }, p in nodes ? nodes[p] : `{${p}}`) : p,
    ),
  );
}

export function setLang(lang: Lang): Promise<void> {
  current = lang;
  plural = new Intl.PluralRules(locale());
  numFmt = new Intl.NumberFormat(locale());
  document.documentElement.lang = lang;
  lsSet(LS_LANG, lang);
  // Cote Rust : menus macOS, noms des lecteurs, messages d'erreur.
  // Les abonnes ne sont prevenus qu'APRES l'accuse du backend : s'ils
  // redemandent aussitot des noms de lecteurs, ceux-ci sont deja traduits.
  return invoke<void>("set_language", { lang })
    .catch(() => {})
    .then(() => listeners.forEach((f) => f()));
}

function subscribe(f: () => void) {
  listeners.add(f);
  return () => listeners.delete(f);
}

// Langue courante, en abonnant le composant a ses changements.
export function useLang(): Lang {
  return useSyncExternalStore(subscribe, getLang);
}

// A appeler dans tout composant qui affiche du texte : re-rend le composant
// quand la langue change. Renvoie `t` pour l'ecriture `const t = useT()`.
export function useT() {
  useLang();
  return t;
}

// ------------------------------------------------------------
//  Langue au demarrage
// ------------------------------------------------------------

const LS_LANG = "copiteur.lang";
// Derniere langue choisie dans l'installeur Windows qu'on a prise en compte.
const LS_SEEN = "copiteur.lang.installer";
// Pose au 1er lancement tant que la langue n'a pas ete choisie.
const LS_PENDING = "copiteur.lang.pending";

let pickNeeded = false;
// Vrai au tout premier lancement quand rien n'a encore fixe la langue (macOS :
// pas d'installeur) : l'app propose alors de la choisir.
export const languagePickNeeded = () => pickNeeded;
export const languagePicked = () => {
  pickNeeded = false;
  lsSet(LS_PENDING, null);
};

// Le stockage peut etre indisponible : la langue tiendra alors le temps de la
// session, sans erreur.
function lsGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function lsSet(k: string, v: string | null) {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    /* idem */
  }
}

// Avant le premier rendu. Ordre de priorite :
//   1. la langue choisie dans l'installeur Windows, si elle a CHANGE depuis la
//      derniere fois (reinstallation dans une autre langue) ;
//   2. celle enregistree dans les reglages ;
//   3. un utilisateur d'avant la traduction (des reglages existent deja) :
//      francais, sans rien lui demander ;
//   4. sinon (1er lancement sans installeur) : langue du systeme, et l'app
//      propose de la changer.
export async function initLang() {
  const installer = await invoke<string | null>("installer_language").catch(() => null);
  const saved = lsGet(LS_LANG);
  const seen = lsGet(LS_SEEN);
  // Le 1er lancement ecrit deja des reglages (favoris amorces…) : sans ce
  // marqueur, quitter sans avoir repondu ferait passer pour un ancien.
  const pending = lsGet(LS_PENDING) !== null;
  const veteran =
    !pending && (lsGet("copiteur.settings") !== null || lsGet("copiteur.pins.seeded") !== null);

  let lang: Lang;
  if (isLang(installer) && installer !== seen && !(saved === null && veteran)) {
    lang = installer;
  } else if (isLang(saved)) {
    lang = saved;
  } else if (veteran) {
    lang = "fr";
  } else {
    lang = systemLang();
    pickNeeded = true;
  }
  if (isLang(installer)) lsSet(LS_SEEN, installer);
  await setLang(lang);
  // Le choix au 1er lancement n'est pas encore « enregistre » : si l'app est
  // quittee sans repondre, on reposera la question.
  if (pickNeeded) {
    lsSet(LS_LANG, null);
    lsSet(LS_PENDING, "1");
  } else {
    lsSet(LS_PENDING, null);
  }
}
