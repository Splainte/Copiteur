// ============================================================
//  Copiteur — BETA DESIGN : pont avec l'habillage NATIF de macOS
//
//  Sur macOS, les habillages A / B / C ne dessinent PAS leur barre d'outils en
//  HTML : c'est une vraie NSToolbar (capsules Liquid Glass, symboles SF, menus
//  natifs), construite cote Rust (design_mac.rs) a partir d'une description
//  envoyee d'ici. Meme principe pour :
//   - le verre « sous » la webview (volet lateral de A) : le front mesure la
//     zone et Rust y pose un NSGlassEffectView, la page y reste transparente ;
//   - la pastille de transferts de B : un NSGlassEffectView pose AU-DESSUS de
//     la webview (vrai verre qui refracte la liste en dessous).
//  Le front recoit les clics par l'evenement `design://toolbar`.
//
//  Hors macOS (et dans l'apercu navigateur), tout ceci est inerte : l'apercu
//  dessine une imitation de la barre pour juger la mise en page.
// ============================================================
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Server } from "./files";
import { t, tn } from "./i18n";
import type { Layout } from "./design";

const isMac = navigator.userAgent.includes("Macintosh");
// Apercu navigateur (faux backend Tauri, cf. outillage de capture) : pas de
// barre native, on en dessine une imitation.
export const isPreview = !!(window as unknown as { __APERCU_OS?: string }).__APERCU_OS;

// ---- Description de la barre (miroir des structures serde de design_mac.rs) --
export type MenuEntry = {
  id?: string;
  title?: string;
  subtitle?: string;
  symbol?: string;
  checked?: boolean;
  enabled?: boolean;
  separator?: boolean;
  header?: boolean;
};
export type TbItem =
  | { kind: "title"; id: string; text: string; sub: string; fillTo: number }
  | { kind: "flex" }
  | { kind: "space" }
  | { kind: "button"; id: string; symbol: string; label: string; tip: string; prominent: boolean; enabled: boolean; badge: string; selected: boolean }
  | { kind: "menu"; id: string; symbol: string; title: string; tip: string; entries: MenuEntry[] }
  | { kind: "field"; id: string; placeholder: string; value: string; secure: boolean; width: number };
export type ToolbarSpec = { id: string; items: TbItem[]; centered: string[] };
export type Region = { id: string; x: number; y: number; w: number; h: number; radius: number; anchor: string };
export type Pill = { visible: boolean; title: string; sub: string; progress: number; open: boolean; width: number; bottom: number };
export type ChromeSpec = { design: Layout; vibrancy: boolean; toolbar: ToolbarSpec | null };

// Bord droit du volet lateral de A (marge 8 + largeur 252) : le titre de la
// barre s'etend jusque-la pour que la suite commence au ras du volet.
export const SIDEBAR_RIGHT = 260;

type Handlers = {
  pick: (label: string) => void;
  newConnection: () => void;
  disconnect: () => void;
  toggleTransfers: () => void;
  journal: () => void;
  settings: () => void;
  field: (id: string, value: string) => void;
  connect: () => void;
  rename: () => void;
};

type Opts = {
  layout: Layout;
  appVersion: string;
  servers: Server[];
  remoteKey: string | null;
  connected: boolean;
  connecting: boolean;
  fields: { host: string; user: string; pass: string; port: string };
  xferCount: number;
  xferPct: number | null;
  xferSummary: string;
  xferOpen: boolean;
  anyXfer: boolean;
  handlers: Handlers;
};

function serverEntries(o: Opts): MenuEntry[] {
  return [
    { header: true, title: t(o.servers.length ? "design.conn.saved" : "design.conn.none") },
    ...o.servers.map((s) => ({
      id: "pick:" + s.label,
      title: s.label,
      subtitle: `${s.user}@${s.host}${s.port && s.port !== "22" ? ":" + s.port : ""}`,
      symbol: "server.rack",
      checked: o.connected && s.label === o.remoteKey,
    })),
    { separator: true },
    { id: "new", title: t("design.conn.new"), symbol: "plus" },
    { id: "rename", title: t("design.side.rename"), symbol: "pencil", enabled: o.connected },
    { id: "disconnect", title: t("design.side.disconnect"), symbol: "eject", enabled: o.connected },
  ];
}

function serverTitle(o: Opts): string {
  if (o.connecting) return t("design.side.connecting");
  return o.connected && o.remoteKey ? o.remoteKey : t("design.conn.pick");
}

function buildToolbar(o: Opts): ToolbarSpec | null {
  const title = (fill: number): TbItem => ({
    kind: "title",
    id: "title",
    text: "Copiteur",
    sub: o.appVersion ? `${o.appVersion} · ${t("design.beta")}` : t("design.beta"),
    fillTo: fill,
  });
  const button = (id: string, symbol: string, label: string, extra: Partial<Extract<TbItem, { kind: "button" }>> = {}): TbItem => ({
    kind: "button",
    id,
    symbol,
    label,
    tip: label,
    prominent: false,
    enabled: true,
    badge: "",
    selected: false,
    ...extra,
  });
  const server: TbItem = {
    kind: "menu",
    id: "server",
    symbol: "server.rack",
    title: serverTitle(o),
    tip: t("design.conn.saved"),
    entries: serverEntries(o),
  };
  const journal = button("journal", "list.bullet.rectangle", t("app.conn.journal"));
  const settings = button("settings", "gearshape", t("app.conn.settings"));
  switch (o.layout) {
    case "volet":
      return {
        id: "copiteur.volet",
        centered: [],
        items: [
          title(SIDEBAR_RIGHT),
          server,
          { kind: "flex" },
          button("transfers", "arrow.up.arrow.down", t("design.xfer.button"), {
            badge: o.xferCount > 0 ? (o.xferPct !== null ? `${o.xferPct} %` : String(o.xferCount)) : "",
            selected: o.xferOpen,
          }),
          journal,
          settings,
        ],
      };
    case "ilots":
      return {
        id: "copiteur.ilots",
        centered: ["server"],
        items: [title(0), { kind: "flex" }, server, { kind: "flex" }, journal, settings],
      };
    case "classique":
      return {
        id: "copiteur.classique",
        centered: [],
        items: [
          title(0),
          { kind: "flex" },
          { kind: "field", id: "host", placeholder: t("app.conn.host"), value: o.fields.host, secure: false, width: 180 },
          { kind: "field", id: "user", placeholder: t("app.conn.user"), value: o.fields.user, secure: false, width: 120 },
          { kind: "field", id: "pass", placeholder: t("app.conn.password"), value: o.fields.pass, secure: true, width: 120 },
          { kind: "field", id: "port", placeholder: t("app.conn.port"), value: o.fields.port, secure: false, width: 54 },
          button("connect", "bolt.horizontal", o.connecting ? t("app.conn.connecting") : t("app.conn.connect"), { prominent: true }),
          { ...server, title: o.connected && o.remoteKey ? o.remoteKey : t("design.conn.saved") },
          { kind: "space" },
          journal,
          settings,
        ],
      };
    default:
      return null;
  }
}

// ---- Etat partage avec l'imitation de l'apercu ------------------------------
let simSpec: ToolbarSpec | null = null;
let simHandlers: Handlers | null = null;
const simListeners = new Set<() => void>();
function publishSim(spec: ToolbarSpec | null, h: Handlers) {
  simHandlers = h;
  if (JSON.stringify(spec) === JSON.stringify(simSpec)) return;
  simSpec = spec;
  simListeners.forEach((f) => f());
}

// Mesure les zones de verre « sous » la page (`data-glass` = rayon d'angle).
function measureRegions(): Region[] {
  const out: Region[] = [];
  document.querySelectorAll<HTMLElement>("[data-glass]").forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return;
    out.push({
      id: el.dataset.glassId || "glass",
      x: Math.round(r.left),
      y: Math.round(r.top),
      w: Math.round(r.width),
      h: Math.round(r.height),
      radius: Number(el.dataset.glass) || 0,
      anchor: el.dataset.glassAnchor || "left",
    });
  });
  return out;
}

export function useMacChrome(o: Opts): number {
  const [tbH, setTbH] = useState(52);
  const handlersRef = useRef(o.handlers);
  handlersRef.current = o.handlers;
  const native = isMac && !isPreview;
  const toolbar = isMac ? buildToolbar(o) : null;
  // Les commandes natives sont asynchrones et peuvent se doubler : tout envoi
  // (element de barre, verre, pastille) attend que le decor de l'habillage
  // courant soit pose, sinon `design_apply` pourrait effacer derriere lui.
  const ready = useRef<Promise<unknown>>(Promise.resolve());
  const lastRegions = useRef("");

  // 1. Structure : a chaque changement d'habillage, on (re)pose tout le decor
  //    natif — barre d'outils, fond (vibrancy ou non), et on vide le verre.
  useEffect(() => {
    if (!isMac) return;
    const spec: ChromeSpec = {
      design: o.layout,
      vibrancy: o.layout === "actuelle" || o.layout === "classique",
      toolbar: buildToolbar(o),
    };
    if (!native) return;
    lastRegions.current = "";
    ready.current = invoke<number>("design_apply", { spec })
      .then((h) => setTbH(h > 20 ? h : 52))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [o.layout]);

  // 2. Elements dynamiques de la barre (titre du serveur, menu, pastille,
  //    champs) : on ne renvoie que ce qui a change.
  const sent = useRef<Record<string, string>>({});
  const layoutRef = useRef(o.layout);
  if (layoutRef.current !== o.layout) {
    layoutRef.current = o.layout;
    sent.current = {};
  }
  useEffect(() => {
    if (!toolbar) return;
    publishSim(toolbar, o.handlers);
    if (!native) return;
    for (const item of toolbar.items) {
      if (!("id" in item)) continue;
      const key = item.id;
      const json = JSON.stringify(item);
      if (sent.current[key] === undefined) {
        sent.current[key] = json; // pose par design_apply
        continue;
      }
      if (sent.current[key] === json) continue;
      sent.current[key] = json;
      ready.current.then(() => invoke("design_toolbar_item", { item })).catch(() => {});
    }
  });

  // 3. Verre sous la page (volet lateral de A) : mesure au rendu et au resize.
  useEffect(() => {
    if (!native) return;
    let raf = 0;
    const send = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const regions = measureRegions();
        const json = JSON.stringify(regions);
        if (json === lastRegions.current) return;
        lastRegions.current = json;
        ready.current.then(() => invoke("design_glass", { regions })).catch(() => {});
      });
    };
    send();
    const ro = new ResizeObserver(send);
    document.querySelectorAll("[data-glass]").forEach((el) => ro.observe(el));
    ro.observe(document.body);
    window.addEventListener("resize", send);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", send);
    };
  }, [native, o.layout]);

  // 4. Pastille de transferts de B (verre natif au-dessus de la page).
  const pill: Pill = {
    visible: o.layout === "ilots" && o.anyXfer,
    title: o.xferCount > 0 ? tn("design.xfer.count", o.xferCount) : t("design.xfer.button"),
    sub: o.xferSummary,
    progress: o.xferPct ?? -1,
    open: o.xferOpen,
    width: 300,
    bottom: 18,
  };
  const pillJson = JSON.stringify(pill);
  useEffect(() => {
    if (!native) return;
    ready.current.then(() => invoke("design_pill", { pill })).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pillJson, native]);

  // 5. Clics venus de la barre / de la pastille natives.
  useEffect(() => {
    if (!native) return;
    const un = listen<{ id: string; kind: string; entry?: string; value?: string }>("design://toolbar", (e) => {
      dispatch(handlersRef.current, e.payload);
    });
    return () => {
      un.then((f) => f());
    };
  }, [native]);

  if (!isMac || o.layout === "actuelle") return 0;
  return tbH;
}

function dispatch(h: Handlers, p: { id: string; kind: string; entry?: string; value?: string }) {
  if (p.kind === "change" && p.value !== undefined) return h.field(p.id, p.value);
  if (p.kind === "submit") return h.connect();
  if (p.kind === "menu" && p.entry) {
    if (p.entry.startsWith("pick:")) return h.pick(p.entry.slice(5));
    if (p.entry === "new") return h.newConnection();
    if (p.entry === "disconnect") return h.disconnect();
    if (p.entry === "rename") return h.rename();
    return;
  }
  switch (p.id) {
    case "transfers":
    case "pill":
      return h.toggleTransfers();
    case "journal":
      return h.journal();
    case "settings":
      return h.settings();
    case "connect":
      return h.connect();
  }
}

// ---- Imitation de la barre native (apercu navigateur uniquement) -------------
const SIM_ICONS: Record<string, string> = {
  "server.rack": "M3 3.5h14v5H3zM3 11.5h14v5H3z",
  "arrow.up.arrow.down": "M6 3v12M3 12l3 3 3-3M14 17V5M11 8l3-3 3 3",
  "list.bullet.rectangle": "M3 3.5h14v13H3zM6 7.5h8M6 10.5h8M6 13.5h5",
  gearshape: "M10 6.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zM9 2h2l.5 2 1.5.8 2-.7 1.4 1.7-1.4 1.5v1.4l1.4 1.5-1.4 1.7-2-.7-1.5.8L11 18H9l-.5-2-1.5-.8-2 .7-1.4-1.7L5 12.7v-1.4L3.6 9.8 5 8.1l2 .7 1.5-.8z",
  "bolt.horizontal": "M2 10h6l-2-4 9 4H9l2 4z",
};

export function ToolbarSim() {
  const spec = useSyncExternalStore(
    (cb) => {
      simListeners.add(cb);
      return () => simListeners.delete(cb);
    },
    () => simSpec,
  );
  const [menu, setMenu] = useState<string | null>(null);
  if (!spec) return null;
  const h = simHandlers;
  const centered = new Set(spec.centered);
  return (
    <div className="tbsim">
      <span className="tbsim-lights">
        <i />
        <i />
        <i />
      </span>
      {spec.items.map((it, i) => {
        switch (it.kind) {
          case "flex":
            return <span key={i} className="tbsim-flex" />;
          case "space":
            return <span key={i} className="tbsim-space" />;
          case "title":
            return (
              <span key={i} className="tbsim-title" style={it.fillTo ? { width: it.fillTo - 92 } : undefined}>
                <b>{it.text}</b> <span>{it.sub}</span>
              </span>
            );
          case "button":
            return (
              <button
                key={i}
                className={"tbsim-btn" + (it.prominent ? " is-prominent" : "") + (it.selected ? " is-selected" : "")}
                title={it.tip}
                onClick={() => h && dispatch(h, { id: it.id, kind: "click" })}
              >
                {it.prominent ? (
                  it.label
                ) : (
                  <svg viewBox="0 0 20 20">
                    <path d={SIM_ICONS[it.symbol] || ""} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
                {it.badge && <span className="tbsim-badge">{it.badge}</span>}
              </button>
            );
          case "menu":
            return (
              <span key={i} className={"tbsim-menuwrap" + (centered.has(it.id) ? " is-centered" : "")}>
                <button className="tbsim-menu" onClick={() => setMenu(menu === it.id ? null : it.id)}>
                  <svg viewBox="0 0 20 20">
                    <path d={SIM_ICONS[it.symbol] || ""} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  <span>{it.title}</span>
                  <svg viewBox="0 0 16 16" className="tbsim-chev">
                    <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
                {menu === it.id && (
                  <div className="tbsim-dropdown" onMouseLeave={() => setMenu(null)}>
                    {it.entries.map((e, k) =>
                      e.separator ? (
                        <hr key={k} />
                      ) : e.header ? (
                        <div key={k} className="tbsim-head">
                          {e.title}
                        </div>
                      ) : (
                        <button
                          key={k}
                          disabled={e.enabled === false}
                          onClick={() => {
                            setMenu(null);
                            if (h && e.id) dispatch(h, { id: it.id, kind: "menu", entry: e.id });
                          }}
                        >
                          <span className="tbsim-check">{e.checked ? "✓" : ""}</span>
                          <span>
                            {e.title}
                            {e.subtitle && <small>{e.subtitle}</small>}
                          </span>
                        </button>
                      ),
                    )}
                  </div>
                )}
              </span>
            );
          case "field":
            return (
              <input
                key={i}
                className="tbsim-field"
                style={{ width: it.width }}
                type={it.secure ? "password" : "text"}
                placeholder={it.placeholder}
                value={it.value}
                onChange={(e) => h && dispatch(h, { id: it.id, kind: "change", value: e.target.value })}
                onKeyDown={(e) => e.key === "Enter" && h && dispatch(h, { id: it.id, kind: "submit" })}
              />
            );
        }
      })}
    </div>
  );
}
