// ============================================================
//  Copiteur — volet de navigation (arbre dossiers, lazy-load)
// ============================================================
import { useEffect, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import {
  rc,
  listArgs,
  driveKindFor,
  isNameHidden,
  hiddenAttrNames,
  type Entry,
  type Side,
} from "./files";
import { FileIcon, DriveIcon, UiIcon } from "./icons";

export type TreeNode = {
  label: string;
  path: string;
  icon: "drive" | "folder";
  driveType?: string;
  // Chemin UNC (lecteur reseau) : cle de renommage. Vide/absent sinon.
  unc?: string;
  // Deplie ce noeud des le montage (racine « Serveur » a la connexion).
  defaultOpen?: boolean;
};
export type TreeSection = {
  title?: string;
  nodes: TreeNode[];
  reorderable?: boolean; // accès rapide : reordonnable par glisser-deposer
};

// Chemin de l'element d'acces rapide en cours de glisser (reordonnancement).
let pinDragFrom: string | null = null;

// Un noeud de l'arbre : ligne cliquable + chevron d'expansion + enfants (dossiers).
function Node({
  side,
  node,
  level,
  current,
  showHidden,
  onNavigate,
  onNodeContext,
  reorder,
}: {
  side: Side;
  node: TreeNode;
  level: number;
  current: string;
  showHidden: boolean;
  onNavigate: (path: string) => void;
  onNodeContext: (e: ReactMouseEvent, node: TreeNode) => void;
  reorder?: (from: string, to: string, after: boolean) => void;
}) {
  // Position d'insertion pendant un glisser : avant ou apres cette ligne.
  const [dropPos, setDropPos] = useState<"before" | "after" | null>(null);
  // Ouvert d'office si demande (l'effet [showHidden] charge alors les enfants
  // des le montage — il tourne au montage et prend la branche « ouvert »).
  const [open, setOpen] = useState(!!node.defaultOpen);
  const [children, setChildren] = useState<Entry[] | null>(null);
  const [loading, setLoading] = useState(false);

  // Liste les sous-dossiers du noeud, en appliquant le reglage « cachés ».
  const fetchChildren = async (): Promise<Entry[]> => {
    const res = await rc<{ list: Entry[] }>(
      "operations/list",
      listArgs(side, node.path),
    );
    let dirs = (res.list ?? []).filter((e) => e.IsDir);
    if (!showHidden) {
      dirs = dirs.filter((e) => !isNameHidden(side, e.Name));
      // Windows : l'attribut « caché » n'est pas dans le nom.
      const attr = await hiddenAttrNames(side, node.path, dirs);
      if (attr.size) dirs = dirs.filter((e) => !attr.has(e.Name));
    }
    return dirs.sort((a, b) =>
      a.Name.localeCompare(b.Name, "fr", { sensitivity: "base" }),
    );
  };

  const loadChildren = async () => {
    if (children) return;
    setLoading(true);
    try {
      setChildren(await fetchChildren());
    } catch {
      setChildren([]);
    } finally {
      setLoading(false);
    }
  };

  // Le reglage a change. Il ne suffit PAS d'oublier les enfants : un noeud
  // deja OUVERT n'a alors plus rien a afficher, et rien ne le rechargerait
  // (loadChildren n'est appele qu'a l'ouverture) — il fallait le replier puis
  // le rouvrir a la main. On recharge donc tout de suite s'il est ouvert.
  useEffect(() => {
    if (!open) {
      setChildren(null); // sera recharge a la prochaine ouverture
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetchChildren()
      .then((d) => !cancelled && setChildren(d))
      .catch(() => !cancelled && setChildren([]))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showHidden]);

  const toggle = async (e: ReactMouseEvent) => {
    e.stopPropagation();
    if (!open) await loadChildren();
    setOpen((o) => !o);
  };

  const isCurrent = current.replace(/\/+$/, "") === node.path.replace(/\/+$/, "");
  // Chevron : inconnu tant que pas charge (on l'affiche), masque si feuille.
  const hasChevron = children === null || children.length > 0;

  return (
    <div className="tree-node">
      <div
        className={
          "tree-row" +
          (isCurrent ? " is-current" : "") +
          (dropPos ? " drop-" + dropPos : "")
        }
        style={{ paddingLeft: 4 + level * 14 }}
        onClick={() => onNavigate(node.path)}
        onContextMenu={(e) => onNodeContext(e, node)}
        draggable={!!reorder}
        onDragStart={
          reorder
            ? (e) => {
                e.stopPropagation();
                pinDragFrom = node.path;
              }
            : undefined
        }
        onDragOver={
          reorder
            ? (e) => {
                if (pinDragFrom && pinDragFrom !== node.path) {
                  e.preventDefault();
                  // Moitie haute => avant, moitie basse => apres.
                  const r = e.currentTarget.getBoundingClientRect();
                  setDropPos(
                    e.clientY < r.top + r.height / 2 ? "before" : "after",
                  );
                }
              }
            : undefined
        }
        onDragLeave={reorder ? () => setDropPos(null) : undefined}
        onDrop={
          reorder
            ? (e) => {
                e.preventDefault();
                const after = dropPos === "after";
                setDropPos(null);
                if (pinDragFrom && pinDragFrom !== node.path)
                  reorder(pinDragFrom, node.path, after);
                pinDragFrom = null;
              }
            : undefined
        }
      >
        {/* Le clic sur la LIGNE navigue seulement ; seul le chevron deroule
            (comportement de l'explorateur Windows). */}
        <span
          className={"tree-chevron" + (open ? " open" : "")}
          onClick={toggle}
          style={{ visibility: hasChevron ? "visible" : "hidden" }}
        >
          <UiIcon name="chevron" />
        </span>
        <span className="tree-icon">
          {node.icon === "drive" ? (
            <DriveIcon kind={driveKindFor(node.label, node.driveType ?? "fixed")} />
          ) : (
            <FileIcon kind="folder" />
          )}
        </span>
        <span className="tree-label">{node.label}</span>
        {loading && <span className="tree-loading" />}
      </div>
      {open && children && children.length > 0 && (
        <div className="tree-children">
          {children.map((c) => (
            <Node
              key={c.Path}
              side={side}
              node={{ label: c.Name, path: joinChild(node.path, c.Name), icon: "folder" }}
              level={level + 1}
              current={current}
              showHidden={showHidden}
              onNavigate={onNavigate}
              onNodeContext={onNodeContext}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function joinChild(dir: string, name: string): string {
  const base = dir.endsWith("/") ? dir : dir + "/";
  return base + name;
}

export function NavTree({
  side,
  sections,
  current,
  showHidden,
  onNavigate,
  onNodeContext,
  onReorderPin,
  width,
  status,
}: {
  side: Side;
  sections: TreeSection[];
  current: string;
  showHidden: boolean;
  onNavigate: (path: string) => void;
  onNodeContext: (e: ReactMouseEvent, node: TreeNode) => void;
  onReorderPin: (from: string, to: string, after: boolean) => void;
  width: number;
  // Barre d'etat en pied de volet (« 4 elements | 3 elements selectionnes »).
  status?: { count: string; sel: string } | null;
}) {
  return (
    <nav className="nav-pane" style={{ flex: `0 0 ${width}px` }}>
      <div className="nav-scroll">
      {sections.map((sec, i) => (
        <div className="tree-section" key={i}>
          {sec.title && <div className="tree-section-title">{sec.title}</div>}
          {sec.nodes.map((n) => (
            <Node
              key={n.path}
              side={side}
              node={n}
              level={0}
              current={current}
              showHidden={showHidden}
              onNavigate={onNavigate}
              onNodeContext={onNodeContext}
              reorder={sec.reorderable ? onReorderPin : undefined}
            />
          ))}
        </div>
      ))}
      </div>
      {status && (
        <div className="nav-status">
          <span>{status.count}</span>
          {status.sel && (
            <>
              <span className="nav-status-sep" />
              <span>{status.sel}</span>
            </>
          )}
        </div>
      )}
    </nav>
  );
}
