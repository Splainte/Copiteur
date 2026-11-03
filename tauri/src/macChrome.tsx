// ============================================================
//  Copiteur — pont avec la barre d'outils NATIVE de macOS
//
//  Sur macOS, la barre du haut n'est pas dessinee en HTML : c'est une vraie
//  NSToolbar (capsules Liquid Glass, symboles SF, menu natif des serveurs,
//  bouton Transferts qui s'etire en pilule de progression), construite cote
//  Rust (chrome_mac.rs) a partir d'une description envoyee d'ici. Le front
//  recoit les clics par l'evenement `chrome://toolbar`.
//
//  Hors macOS, tout ceci est inerte (Windows a sa barre de titre HTML, cf.
//  WindowChrome.tsx).
// ============================================================
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Server } from "./files";
import { t } from "./i18n";
import type { XferSummary } from "./TransfersPanel";

const isMac = navigator.userAgent.includes("Macintosh");

// ---- Description de la barre (miroir des structures serde de chrome.rs) -------
type MenuEntry = {
  id?: string;
  title?: string;
  subtitle?: string;
  symbol?: string;
  checked?: boolean;
  enabled?: boolean;
  separator?: boolean;
  header?: boolean;
};
type TbItem =
  | { kind: "title"; id: string; text: string; sub: string }
  | { kind: "flex" }
  | { kind: "space" }
  | { kind: "button"; id: string; symbol: string; label: string }
  | { kind: "menu"; id: string; symbol: string; title: string; tip: string; entries: MenuEntry[] }
  | { kind: "morph"; id: string; symbol: string; label: string; text: string; value: number; expanded: boolean; retry: boolean };
type ToolbarSpec = { items: TbItem[] };

type Handlers = {
  pick: (label: string) => void;
  newConnection: () => void;
  edit: () => void;
  rename: () => void;
  forget: () => void;
  disconnect: () => void;
  toggleTransfers: () => void;
  journal: () => void;
  settings: () => void;
};

type Opts = {
  appVersion: string;
  servers: Server[];
  remoteKey: string | null;
  connected: boolean;
  connecting: boolean;
  // Zone des transferts cachee pendant une copie : le bouton s'etire.
  showProgress: boolean;
  summary: XferSummary;
  handlers: Handlers;
};

function serverEntries(o: Opts): MenuEntry[] {
  // Actions sur le serveur courant : seulement connecte a un serveur memorise.
  const current = o.connected && o.servers.some((s) => s.label === o.remoteKey);
  return [
    { header: true, title: t(o.servers.length ? "chrome.conn.saved" : "chrome.conn.none") },
    ...o.servers.map((s) => ({
      id: "pick:" + s.label,
      title: s.label,
      subtitle: `${s.user}@${s.host}${s.port && s.port !== "22" ? ":" + s.port : ""}`,
      symbol: "server.rack",
      checked: o.connected && s.label === o.remoteKey,
    })),
    { separator: true },
    { id: "new", title: t("chrome.conn.new"), symbol: "plus" },
    { separator: true },
    { id: "edit", title: t("chrome.conn.edit"), symbol: "slider.horizontal.3", enabled: current },
    { id: "rename", title: t("chrome.conn.rename"), symbol: "pencil", enabled: current },
    { id: "forget", title: t("chrome.conn.forget"), symbol: "trash", enabled: current },
    { id: "disconnect", title: t("chrome.conn.disconnect"), symbol: "eject", enabled: o.connected },
  ];
}

function buildToolbar(o: Opts): ToolbarSpec {
  const button = (id: string, symbol: string, label: string): TbItem => ({ kind: "button", id, symbol, label });
  const s = o.summary;
  return {
    items: [
      { kind: "title", id: "title", text: "Copiteur", sub: o.appVersion },
      { kind: "flex" },
      // Bouton Transferts : rond, il s'etire en pilule de progression (vers la
      // gauche) quand la zone est cachee et qu'une copie tourne. Meme texte que
      // sous Windows : « 42 % · 94 Mo/s · reste 16 Go · 2 min ».
      {
        kind: "morph",
        id: "transfers",
        symbol: "arrow.up.arrow.down",
        label: t("chrome.xfer.button"),
        text: o.showProgress ? `${s.pct ?? 0} % · ${s.line}` : "",
        value: s.pct ?? 0,
        expanded: o.showProgress,
        retry: s.state === "retry",
      },
      { kind: "space" },
      {
        kind: "menu",
        id: "server",
        symbol: "server.rack",
        title: o.connecting
          ? t("chrome.conn.connecting")
          : o.connected && o.remoteKey
            ? o.remoteKey
            : t("chrome.conn.pick"),
        tip: t("chrome.conn.saved"),
        entries: serverEntries(o),
      },
      button("journal", "list.bullet.rectangle", t("app.conn.journal")),
      button("settings", "gearshape", t("app.conn.settings")),
    ],
  };
}

// Pose la barre native et la tient a jour. Rend la hauteur a reserver en haut
// de la page (0 hors macOS).
export function useMacChrome(o: Opts): number {
  const [tbH, setTbH] = useState(52);
  const handlersRef = useRef(o.handlers);
  handlersRef.current = o.handlers;
  const toolbar = isMac ? buildToolbar(o) : null;
  // Les commandes natives sont asynchrones : toute mise a jour attend que la
  // barre soit posee, sinon elle viserait un element pas encore cree.
  const ready = useRef<Promise<unknown>>(Promise.resolve());
  // Derniere description envoyee de chaque element : on ne renvoie que ce qui
  // a change.
  const sent = useRef<Record<string, string>>({});

  // 1. Pose de la barre, une fois (les elements partent dans leur etat initial).
  useEffect(() => {
    if (!toolbar) return;
    for (const item of toolbar.items) if ("id" in item) sent.current[item.id] = JSON.stringify(item);
    ready.current = invoke<number>("chrome_apply", { toolbar })
      .then((h) => setTbH(h > 20 ? h : 52))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 2. Elements dynamiques (titre du serveur, menu, bouton-pilule…).
  useEffect(() => {
    if (!toolbar) return;
    for (const item of toolbar.items) {
      if (!("id" in item)) continue;
      const json = JSON.stringify(item);
      if (sent.current[item.id] === json) continue;
      sent.current[item.id] = json;
      ready.current.then(() => invoke("chrome_toolbar_item", { item })).catch(() => {});
    }
  });

  // 3. Clics venus de la barre native.
  useEffect(() => {
    if (!isMac) return;
    const un = listen<{ id: string; kind: string; entry?: string }>("chrome://toolbar", (e) => {
      dispatch(handlersRef.current, e.payload);
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  return isMac ? tbH : 0;
}

function dispatch(h: Handlers, p: { id: string; kind: string; entry?: string }) {
  if (p.kind === "menu" && p.entry) {
    if (p.entry.startsWith("pick:")) return h.pick(p.entry.slice(5));
    switch (p.entry) {
      case "new":
        return h.newConnection();
      case "edit":
        return h.edit();
      case "rename":
        return h.rename();
      case "forget":
        return h.forget();
      case "disconnect":
        return h.disconnect();
    }
    return;
  }
  switch (p.id) {
    case "transfers":
      return h.toggleTransfers();
    case "journal":
      return h.journal();
    case "settings":
      return h.settings();
  }
}
