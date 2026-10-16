// ============================================================
//  Copiteur — mise a jour integree (plugin officiel tauri-plugin-updater)
//
//  Au demarrage (si le reglage est actif) et a la demande, l'app lit le
//  manifeste `latest.json` de la derniere Release GitHub publiee. Chaque
//  installeur y est SIGNE : le plugin verifie la signature avec la cle publique
//  embarquee dans l'app (tauri.conf.json) et refuse une mise a jour qui ne
//  correspond pas — meme si le compte GitHub etait compromis.
//
//  Installer ferme Copiteur : on refuse donc tant que des transferts tournent.
// ============================================================
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { t, useT } from "./i18n";

type Phase =
  | { kind: "hidden" }
  | { kind: "checking" }
  | { kind: "uptodate" }
  | { kind: "available"; update: Update }
  | { kind: "downloading"; update: Update; done: number; total: number }
  | { kind: "installing"; update: Update }
  | { kind: "error"; message: string };

// Messages du plugin (en anglais) -> phrase comprehensible. Le message brut
// reste dans le journal.
function humanUpdateError(raw: string): string {
  const s = raw.toLowerCase();
  if (s.includes("signature"))
    return t("panels.upd.errSignature");
  if (s.includes("valid release json") || s.includes("404"))
    return t("panels.upd.errManifest");
  if (s.includes("network") || s.includes("dns") || s.includes("connect") || s.includes("timed out"))
    return t("panels.upd.errNetwork");
  return raw;
}

type Log = (level: "info" | "warn" | "error", msg: string) => void;

// Le hook expose la fenetre ET un declencheur manuel (bouton des parametres).
export function useUpdater({
  current,
  busy,
  autoCheck,
  log,
}: {
  current: string;
  busy: boolean;
  autoCheck: boolean;
  log: Log;
}) {
  useT();
  const [phase, setPhase] = useState<Phase>({ kind: "hidden" });
  const logRef = useRef(log);
  logRef.current = log;

  // `silent` : verification de demarrage — on ne montre rien si l'app est a
  // jour ou si le reseau manque (seulement une ligne de journal).
  const run = useCallback(async (silent: boolean) => {
    if (!silent) setPhase({ kind: "checking" });
    try {
      const update = await check();
      if (update) {
        logRef.current("info", t("panels.upd.logAvailable", { version: update.version }));
        setPhase({ kind: "available", update });
      } else if (!silent) {
        setPhase({ kind: "uptodate" });
      }
    } catch (e) {
      logRef.current("warn", t("panels.upd.logCheckFailed", { error: String(e) }));
      if (!silent) setPhase({ kind: "error", message: humanUpdateError(String(e)) });
    }
  }, []);

  useEffect(() => {
    if (!autoCheck) return;
    // Laisse l'app finir de demarrer (rclone, lecteurs) avant d'aller sur le reseau.
    const t = setTimeout(() => run(true), 4000);
    return () => clearTimeout(t);
    // Une seule fois par lancement : on ne relance pas si le reglage bouge.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const install = async (update: Update) => {
    let total = 0;
    let done = 0;
    let stopped = false;
    setPhase({ kind: "downloading", update, done: 0, total: 0 });
    try {
      await update.download((ev) => {
        if (ev.event === "Started") total = ev.data.contentLength ?? 0;
        if (ev.event === "Progress") done += ev.data.chunkLength;
        setPhase({ kind: "downloading", update, done, total });
      });
      setPhase({ kind: "installing", update });
      logRef.current("info", t("panels.upd.logInstalling", { version: update.version }));
      // Arrete rclone : l'installeur doit pouvoir remplacer son binaire.
      await invoke("prepare_update");
      stopped = true;
      // Windows : l'installeur prend la main et Copiteur se ferme ici.
      await update.install();
      // macOS : l'app a ete remplacee en place, on relance la nouvelle.
      await relaunch();
    } catch (e) {
      // L'installation a echoue apres l'arret de rclone : on le laisse
      // redemarrer, sinon l'app resterait sans moteur jusqu'a sa fermeture.
      if (stopped) invoke("cancel_update").catch(() => {});
      logRef.current("error", t("panels.upd.logFailed", { error: String(e) }));
      setPhase({ kind: "error", message: humanUpdateError(String(e)) });
    }
  };

  const close = () => setPhase({ kind: "hidden" });
  const open = phase.kind !== "hidden";

  const dialog = open ? (
    <div className="modal-backdrop is-top">
      <div className="modal modal-update">
        {phase.kind === "checking" && (
          <>
            <div className="modal-title">{t("panels.upd.checking")}</div>
            <div className="modal-body">{t("panels.upd.checkingBody")}</div>
          </>
        )}

        {phase.kind === "uptodate" && (
          <>
            <div className="modal-title">{t("panels.upd.upToDate")}</div>
            <div className="modal-body">
              {t("panels.upd.upToDateBody", { version: current })}
            </div>
            <div className="modal-actions">
              <button className="btn-accent" onClick={close}>
                {t("common.ok")}
              </button>
            </div>
          </>
        )}

        {phase.kind === "error" && (
          <>
            <div className="modal-title">{t("panels.upd.errorTitle")}</div>
            <div className="modal-body">
              {phase.message}
              <div className="modal-hint">{t("panels.upd.errorHint")}</div>
            </div>
            <div className="modal-actions">
              <button className="btn-accent" onClick={close}>
                {t("common.close")}
              </button>
            </div>
          </>
        )}

        {phase.kind === "available" && (
          <>
            <div className="modal-title">
              {t("panels.upd.available", { version: phase.update.version })}
            </div>
            <div className="modal-body">
              {t("panels.upd.currentVersion", { version: current })}
              {phase.update.body && (
                <div className="update-notes">{phase.update.body}</div>
              )}
              {busy && (
                <div className="modal-hint is-warn">{t("panels.upd.busy")}</div>
              )}
            </div>
            <div className="modal-actions">
              <button className="btn-ghost" onClick={close}>
                {t("panels.upd.later")}
              </button>
              <button
                className="btn-accent"
                disabled={busy}
                onClick={() => install(phase.update)}
              >
                {t("panels.upd.install")}
              </button>
            </div>
          </>
        )}

        {(phase.kind === "downloading" || phase.kind === "installing") && (
          <>
            <div className="modal-title">
              {t("panels.upd.updatingTo", { version: phase.update.version })}
            </div>
            <div className="modal-body">
              {phase.kind === "installing"
                ? t("panels.upd.installing")
                : t("panels.upd.downloading")}
              <div className="update-bar">
                <div
                  className="update-bar-fill"
                  style={{
                    width:
                      phase.kind === "installing"
                        ? "100%"
                        : phase.total > 0
                          ? `${Math.min(100, (phase.done / phase.total) * 100)}%`
                          : "8%",
                  }}
                />
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  ) : null;

  return { dialog, open, checkNow: () => run(false) };
}
