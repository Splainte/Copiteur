// ============================================================
//  Copiteur — habillage de la fenetre (Windows) et morceaux partages :
//   - ConnectSheet : feuille « Nouvelle connexion » / « Modifier le serveur » ;
//   - WinTitleBar  : barre de titre Windows 11 (icone, titre, zone de
//                    deplacement, outils, boutons de fenetre) ;
//   - MorphButton  : bouton Transferts qui s'etire en pilule de progression.
// ============================================================
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { t, useLang } from "./i18n";
import { XferRing, type XferSummary } from "./TransfersPanel";
import appIcon from "./assets/app-icon.png";

const appWindow = getCurrentWindow();

// ---- Feuille « Nouvelle connexion » ------------------------------------------
export function ConnectSheet({
  mode,
  name,
  host,
  user,
  pass,
  port,
  setName,
  setHost,
  setUser,
  setPass,
  setPort,
  connecting,
  error,
  onConnect,
  onClose,
}: {
  mode: "new" | "edit";
  name: string;
  host: string;
  user: string;
  pass: string;
  port: string;
  setName: (v: string) => void;
  setHost: (v: string) => void;
  setUser: (v: string) => void;
  setPass: (v: string) => void;
  setPort: (v: string) => void;
  connecting: boolean;
  error: string;
  onConnect: () => void;
  onClose: () => void;
}) {
  useLang();
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => {
    first.current?.focus();
  }, []);
  const submit = () => {
    if (host.trim() && user.trim()) onConnect();
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") submit();
    else if (e.key === "Escape") onClose();
  };
  return (
    <div className="modal-backdrop sheet-backdrop" onMouseDown={onClose}>
      <div className="modal sheet-connect" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKey}>
        <div className="sheet-head">
          <span className="sheet-icon" aria-hidden>
            <svg viewBox="0 0 20 20">
              <rect x="2.5" y="3" width="15" height="5.5" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.45" />
              <rect x="2.5" y="11.5" width="15" height="5.5" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.45" />
              <circle cx="5.6" cy="5.75" r=".9" fill="currentColor" />
              <circle cx="5.6" cy="14.25" r=".9" fill="currentColor" />
            </svg>
          </span>
          <div>
            <div className="modal-title">{t(mode === "edit" ? "chrome.conn.editTitle" : "chrome.conn.title")}</div>
            <div className="sheet-sub">{t("chrome.conn.subtitle")}</div>
          </div>
        </div>
        <div className="sheet-grid">
          <label className="sheet-label">{t("app.conn.host")}</label>
          <input ref={first} className="sheet-field" value={host} onChange={(e) => setHost(e.target.value)} spellCheck={false} placeholder="nas.exemple.fr" />
          <label className="sheet-label">{t("app.conn.user")}</label>
          <input className="sheet-field" value={user} onChange={(e) => setUser(e.target.value)} spellCheck={false} />
          <label className="sheet-label">{t("app.conn.password")}</label>
          <input className="sheet-field" type="password" value={pass} onChange={(e) => setPass(e.target.value)} />
          <label className="sheet-label">{t("app.conn.port")}</label>
          <input className="sheet-field sheet-port" value={port} onChange={(e) => setPort(e.target.value)} spellCheck={false} placeholder="22" />
          <label className="sheet-label">{t("app.conn.name")}</label>
          <input className="sheet-field" value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} />
        </div>
        {error && <div className="sheet-error">{error}</div>}
        <div className="modal-actions">
          <button className="btn-ghost" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="btn-accent" disabled={!host.trim() || !user.trim()} onClick={submit}>
            {connecting ? t("app.conn.connecting") : t("app.conn.connect")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- Barre de titre Windows 11 ------------------------------------------------
export function WinTitleBar({ version, right }: { version: string; right: ReactNode }) {
  useLang();
  return (
    <div className="w11-titlebar" data-tauri-drag-region>
      <div className="w11-app" data-tauri-drag-region>
        <img className="w11-icon" src={appIcon} alt="" draggable={false} data-tauri-drag-region />
        <span className="w11-name" data-tauri-drag-region>
          Copiteur
        </span>
        <span className="w11-ver" data-tauri-drag-region>
          {version}
        </span>
      </div>
      {/* La zone vide entre les boutons sert aussi a deplacer la fenetre. */}
      <div className="w11-right" data-tauri-drag-region>
        {right}
        <div className="w11-caption">
          <button onClick={() => appWindow.minimize()} aria-label={t("app.win.minimize")}>
            &#xE921;
          </button>
          <button onClick={() => appWindow.toggleMaximize()} aria-label={t("app.win.maximize")}>
            &#xE922;
          </button>
          <button className="w11-close" onClick={() => appWindow.close()} aria-label={t("app.win.close")}>
            &#xE8BB;
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- Bouton Transferts qui s'etire en pilule de progression (Windows) ---------
// Ancre a droite : il grandit vers la gauche. Le texte se devoile par sa largeur
// maximale animee, l'icone laisse place a un anneau de progression.
export function MorphButton({
  expanded,
  summary,
  on,
  title,
  onClick,
}: {
  expanded: boolean;
  summary: XferSummary;
  on: boolean;
  title: string;
  onClick: () => void;
}) {
  useLang();
  const last = useRef(summary);
  if (expanded) last.current = summary;
  const s = last.current;
  // Largeur exacte du texte : la pilule s'etire jusqu'a elle (et pas jusqu'a
  // un maximum arbitraire, ce qui faisait finir l'animation trop tot).
  const inner = useRef<HTMLSpanElement>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = inner.current;
    if (el) setW(Math.ceil(el.scrollWidth) + 12);
  });
  return (
    <button
      className={"morph-btn" + (expanded ? " is-expanded" : "") + (on ? " is-on" : "") + (s.state === "retry" ? " is-retry" : "")}
      title={title}
      onClick={onClick}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <span className="morph-icon">
        <span className="w11-glyph morph-glyph" aria-hidden>
          &#xE8CB;
        </span>
        <span className="morph-ring">
          <XferRing pct={s.pct} size={22} state={s.state} />
        </span>
      </span>
      <span className="morph-text" style={expanded ? { maxWidth: Math.min(w, 340) } : undefined}>
        <span className="morph-inner" ref={inner}>
          <span className="morph-pct">{s.pct ?? 0} %</span>
          <span className="morph-meta">{s.line}</span>
        </span>
      </span>
    </button>
  );
}
