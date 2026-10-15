// ============================================================
//  Copiteur — journal (cote front)
// ============================================================
//
// Fine couche au-dessus des commandes Rust : elle fabrique l'horodatage lisible
// (cote front, on a l'heure locale sans dependance) et delegue l'ecriture, la
// relecture et la rotation au backend. On ne journalise JAMAIS de secret : les
// messages sont construits ici sans mot de passe (le backend a une seconde
// barriere de redaction, mais elle n'est qu'un filet).

import { invoke } from "@tauri-apps/api/core";

export type Level = "info" | "warn" | "error";
export type Category = "transfert" | "operation" | "connexion" | "app";

export type Entry = {
  time: string;
  level: string;
  category: string;
  message: string;
};

export type JournalInfo = {
  os: string;
  arch: string;
  appVersion: string;
  path: string;
};

// Horodatage local "AAAA-MM-JJ HH:MM:SS" (trie a plat, lisible dans le rapport).
function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

// Ecrit une entree. Volontairement "fire-and-forget" : journaliser ne doit
// jamais bloquer ni faire echouer l'action qu'on est en train de tracer.
export function logEvent(level: Level, category: Category, message: string) {
  invoke("journal_log", {
    entry: { time: stamp(), level, category, message },
  }).catch(() => {});
}

export function readJournal(max = 500): Promise<Entry[]> {
  return invoke<Entry[]>("journal_read", { max }).catch(() => []);
}

export function journalInfo(): Promise<JournalInfo | null> {
  return invoke<JournalInfo>("journal_info").catch(() => null);
}

// Vide le journal (fichier courant + precedent). Reservee au diagnostic : on
// repart sur une trace propre avant de reproduire un probleme.
export function clearJournal(): Promise<void> {
  return invoke<void>("journal_clear").catch(() => {});
}
