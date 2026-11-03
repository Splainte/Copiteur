// ============================================================
//  Copiteur — BETA DESIGN : morceaux d'interface partages par les habillages
//  A (Volet), B (Ilots) et C (Classique) :
//   - ConnectSheet    : la feuille « Nouvelle connexion » (A et B n'ont plus
//                       de barre de champs permanente) ;
//   - ServerButton    : bouton serveur + menu deroulant (Windows ; macOS a le
//                       sien en natif dans la barre d'outils) ;
//   - WinTitleBar     : barre de titre Windows 11 (icone, titre, zone libre,
//                       menu Debug de bascule d'interface, boutons fenetre) ;
//   - DebugMenu       : le menu de bascule d'interface (Windows) ;
//   - TransferPill    : la pastille flottante de l'habillage B (Windows, et
//                       apercu navigateur ; macOS la dessine en verre natif).
// ============================================================
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Server } from "./files";
import { t, tn, useLang } from "./i18n";
import {
  LAYOUTS,
  designHint,
  designName,
  setDesign,
  useDesign,
} from "./design";
import { XferRing, type XferSummary } from "./TransfersPanel";
import { Flyout, type MenuEntry } from "./Sidebar";
import appIcon from "./assets/app-icon.png";

const appWindow = getCurrentWindow();

// ---- Feuille « Nouvelle connexion » ------------------------------------------
export function ConnectSheet({
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
            <div className="modal-title">{t("design.conn.title")}</div>
            <div className="sheet-sub">{t("design.conn.subtitle")}</div>
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

// ---- Bouton serveur + menu (Windows) ----------------------------------------
export function serverMenuEntries({
  servers,
  remoteKey,
  connected,
  onPick,
  onNew,
  onDisconnect,
}: {
  servers: Server[];
  remoteKey: string | null;
  connected: boolean;
  onPick: (s: Server) => void;
  onNew: () => void;
  onDisconnect: () => void;
}): MenuEntry[] {
  return [
    ...servers.map((s) => ({
      text: (connected && s.label === remoteKey ? "✓  " : "     ") + s.label,
      action: () => onPick(s),
    })),
    ...(servers.length ? (["sep"] as MenuEntry[]) : []),
    { text: t("design.conn.new"), action: onNew },
    { text: t("design.side.disconnect"), action: onDisconnect, enabled: connected },
  ];
}

export function ServerButton({
  label,
  sub,
  connected,
  connecting,
  entries,
  wide,
}: {
  label: string;
  sub?: string;
  connected: boolean;
  connecting: boolean;
  entries: MenuEntry[];
  wide?: boolean;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={ref}
        className={"server-btn" + (wide ? " is-wide" : "") + (connected ? " is-on" : "")}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={() => {
          const r = ref.current!.getBoundingClientRect();
          setMenu(menu ? null : { x: r.left, y: r.bottom + 4 });
        }}
      >
        <span className={"server-dot" + (connecting ? " is-busy" : connected ? " is-on" : "")} />
        <span className="server-texts">
          <span className="server-label">{label}</span>
          {sub && <span className="server-sub">{sub}</span>}
        </span>
        <svg className="server-caret" viewBox="0 0 16 16" aria-hidden>
          <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {menu && <Flyout x={menu.x} y={menu.y} entries={entries} onClose={() => setMenu(null)} />}
    </>
  );
}

// ---- Menu Debug (Windows) : bascule d'interface --------------------------------
export function DebugMenu() {
  useLang();
  const cur = useDesign();
  const [open, setOpen] = useState(false);
  // Ctrl+Maj+1..4 : bascule directe (par la touche physique, quelle que soit
  // la disposition du clavier ; Ctrl+Alt aurait gene AltGr en AZERTY).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || !e.shiftKey || e.altKey) return;
      const m = /^Digit([1-9])$/.exec(e.code);
      if (!m) return;
      // 1..N : interfaces, puis les rappels de progression.
      const n = Number(m[1]) - 1;
      if (n < LAYOUTS.length) {
        e.preventDefault();
        setDesign(LAYOUTS[n]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className="debug-wrap" onMouseDown={(e) => e.stopPropagation()}>
      <button
        className={"debug-btn" + (open ? " is-open" : "")}
        title={t("design.debugTitle")}
        onClick={() => setOpen((o) => !o)}
      >
        <svg viewBox="0 0 16 16" aria-hidden>
          <path d="M5.5 5.5a2.5 2.5 0 0 1 5 0M4.5 7h7v3.2a3.5 3.5 0 0 1-7 0zM8 7v6.6M2.5 8.5h2M11.5 8.5h2M3 4.8l1.8 1.3M13 4.8l-1.8 1.3M3 13l1.8-1.2M13 13l-1.8-1.2" fill="none" stroke="currentColor" strokeWidth="1.15" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span>{t("design.debug")}</span>
      </button>
      {open && (
        <div className="debug-menu" role="menu">
          <div className="debug-head">{t("design.debugHeader")}</div>
          {LAYOUTS.map((d) => (
            <button
              key={d}
              role="menuitemradio"
              aria-checked={cur === d}
              className={"debug-item" + (cur === d ? " is-on" : "")}
              onClick={() => {
                setOpen(false);
                setDesign(d);
              }}
            >
              <span className="debug-check">{cur === d ? "" : ""}</span>
              <span className="debug-texts">
                <span className="debug-name">
                  {designName(d)}
                  <span className="debug-key">Ctrl+Maj+{LAYOUTS.indexOf(d) + 1}</span>
                </span>
                <span className="debug-hint">{designHint(d)}</span>
              </span>
            </button>
          ))}
          <div className="debug-sep" />
          <div className="debug-head">{t("design.simuHeader")}</div>
          {(["lot", "coupure", "vider"] as const).map((a) => (
            <button
              key={a}
              role="menuitem"
              className="debug-item"
              onClick={() => {
                setOpen(false);
                window.dispatchEvent(new CustomEvent("copiteur-simu", { detail: a }));
              }}
            >
              <span className="debug-check">{a === "lot" ? "\uE768" : a === "coupure" ? "\uE7BA" : "\uE74D"}</span>
              <span className="debug-texts">
                <span className="debug-name">{t(`design.simu.${a}`)}</span>
                <span className="debug-hint">{t(`design.simuHint.${a}`)}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Barre de titre Windows 11 ------------------------------------------------
export function WinTitleBar({
  version,
  center,
  right,
  line,
}: {
  version: string;
  center?: ReactNode;
  right?: ReactNode;
  // Rappel « fil » : barre de progression tout en bas de la barre de titre.
  line?: ReactNode;
}) {
  useLang();
  return (
    <div className="w11-titlebar" data-tauri-drag-region>
      {line}
      <div className="w11-app" data-tauri-drag-region>
        <img className="w11-icon" src={appIcon} alt="" draggable={false} data-tauri-drag-region />
        <span className="w11-name" data-tauri-drag-region>
          Copiteur
        </span>
        <span className="w11-ver" data-tauri-drag-region>
          {version} · {t("design.beta")}
        </span>
      </div>
      <div className="w11-center" data-tauri-drag-region>
        {center}
      </div>
      {/* La zone vide entre les boutons sert aussi a deplacer la fenetre. */}
      <div className="w11-right" data-tauri-drag-region>
        {right}
        <DebugMenu />
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

// ---- Pastille de transferts (habillage B) -------------------------------------
export function TransferPill({
  count,
  pct,
  text,
  open,
  onClick,
}: {
  count: number;
  pct: number | null;
  text: string;
  open: boolean;
  onClick: () => void;
}) {
  useLang();
  return (
    <button className={"xfer-pill" + (open ? " is-open" : "")} onClick={onClick}>
      <span className="pill-ring" style={{ ["--p" as string]: `${pct ?? 0}` }}>
        <svg viewBox="0 0 20 20" aria-hidden>
          <circle cx="10" cy="10" r="8" className="pill-track" />
          {pct !== null && (
            <circle cx="10" cy="10" r="8" className="pill-fill" pathLength={100} strokeDasharray={`${pct} 100`} />
          )}
          <path d="M7 8.2 10 5.2l3 3M10 5.4v5M13 11.8l-3 3-3-3M10 14.6v-5" className="pill-arrows" />
        </svg>
      </span>
      <span className="pill-text">
        <span className="pill-title">{count > 0 ? tn("design.xfer.count", count) : t("design.xfer.button")}</span>
        <span className="pill-sub">{text}</span>
      </span>
      <svg className="pill-caret" viewBox="0 0 16 16" aria-hidden>
        <path d={open ? "M4 6l4 4 4-4" : "M4 10l4-4 4 4"} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

// ---- B3 : bascule « Fichiers / Transferts » (Windows ; macOS l'a en natif) ---
export function ViewSwitch({
  view,
  onView,
  badge,
}: {
  view: "files" | "transfers";
  onView: (v: "files" | "transfers") => void;
  badge: string;
}) {
  useLang();
  return (
    <div className="view-switch" role="tablist" onMouseDown={(e) => e.stopPropagation()}>
      {(["files", "transfers"] as const).map((v) => (
        <button
          key={v}
          role="tab"
          aria-selected={view === v}
          className={"view-switch-btn" + (view === v ? " is-on" : "")}
          onClick={() => onView(v)}
        >
          {t(v === "files" ? "design.view.files" : "design.view.transfers")}
          {v === "transfers" && badge && <span className="view-switch-badge">{badge}</span>}
        </button>
      ))}
    </div>
  );
}

// ---- Rappels de progression (zone des transferts cachee) ---------------------
export function ProgLine({ summary }: { summary: XferSummary }) {
  return (
    <span className={"prog-line" + (summary.state === "retry" ? " is-retry" : "")} aria-hidden>
      <span style={{ width: `${summary.pct ?? 0}%` }} />
    </span>
  );
}

export function ProgPill({
  summary,
  visible,
  onClick,
}: {
  summary: XferSummary;
  visible: boolean;
  onClick: () => void;
}) {
  useLang();
  // Pendant le fondu de sortie (fin du lot, zone reaffichee), on garde les
  // derniers chiffres au lieu d'afficher « aucun transfert ».
  const last = useRef(summary);
  if (visible) last.current = summary;
  const s = last.current;
  return (
    <button
      className={"prog-pill" + (visible ? " is-visible" : "") + (s.state === "retry" ? " is-retry" : "")}
      onClick={onClick}
      onMouseDown={(e) => e.stopPropagation()}
      title={t("design.xfer.show")}
      tabIndex={visible ? 0 : -1}
      aria-hidden={!visible}
    >
      <XferRing pct={s.pct} size={20} state={s.state} />
      <span className="prog-pill-pct">{s.pct ?? 0} %</span>
      <span className="prog-pill-meta">{s.line}</span>
    </button>
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
