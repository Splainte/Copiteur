// ============================================================
//  Copiteur — fenetre « Journal »
// ============================================================
//
// Affiche la trace horodatee (transferts, operations, connexions), filtrable par
// niveau, et fabrique un « rapport » copiable : c'est ce que l'utilisateur colle
// dans un message quand « ca marche pas ». Le rapport ne contient AUCUN secret
// (versions, systeme, reglages de transfert — jamais de mot de passe).

import { useEffect, useMemo, useRef, useState } from "react";
import {
  readJournal,
  journalInfo,
  clearJournal,
  type Entry,
  type JournalInfo,
} from "./journal";
import type { Settings } from "./files";

type Filter = "all" | "info" | "warn" | "error";

const LEVEL_LABEL: Record<string, string> = {
  info: "Info",
  warn: "Alerte",
  error: "Erreur",
};

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Repli si l'API clipboard est indisponible (contexte non securise).
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

export function JournalDialog({
  settings,
  rcloneVersion,
  onClose,
}: {
  settings: Settings;
  rcloneVersion: string;
  onClose: () => void;
}) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [info, setInfo] = useState<JournalInfo | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [copied, setCopied] = useState(false);
  // Vidage : premier clic arme la confirmation, second clic vide (evite un
  // effacement accidentel sans ouvrir une modale par-dessus la fenetre).
  const [confirmClear, setConfirmClear] = useState(false);

  const refresh = () => readJournal().then(setEntries);

  const doClear = async () => {
    await clearJournal();
    setConfirmClear(false);
    refresh();
  };

  useEffect(() => {
    refresh();
    journalInfo().then(setInfo);
  }, []);

  // Le journal se relit tout seul : on le consulte typiquement PENDANT un
  // transfert, et devoir cliquer « Rafraîchir » pour voir la suite n'a pas de
  // sens. 2 s suffisent (le fichier est petit et la lecture est locale).
  useEffect(() => {
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, []);

  // Defilement auto vers les dernieres lignes — mais SEULEMENT si on est deja
  // en bas. Sinon on arracherait la vue a quelqu'un en train de relire
  // l'historique a chaque battement.
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const onListScroll = () => {
    const el = listRef.current;
    if (!el) return;
    stickToBottom.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  // Echap ferme la fenetre.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const shown = useMemo(
    () => (filter === "all" ? entries : entries.filter((e) => e.level === filter)),
    [entries, filter],
  );

  useEffect(() => {
    const el = listRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [shown]);

  const buildReport = (): string => {
    const now = new Date().toLocaleString();
    const lines: string[] = [];
    lines.push("=== Rapport Copiteur ===");
    lines.push(`Date : ${now}`);
    lines.push(`Copiteur : ${info?.appVersion ?? "?"}`);
    lines.push(`rclone : ${rcloneVersion || "?"}`);
    lines.push(`Système : ${info?.os ?? "?"} ${info?.arch ?? ""}`.trim());
    if (info?.path) lines.push(`Journal : ${info.path}`);
    lines.push("");
    lines.push("Réglages :");
    lines.push(`  Transferts simultanés : ${settings.parallel}`);
    lines.push(`  Découpe des gros fichiers : ${settings.streams}`);
    lines.push(`  Seuil de découpe : ${settings.cutoff}`);
    lines.push(`  Taille des morceaux : ${settings.chunkSize}`);
    lines.push(`  Connexions SFTP : ${settings.sftpConcurrency}`);
    lines.push(`  Tentatives de reprise : ${settings.retries}`);
    lines.push(`  Limite de débit : ${settings.bwlimit || "illimité"}`);
    lines.push(`  Cachés affichés : ${settings.showHidden ? "oui" : "non"}`);
    lines.push(
      `  Lecteurs réseau affichés : ${settings.showNetworkDrives ? "oui" : "non"}`,
    );
    lines.push("");
    lines.push(`--- Journal (${entries.length} dernières entrées) ---`);
    for (const e of entries) {
      lines.push(`${e.time} [${e.level}] ${e.category} — ${e.message}`);
    }
    return lines.join("\n");
  };

  const onCopy = async () => {
    const ok = await copyToClipboard(buildReport());
    setCopied(ok);
    if (ok) setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal modal-journal"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-title">Journal</div>

        <div className="journal-toolbar">
          <div className="journal-filters">
            {(["all", "info", "warn", "error"] as Filter[]).map((f) => (
              <button
                key={f}
                className={"journal-fbtn" + (filter === f ? " is-on" : "")}
                onClick={() => setFilter(f)}
              >
                {f === "all" ? "Tout" : LEVEL_LABEL[f]}
              </button>
            ))}
          </div>
          <div className="journal-tools">
            <button className="link-btn" onClick={refresh} title="Recharger">
              Rafraîchir
            </button>
            {confirmClear ? (
              <>
                <button className="link-btn link-danger" onClick={doClear}>
                  Confirmer le vidage
                </button>
                <button
                  className="link-btn"
                  onClick={() => setConfirmClear(false)}
                >
                  Annuler
                </button>
              </>
            ) : (
              <button
                className="link-btn link-danger"
                onClick={() => setConfirmClear(true)}
                disabled={entries.length === 0}
                title="Effacer tout le journal"
              >
                Vider
              </button>
            )}
          </div>
        </div>

        <div className="journal-list" ref={listRef} onScroll={onListScroll}>
          {shown.length === 0 ? (
            <div className="journal-empty">Aucune entrée.</div>
          ) : (
            shown.map((e, i) => (
              <div className={"journal-row lvl-" + e.level} key={i}>
                <span className="journal-time">{e.time}</span>
                <span className="journal-cat">{e.category}</span>
                <span className="journal-msg">{e.message}</span>
              </div>
            ))
          )}
        </div>

        <div className="modal-actions modal-actions-split">
          <button className="link-btn" onClick={onCopy}>
            {copied ? "Rapport copié ✓" : "Copier le rapport"}
          </button>
          <div className="modal-actions">
            <button className="btn-accent" onClick={onClose}>
              Fermer
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
