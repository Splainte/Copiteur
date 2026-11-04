// ============================================================
//  Copiteur — pont avec la barre d'outils NATIVE de macOS
//
//  Sur macOS, la barre du haut n'est pas dessinee en HTML : c'est une vraie
//  NSToolbar (capsules Liquid Glass, symboles SF, bouton Transferts qui
//  s'etire en pilule de progression), construite cote
//  Rust (chrome_mac.rs) a partir d'une description envoyee d'ici. Le front
//  recoit les clics par l'evenement `chrome://toolbar`. Le choix du serveur,
//  lui, n'est plus dans la barre : chaque panneau a son selecteur de source
//  (cf. SourcePicker.tsx).
//
//  Hors macOS, tout ceci est inerte (Windows a sa barre de titre HTML, cf.
//  WindowChrome.tsx).
// ============================================================
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { t } from "./i18n";
import type { XferSummary } from "./TransfersPanel";

const isMac = navigator.userAgent.includes("Macintosh");

// ---- Description de la barre (miroir des structures serde de chrome.rs) -------
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
type TbItem =
  | { kind: "title"; id: string; text: string; sub: string }
  | { kind: "flex" }
  | { kind: "space" }
  | { kind: "button"; id: string; symbol: string; label: string }
  | { kind: "menu"; id: string; symbol: string; title: string; tip: string; entries: MenuEntry[]; hidden: boolean }
  | {
      kind: "morph";
      id: string;
      symbol: string;
      label: string;
      text: string;
      value: number;
      expanded: boolean;
      retry: boolean;
      // Capsule accrochee a gauche de la pilule (telephone branche) : elle
      // glisse avec elle quand la pilule s'etire.
      side: { id: string; symbol: string; title: string; tip: string; entries: MenuEntry[]; hidden: boolean };
    };
type ToolbarSpec = { items: TbItem[] };

type Handlers = {
  // Choix dans le menu du bouton telephone (« left:<id> » / « right:<id> »).
  phone: (entry: string) => void;
  toggleTransfers: () => void;
  journal: () => void;
  settings: () => void;
};

type Opts = {
  appVersion: string;
  // Bouton allonge « telephone branche » : menu Ouvrir a gauche / a droite.
  // Absent (masque) quand aucun telephone n'attend d'etre ouvert.
  phone: { title: string; tip: string; entries: MenuEntry[] } | null;
  // Zone des transferts cachee pendant une copie : le bouton s'etire.
  showProgress: boolean;
  summary: XferSummary;
  handlers: Handlers;
};

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
        // Telephone branche pas encore ouvert : capsule a son nom, collee a
        // GAUCHE du bouton Transferts et qui se decale quand il s'etire en
        // pilule. Menu : Ouvrir a gauche / a droite. Masquee sans telephone.
        side: {
          id: "phone",
          symbol: "smartphone",
          title: o.phone?.title ?? "",
          tip: o.phone?.tip ?? "",
          entries: o.phone?.entries ?? [],
          hidden: !o.phone,
        },
      },
      { kind: "space" },
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
  if (p.kind === "menu" && p.id === "phone" && p.entry) return h.phone(p.entry);
  switch (p.id) {
    case "transfers":
      return h.toggleTransfers();
    case "journal":
      return h.journal();
    case "settings":
      return h.settings();
  }
}
