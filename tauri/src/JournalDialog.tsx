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
import { locale, t, tn, useT, type Key } from "./i18n";

type Filter = "all" | "info" | "warn" | "error";

// Les niveaux et categories restent des identifiants (fichier, rapport) : seul
// leur libelle affiche est traduit. Inconnu -> identifiant brut.
const LEVEL_KEY: Record<string, Key> = {
  info: "panels.jrn.level.info",
  warn: "panels.jrn.level.warn",
  error: "panels.jrn.level.error",
};
const CATEGORY_KEY: Record<string, Key> = {
  transfert: "panels.jrn.cat.transfer",
  operation: "panels.jrn.cat.operation",
  connexion: "panels.jrn.cat.connection",
  app: "panels.jrn.cat.app",
};
const label = (keys: Record<string, Key>, id: string) =>
  id in keys ? t(keys[id]) : id;

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
  useT();
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
    const timer = setInterval(refresh, 2000);
    return () => clearInterval(timer);
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
    const now = new Date().toLocaleString(locale());
    const yesNo = (b: boolean) => t(b ? "panels.jrn.yes" : "panels.jrn.no");
    const line = (k: Key, v: string | number) => t(k, { v });
    const lines: string[] = [];
    lines.push(t("panels.jrn.rep.title"));
    lines.push(line("panels.jrn.rep.date", now));
    lines.push(line("panels.jrn.rep.app", info?.appVersion ?? "?"));
    lines.push(line("panels.jrn.rep.rclone", rcloneVersion || "?"));
    lines.push(line("panels.jrn.rep.system", `${info?.os ?? "?"} ${info?.arch ?? ""}`.trim()));
    if (info?.path) lines.push(line("panels.jrn.rep.file", info.path));
    lines.push("");
    lines.push(t("panels.jrn.rep.settings"));
    lines.push(line("panels.jrn.rep.parallel", settings.parallel));
    lines.push(line("panels.jrn.rep.streams", settings.streams));
    lines.push(line("panels.jrn.rep.cutoff", settings.cutoff));
    lines.push(line("panels.jrn.rep.chunkSize", settings.chunkSize));
    lines.push(line("panels.jrn.rep.sftp", settings.sftpConcurrency));
    lines.push(line("panels.jrn.rep.retries", settings.retries));
    lines.push(line("panels.jrn.rep.bwlimit", settings.bwlimit || t("panels.set.unlimited")));
    lines.push(line("panels.jrn.rep.hidden", yesNo(settings.showHidden)));
    lines.push(line("panels.jrn.rep.netDrives", yesNo(settings.showNetworkDrives)));
    lines.push("");
    lines.push(tn("panels.jrn.rep.entries", entries.length));
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
        <div className="modal-title">{t("panels.jrn.title")}</div>

        <div className="journal-toolbar">
          <div className="journal-filters">
            {(["all", "info", "warn", "error"] as Filter[]).map((f) => (
              <button
                key={f}
                className={"journal-fbtn" + (filter === f ? " is-on" : "")}
                onClick={() => setFilter(f)}
              >
                {f === "all" ? t("panels.jrn.all") : label(LEVEL_KEY, f)}
              </button>
            ))}
          </div>
          <div className="journal-tools">
            <button
              className="link-btn"
              onClick={refresh}
              title={t("panels.jrn.reloadTitle")}
            >
              {t("panels.jrn.refresh")}
            </button>
            {confirmClear ? (
              <>
                <button className="link-btn link-danger" onClick={doClear}>
                  {t("panels.jrn.confirmClear")}
                </button>
                <button
                  className="link-btn"
                  onClick={() => setConfirmClear(false)}
                >
                  {t("common.cancel")}
                </button>
              </>
            ) : (
              <button
                className="link-btn link-danger"
                onClick={() => setConfirmClear(true)}
                disabled={entries.length === 0}
                title={t("panels.jrn.clearTitle")}
              >
                {t("panels.jrn.clear")}
              </button>
            )}
          </div>
        </div>

        <div className="journal-list" ref={listRef} onScroll={onListScroll}>
          {shown.length === 0 ? (
            <div className="journal-empty">{t("panels.jrn.empty")}</div>
          ) : (
            shown.map((e, i) => (
              <div className={"journal-row lvl-" + e.level} key={i}>
                <span className="journal-time">{e.time}</span>
                <span className="journal-cat">{label(CATEGORY_KEY, e.category)}</span>
                <span className="journal-msg">{e.message}</span>
              </div>
            ))
          )}
        </div>

        <div className="modal-actions modal-actions-split">
          <button className="link-btn" onClick={onCopy}>
            {copied ? t("panels.jrn.copied") : t("panels.jrn.copy")}
          </button>
          <div className="modal-actions">
            <button className="btn-accent" onClick={onClose}>
              {t("common.close")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
