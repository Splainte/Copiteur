// ============================================================
//  Copiteur — BETA DESIGN « A · Volet » : volet lateral commun
//
//  Remplace les deux arbres de navigation (un par panneau) par UN volet, facon
//  Finder / Explorateur : serveurs memorises (clic = connexion), emplacements du
//  serveur, favoris et disques de la machine (clic = ouvre le dossier dans le
//  panneau concerne). Sur macOS il est pose sur du vrai Liquid Glass natif
//  (cf. design_mac.rs) : son fond reste donc TRANSPARENT ici.
// ============================================================
import { useEffect, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Menu, MenuItem, PredefinedMenuItem } from "@tauri-apps/api/menu";
import { drag, type Payload, type Server, type Side } from "./files";
import { DriveIcon, FileIcon } from "./icons";
import { t, useLang } from "./i18n";

const isMac = navigator.userAgent.includes("Macintosh");

type LocalRoot = {
  label: string;
  path: string;
  kind: string;
  driveType: string;
  unc: string;
};
type Pin = { label: string; path: string };

// ---- Menu contextuel : natif sur macOS, flyout HTML ailleurs ----------------
export type MenuEntry = { text: string; action: () => void; enabled?: boolean } | "sep";

export async function popupNativeMenu(entries: MenuEntry[]): Promise<boolean> {
  if (!isMac) return false;
  try {
    const items = await Promise.all(
      entries.map((e) =>
        e === "sep"
          ? PredefinedMenuItem.new({ item: "Separator" })
          : MenuItem.new({ text: e.text, enabled: e.enabled ?? true, action: e.action }),
      ),
    );
    const menu = await Menu.new({ items });
    await menu.popup();
    return true;
  } catch {
    return false;
  }
}

export function Flyout({
  x,
  y,
  entries,
  onClose,
}: {
  x: number;
  y: number;
  entries: MenuEntry[];
  onClose: () => void;
}) {
  useEffect(() => {
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  const left = Math.min(x, window.innerWidth - 240);
  const top = Math.min(y, window.innerHeight - entries.length * 34 - 16);
  return (
    <div className="flyout" style={{ left, top }} onMouseDown={(e) => e.stopPropagation()}>
      {entries.map((e, i) =>
        e === "sep" ? (
          <div key={i} className="flyout-sep" />
        ) : (
          <button
            key={i}
            className="flyout-item"
            disabled={e.enabled === false}
            onClick={() => {
              onClose();
              e.action();
            }}
          >
            {e.text}
          </button>
        ),
      )}
    </div>
  );
}

// ---- Icones du volet --------------------------------------------------------
// macOS : pictogrammes au trait teintes de l'accent, comme la barre laterale du
// Finder. Windows : les icones en couleur de l'Explorateur.
type SideIconName =
  | "server"
  | "home"
  | "desktop"
  | "documents"
  | "downloads"
  | "pictures"
  | "music"
  | "videos"
  | "folder"
  | "drive"
  | "external"
  | "network"
  | "root"
  | "start"
  | "plus";

function MacGlyph({ name }: { name: SideIconName }) {
  const p = { fill: "none", stroke: "currentColor", strokeWidth: 1.45, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  let body: ReactNode;
  switch (name) {
    case "server":
      body = (
        <>
          <rect x="2.5" y="3" width="15" height="5.5" rx="1.6" {...p} />
          <rect x="2.5" y="11.5" width="15" height="5.5" rx="1.6" {...p} />
          <circle cx="5.6" cy="5.75" r=".9" fill="currentColor" />
          <circle cx="5.6" cy="14.25" r=".9" fill="currentColor" />
        </>
      );
      break;
    case "home":
      body = <path d="M3 9.2 10 3.5l7 5.7M5 7.8V16.5h3.8v-4.6h2.4v4.6H15V7.8" {...p} />;
      break;
    case "desktop":
      body = (
        <>
          <rect x="2.5" y="3.5" width="15" height="10" rx="1.6" {...p} />
          <path d="M7.5 17h5M10 13.5V17" {...p} />
        </>
      );
      break;
    case "documents":
      body = (
        <>
          <path d="M5 2.8h6.2L15.2 7v10.2H5z" {...p} />
          <path d="M11 2.8V7h4.2M7.5 10.5h5M7.5 13.5h5" {...p} />
        </>
      );
      break;
    case "downloads":
      body = (
        <>
          <circle cx="10" cy="10" r="7.2" {...p} />
          <path d="M10 6v7M7 10.3l3 3 3-3" {...p} />
        </>
      );
      break;
    case "pictures":
      body = (
        <>
          <rect x="2.5" y="4" width="15" height="12" rx="2" {...p} />
          <path d="m3 14 4.2-4.2 3.3 3.3 2.2-2.2L17 15" {...p} />
          <circle cx="13" cy="7.6" r="1.1" {...p} />
        </>
      );
      break;
    case "music":
      body = (
        <>
          <path d="M8 15.5V4.5l8-1.5v11" {...p} />
          <circle cx="6" cy="15.5" r="2" {...p} />
          <circle cx="14" cy="14" r="2" {...p} />
        </>
      );
      break;
    case "videos":
      body = (
        <>
          <rect x="2.5" y="4.5" width="11" height="11" rx="2" {...p} />
          <path d="m13.5 8.3 4-2.3v8l-4-2.3" {...p} />
        </>
      );
      break;
    case "folder":
      body = <path d="M2.8 6V15a1.5 1.5 0 0 0 1.5 1.5h11.4a1.5 1.5 0 0 0 1.5-1.5V7.6a1.5 1.5 0 0 0-1.5-1.5H9.8L8 4.2H4.3A1.5 1.5 0 0 0 2.8 5.7z" {...p} />;
      break;
    case "drive":
      body = (
        <>
          <rect x="2.5" y="6" width="15" height="8" rx="2" {...p} />
          <circle cx="14.2" cy="10" r=".95" fill="currentColor" />
        </>
      );
      break;
    case "external":
      body = (
        <>
          <rect x="2.5" y="6" width="15" height="8" rx="2" {...p} />
          <path d="M5.5 10h4" {...p} />
          <circle cx="14.2" cy="10" r=".95" fill="currentColor" />
        </>
      );
      break;
    case "network":
      body = (
        <>
          <circle cx="10" cy="10" r="7.2" {...p} />
          <path d="M2.8 10h14.4M10 2.8c2.2 2 3.2 4.4 3.2 7.2S12.2 15.2 10 17.2M10 2.8C7.8 4.8 6.8 7.2 6.8 10s1 5.2 3.2 7.2" {...p} />
        </>
      );
      break;
    case "root":
      body = <path d="M3.5 16.5V5.5l6.5-3 6.5 3v11M3.5 9.5h13M3.5 13h13" {...p} />;
      break;
    case "start":
      body = <path d="M5 17V3.5M5 4h9.5l-2 3 2 3H5" {...p} />;
      break;
    case "plus":
      body = <path d="M10 4.5v11M4.5 10h11" {...p} />;
      break;
  }
  return (
    <svg viewBox="0 0 20 20" className="side-glyph" aria-hidden>
      {body}
    </svg>
  );
}

function SideIcon({ name }: { name: SideIconName }) {
  if (isMac) return <MacGlyph name={name} />;
  // Windows : icones en couleur (memes que les panneaux).
  switch (name) {
    case "drive":
      return <span className="side-ficon"><DriveIcon kind="fixed" /></span>;
    case "external":
      return <span className="side-ficon"><DriveIcon kind="removable" /></span>;
    case "network":
      return <span className="side-ficon"><DriveIcon kind="network" /></span>;
    case "server":
    case "root":
      return (
        <span className="side-ficon">
          <svg viewBox="0 0 48 48" className="ficon" aria-hidden>
            <rect x="9" y="7" width="30" height="34" rx="4" fill="#5c6b80" />
            <rect x="12" y="11" width="24" height="7" rx="1.6" fill="#8fa0b6" />
            <rect x="12" y="21" width="24" height="7" rx="1.6" fill="#8fa0b6" />
            <circle cx="16" cy="35" r="1.8" fill="#4ade80" />
            <rect x="21" y="34" width="12" height="2" rx="1" fill="#8fa0b6" />
          </svg>
        </span>
      );
    case "plus":
    case "start":
      return <MacGlyph name={name} />;
    default:
      return <span className="side-ficon"><FileIcon kind="folder" /></span>;
  }
}

// Icone d'un dossier connu (Bureau, Documents…) d'apres la fin de son chemin.
function folderIcon(path: string, homes: Set<string>): SideIconName {
  const p = path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  if (homes.has(p)) return "home";
  if (/\/desktop$/.test(p)) return "desktop";
  if (/\/documents$/.test(p)) return "documents";
  if (/\/downloads$/.test(p)) return "downloads";
  if (/\/pictures$/.test(p)) return "pictures";
  if (/\/music$/.test(p)) return "music";
  if (/\/(videos|movies)$/.test(p)) return "videos";
  return "folder";
}

const same = (a: string, b: string) =>
  a.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() ===
  b.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

// ---- Une ligne du volet -----------------------------------------------------
function Row({
  icon,
  label,
  current,
  current2,
  on,
  dim,
  trailing,
  onClick,
  onContext,
  drop,
  title,
}: {
  icon: SideIconName;
  label: string;
  current?: boolean;
  // Emplacement courant du panneau qui n'a PAS le focus : surlignage leger.
  current2?: boolean;
  // Serveur connecte : pastille verte, pas de surlignage.
  on?: boolean;
  dim?: boolean;
  trailing?: ReactNode;
  onClick: () => void;
  onContext?: (e: ReactMouseEvent) => void;
  // Lacher des fichiers de l'AUTRE panneau sur la ligne = les copier dans ce dossier.
  drop?: { side: Side; path: string; onDrop: (p: Payload, side: Side, dir: string) => void };
  title?: string;
}) {
  const [over, setOver] = useState(false);
  const canDrop = () => !!drop && !!drag.payload && drag.payload.side !== drop.side;
  return (
    <div
      className={
        "side-row" +
        (current ? " is-current" : current2 ? " is-current2" : "") +
        (on ? " is-on" : "") +
        (dim ? " is-dim" : "") +
        (over ? " is-drop" : "")
      }
      onClick={onClick}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onContext?.(e);
      }}
      onDragOver={(e) => {
        if (!canDrop()) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        if (!canDrop() || !drop) return;
        e.preventDefault();
        const p = drag.payload!;
        drag.payload = null;
        drop.onDrop(p, drop.side, drop.path);
      }}
      title={title}
    >
      <span className="side-icon">
        <SideIcon name={icon} />
      </span>
      <span className="side-label">{label}</span>
      {on && <span className="side-on" aria-hidden />}
      {trailing}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="side-section">
      <div className="side-section-title">{title}</div>
      {children}
    </div>
  );
}

export function Sidebar({
  servers,
  remoteKey,
  connected,
  connecting,
  pinsLocal,
  pinsRemote,
  startDir,
  localDir,
  remoteDir,
  activeSide,
  showNetworkDrives,
  onConnect,
  onNew,
  onDisconnect,
  onRename,
  onForget,
  onNavigate,
  onUnpin,
  onDropItems,
}: {
  servers: Server[];
  remoteKey: string | null;
  connected: boolean;
  connecting: boolean;
  pinsLocal: Pin[];
  pinsRemote: Pin[];
  startDir: string;
  localDir: string;
  remoteDir: string;
  activeSide: Side | null;
  showNetworkDrives: boolean;
  onConnect: (s: Server) => void;
  onNew: () => void;
  onDisconnect: () => void;
  onRename: (label: string) => void;
  onForget: (label: string) => void;
  onNavigate: (side: Side, path: string) => void;
  onUnpin: (side: Side, path: string) => void;
  onDropItems: (p: Payload, side: Side, dir: string) => void;
}) {
  useLang();
  const [roots, setRoots] = useState<LocalRoot[]>([]);
  const [flyout, setFlyout] = useState<{ x: number; y: number; entries: MenuEntry[] } | null>(null);
  useEffect(() => {
    invoke<LocalRoot[]>("local_roots")
      .then(setRoots)
      .catch(() => {});
  }, []);

  const menu = async (e: ReactMouseEvent, entries: MenuEntry[]) => {
    const { clientX: x, clientY: y } = e;
    if (!(await popupNativeMenu(entries))) setFlyout({ x, y, entries });
  };

  const homes = new Set(
    roots
      .filter((r) => r.kind === "quick")
      .slice(0, 1)
      .map((r) => r.path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()),
  );
  const drives = roots
    .filter((r) => r.kind === "drive")
    .filter((r) => showNetworkDrives || r.driveType !== "network");
  // Favoris : les dossiers epingles ; a defaut (premier lancement de la beta),
  // les dossiers systeme habituels.
  const favorites: Pin[] = pinsLocal.length
    ? pinsLocal
    : roots.filter((r) => r.kind === "quick").map((r) => ({ label: r.label, path: r.path }));

  // Surligne l'emplacement courant de chaque panneau : franchement pour le
  // panneau actif, legerement pour l'autre.
  const cur = (side: Side, path: string) => {
    const hit = same(side === "local" ? localDir : remoteDir, path);
    return activeSide === side ? { current: hit } : { current2: hit };
  };
  const serverRow = (s: Server) => {
    const isCur = connected && s.label === remoteKey;
    const isBusy = connecting && s.label === remoteKey;
    return (
      <Row
        key={s.label}
        icon="server"
        label={s.label}
        on={isCur}
        title={`${s.user}@${s.host}${s.port && s.port !== "22" ? ":" + s.port : ""}`}
        onClick={() => onConnect(s)}
        onContext={(e) =>
          menu(e, [
            { text: isCur ? t("design.side.disconnect") : t("design.side.connect"), action: () => (isCur ? onDisconnect() : onConnect(s)) },
            "sep",
            { text: t("design.side.rename"), action: () => onRename(s.label) },
            { text: t("design.side.forget"), action: () => onForget(s.label) },
          ])
        }
        trailing={
          isBusy ? (
            <span className="side-spinner" aria-label={t("design.side.connecting")} />
          ) : isCur ? (
            <button
              className="side-eject"
              title={t("design.side.eject", { name: s.label })}
              onClick={(e) => {
                e.stopPropagation();
                onDisconnect();
              }}
            >
              <svg viewBox="0 0 16 16" aria-hidden>
                <path d="M8 3.2 3.6 8.6h8.8zM3.8 11.2h8.4v1.6H3.8z" fill="currentColor" />
              </svg>
            </button>
          ) : null
        }
      />
    );
  };

  return (
    <nav
      className="sidebar"
      aria-label={t("design.side.servers")}
      // macOS : zone de verre natif (cf. macChrome) — rayon d'angle, ancrage.
      {...(isMac ? { "data-glass": "18", "data-glass-id": "sidebar", "data-glass-anchor": "left" } : {})}
    >
      <div className="sidebar-scroll">
        <Section title={t("design.side.servers")}>
          {servers.map(serverRow)}
          <Row icon="plus" label={t("design.side.newServer")} dim onClick={onNew} />
        </Section>

        {connected && (
          <Section title={t("design.side.onServer")}>
            <Row
              icon="root"
              label={t("design.side.root")}
              {...cur("remote", "/")}
              onClick={() => onNavigate("remote", "/")}
              drop={{ side: "remote", path: "/", onDrop: onDropItems }}
            />
            {startDir && (
              <Row
                icon="start"
                label={startDir.replace(/\/+$/, "").split("/").pop() || startDir}
                title={startDir}
                {...cur("remote", startDir)}
                onClick={() => onNavigate("remote", startDir)}
                drop={{ side: "remote", path: startDir, onDrop: onDropItems }}
              />
            )}
            {pinsRemote.map((p) => (
              <Row
                key={p.path}
                icon="folder"
                label={p.label}
                title={p.path}
                {...cur("remote", p.path)}
                onClick={() => onNavigate("remote", p.path)}
                onContext={(e) => menu(e, [{ text: t("design.side.unpin"), action: () => onUnpin("remote", p.path) }])}
                drop={{ side: "remote", path: p.path, onDrop: onDropItems }}
              />
            ))}
          </Section>
        )}

        {favorites.length > 0 && (
          <Section title={t("design.side.favorites")}>
            {favorites.map((p) => (
              <Row
                key={p.path}
                icon={folderIcon(p.path, homes)}
                label={p.label}
                title={p.path}
                {...cur("local", p.path)}
                onClick={() => onNavigate("local", p.path)}
                onContext={
                  pinsLocal.length
                    ? (e) => menu(e, [{ text: t("design.side.unpin"), action: () => onUnpin("local", p.path) }])
                    : undefined
                }
                drop={{ side: "local", path: p.path, onDrop: onDropItems }}
              />
            ))}
          </Section>
        )}

        <Section title={t("design.side.locations")}>
          {drives.map((r) => (
            <Row
              key={r.path}
              icon={r.driveType === "network" ? "network" : r.driveType === "removable" ? "external" : "drive"}
              label={r.label}
              title={r.path}
              {...cur("local", r.path)}
              onClick={() => onNavigate("local", r.path)}
              drop={{ side: "local", path: r.path, onDrop: onDropItems }}
            />
          ))}
        </Section>
      </div>
      {flyout && <Flyout {...flyout} onClose={() => setFlyout(null)} />}
    </nav>
  );
}
