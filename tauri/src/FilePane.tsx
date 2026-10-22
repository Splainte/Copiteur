// ============================================================
//  Copiteur — un explorateur de fichiers complet (reutilise local + distant)
//  En-tete (navigation + adresse + bascule de vue), arbre, vue liste triable
//  ou vue tuiles, selection facon Windows, glisser-deposer, menu contextuel.
// ============================================================
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  rc,
  listArgs,
  entryPath,
  fileAddr,
  dirFs,
  parentDir,
  joinDir,
  normalizeTypedPath,
  humanSize,
  humanDate,
  typeLabel,
  iconKind,
  sortEntries,
  breadcrumb,
  matchesSearch,
  freeName,
  nameError,
  isNameHidden,
  hiddenAttrNames,
  drag,
  type Entry,
  type Side,
  type PaneBus,
  type Payload,
  type SortKey,
} from "./files";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { FileIcon, UiIcon } from "./icons";
import { NavTree, type TreeSection } from "./NavTree";
import { logEvent } from "./journal";
import { parsePastedPath, resolvePastedPath, type PathHit } from "./chemins";
import { t, tn, tx, useLang, type Key } from "./i18n";

// Libelle du cote pour le journal (« Ton PC » / « Serveur »).
const sideLabel = (s: Side) => (s === "local" ? t("common.yourPc") : t("common.server"));

const isWin = navigator.userAgent.includes("Windows");
const isMac = navigator.userAgent.includes("Macintosh");

type LocalRoot = {
  label: string;
  path: string;
  kind: string; // "quick" | "drive"
  driveType: string; // "" | "fixed" | "network" | ...
  unc: string; // \\serveur\partage pour un lecteur reseau, "" sinon
};
type View = "list" | "tiles";

// Largeurs de colonnes par defaut (px), toutes redimensionnables (comme Windows).
const DEFAULT_COLS = { name: 300, date: 132, type: 140, size: 96 };
type ColW = typeof DEFAULT_COLS;

// `label` = cle de traduction (le texte est resolu au rendu, dans la langue courante).
const COLS: { key: SortKey; label: Key; className: string }[] = [
  { key: "name", label: "pane.col.name", className: "c-name" },
  { key: "date", label: "pane.col.date", className: "c-date" },
  { key: "type", label: "pane.col.type", className: "c-type" },
  { key: "size", label: "pane.col.size", className: "c-size" },
];

export function FilePane({
  title,
  side,
  enabled,
  anyModal,
  active,
  onFocus,
  bus,
  onDropItems,
  onCopy,
  onPaste,
  hasClipboard,
  busyRef,
  showHidden,
  showNetworkDrives,
  pins,
  onPin,
  onUnpin,
  onReorderPin,
  onOpenRemote,
  connKey,
  startAt,
  startDir,
  onSetStartDir,
}: {
  title: string;
  side: Side;
  enabled: boolean;
  // Une modale d'App (parametres, conflit, confirmation…) est ouverte : on gele
  // le clavier du panneau tant qu'elle est la (cf. onKeyDown).
  anyModal?: boolean;
  active: boolean;
  onFocus: () => void;
  bus: PaneBus;
  onDropItems: (payload: Payload, destSide: Side, intoDir?: string) => void;
  onCopy: (side: Side) => void;
  onPaste: (side: Side) => void;
  hasClipboard: boolean;
  busyRef: RefObject<boolean>;
  showHidden: boolean;
  showNetworkDrives: boolean;
  pins: { label: string; path: string }[];
  onPin: (path: string, label: string) => void;
  onUnpin: (path: string) => void;
  onReorderPin: (from: string, to: string, after: boolean) => void;
  // Ouvrir un fichier distant : telechargement d'une copie temporaire, ouverture
  // avec l'appli OS, et surveillance pour proposer le renvoi si modifie (cf. App).
  // Cote local, l'ouverture est directe et n'a pas besoin de ce rappel.
  onOpenRemote?: (
    dir: string,
    name: string,
    size: number,
    modTime: string,
  ) => void;
  // Jeton de connexion distante : change a chaque (re)connexion pour forcer le
  // panneau distant a relister depuis la racine du nouveau serveur. Absent (0)
  // cote local.
  connKey?: number;
  // Dossier d'ouverture resolu a la connexion (cf. App/resolveRemoteStart). Cote
  // serveur uniquement ; a defaut on ouvre "/".
  startAt?: string;
  // Dossier de depart memorise du serveur courant ("" = aucun), pour le toggle
  // « Demarrer ici » / « Ne plus demarrer ici » du menu clic droit.
  startDir?: string;
  onSetStartDir?: (path: string) => void;
}) {
  const isLocal = side === "local";
  // Abonne le panneau au changement de langue (re-rendu dans la nouvelle langue).
  const lang = useLang();
  const rootPath = isLocal ? "/" : "/";

  // Historique de navigation (precedent / suivant), facon explorateur.
  const [hist, setHist] = useState<{ stack: string[]; idx: number }>({
    stack: [rootPath],
    idx: 0,
  });
  const dir = hist.stack[hist.idx];

  const [entries, setEntries] = useState<Entry[]>([]);
  // Dossier auquel appartient REELLEMENT la liste `entries` affichee. Distinct de
  // `dir` (la cible de navigation) : quand on clique un fil d'Ariane, `dir` change
  // tout de suite mais la liste garde l'ancien contenu tant que le `load` (lent en
  // SFTP) n'a pas repondu. Toute action sur un element VISIBLE (ouvrir, renommer,
  // supprimer, glisser…) doit viser ce dossier-la, pas `dir` — sinon on construit
  // un chemin sous le mauvais parent (« directory not found »).
  const [entriesDir, setEntriesDir] = useState(rootPath);
  // Miroir en ref : `load` est un useCallback stable (deps [enabled, side]),
  // il ne peut pas lire l'etat `entriesDir` sans se recreer a chaque listage.
  const entriesDirRef = useRef(entriesDir);
  entriesDirRef.current = entriesDir;
  // Jeton de chargement : seul le `load` le PLUS RECENT applique son resultat. Sans
  // ca, un listage lent d'un ancien dossier, resolu apres coup, ecraserait la liste
  // d'une navigation plus recente.
  const loadSeq = useRef(0);
  // Noms portant l'attribut « caché » de Windows (vide ailleurs : le point suffit).
  const [hiddenAttr, setHiddenAttr] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // `anchor` = point fixe des selections a la plage (Shift). `lead` = element
  // « actif » qui se deplace aux fleches (le curseur, facon explorateur).
  const [anchor, setAnchor] = useState<number | null>(null);
  const [lead, setLead] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [dropHover, setDropHover] = useState(false);
  const [addr, setAddr] = useState(rootPath);
  const [editingAddr, setEditingAddr] = useState(false);

  // Recherche dans le dossier courant (filtrage client, permissif facon
  // Feedback). `searchOpen` pilote le deploiement anime de la barre ; `search`
  // est la requete. La barre POUSSE la barre d'adresse vers la gauche : c'est le
  // fil d'Ariane (deja adaptatif via ResizeObserver) qui replie ses parents.
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  const [view, setView] = useState<View>(
    () => (localStorage.getItem(`copiteur.view.${side}`) as View) || "list",
  );
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<1 | -1>(1);

  const [roots, setRoots] = useState<LocalRoot[]>([]);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    target: Entry | null;
    nav?: { path: string; label: string; driveType?: string; unc?: string };
  } | null>(null);
  // Element sous le curseur au clic droit (rempli par la ligne avant le panneau).
  const ctxTarget = { current: null as Entry | null };
  // Position REELLE du menu apres recadrage pour rester dans la fenetre (le clic
  // en bas / a droite deborderait sinon hors de l'app). Null = pas encore mesure.
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(
    null,
  );
  // Le panneau lui-meme, pour lui RENDRE le focus a la fermeture d'une modale.
  // Sans ca, cliquer « Non » laissait le focus sur un bouton qui disparait -> il
  // retombait sur le <body>, et les raccourcis clavier (Suppr, Ctrl+Backspace)
  // ne repondaient plus tant qu'on n'avait pas reclique dans le panneau.
  const sectionRef = useRef<HTMLElement>(null);

  // Suppression (avec confirmation).
  const [del, setDel] = useState<Entry[] | null>(null);
  // Poids / nombre de fichiers de ce qu'on s'apprete a supprimer.
  const [delInfo, setDelInfo] = useState<{
    bytes: number;
    count: number;
    computing: boolean;
    partial: boolean; // au moins un dossier n'a pas pu etre mesure
  } | null>(null);

  // Renommage sur place (facon explorateur : la ligne devient un champ).
  const [renaming, setRenaming] = useState<{ path: string; value: string } | null>(
    null,
  );
  // Echap doit ANNULER : sans ce drapeau, le `blur` provoque par la disparition
  // du champ validerait quand meme l'ancienne valeur.
  const skipBlur = useRef(false);
  // Erreur d'une operation (creation, renommage, deplacement) : distincte de
  // `error` (echec de listage), que `load` remet a zero a chaque chargement.
  const [opErr, setOpErr] = useState("");
  // Chemin colle (Finder / explorateur) : recherche en cours, emplacements
  // possibles quand il y en a plusieurs, et fichier a selectionner une fois
  // son dossier ouvert.
  const [resolving, setResolving] = useState(false);
  const [pathChoices, setPathChoices] = useState<PathHit[] | null>(null);
  const selectAfterLoad = useRef<PathHit | null>(null);
  // Dossier survole pendant un glisser interne (cible d'un deplacement).
  const [dropRow, setDropRow] = useState<string | null>(null);
  // Taille d'un dossier, calculee a l'ouverture du menu contextuel.
  // bytes < 0 : -1 = calcul en cours, -2 = echec.
  const [sizeInfo, setSizeInfo] = useState<{
    path: string;
    bytes: number;
    count: number;
  } | null>(null);
  // Selection au lasso (rubber-band) dans le volet fichiers.
  const [band, setBand] = useState<
    { x0: number; y0: number; x1: number; y1: number } | null
  >(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bandBase = useRef<Set<string>>(new Set());
  const suppressClick = useRef(false);

  // Fil d'Ariane : segments, nombre replie dans le menu « … », etat du menu.
  const crumbsRef = useRef<HTMLDivElement>(null);
  const crumbsMirrorRef = useRef<HTMLDivElement>(null);
  const [hiddenCrumbs, setHiddenCrumbs] = useState(0);
  const [crumbMenu, setCrumbMenu] = useState(false);
  const crumbs = useMemo(() => breadcrumb(side, dir), [side, dir]);

  // Largeur du volet de navigation (redimensionnable, memorisee).
  const [navW, setNavW] = useState<number>(
    () => Number(localStorage.getItem(`copiteur.nav.${side}`)) || 200,
  );
  // Largeurs de colonnes (redimensionnables, memorisees).
  const [colW, setColW] = useState<ColW>(() => {
    try {
      return { ...DEFAULT_COLS, ...JSON.parse(localStorage.getItem(`copiteur.cols.${side}`) || "{}") };
    } catch {
      return DEFAULT_COLS;
    }
  });

  // Glisser une bordure (nav pane ou colonne) : suit la souris jusqu'au relacher.
  const startResize = (
    onMove: (dx: number) => void,
    onEnd?: () => void,
  ) => (e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    const move = (ev: MouseEvent) => onMove(ev.clientX - x0);
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
      onEnd?.();
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    document.body.style.cursor = "col-resize";
  };

  const resizeNav = (start: number) =>
    startResize(
      (dx) => setNavW(Math.max(150, Math.min(440, start + dx))),
      () => {},
    );
  const resizeCol = (key: keyof ColW, start: number) =>
    startResize((dx) =>
      setColW((c) => ({ ...c, [key]: Math.max(70, start + dx) })),
    );

  useEffect(() => {
    localStorage.setItem(`copiteur.nav.${side}`, String(navW));
  }, [navW, side]);
  useEffect(() => {
    localStorage.setItem(`copiteur.cols.${side}`, JSON.stringify(colW));
  }, [colW, side]);

  // Fil d'Ariane trop long : on replie les parents LOINTAINS dans un menu « … »
  // (facon explorateur Windows) en gardant visibles le dossier courant et ses
  // parents proches.
  //
  // Les largeurs sont prises sur un conteneur MIROIR cache qui contient
  // TOUJOURS tous les segments (+ un bouton « … » temoin). Mesurer le fil
  // reellement affiche serait faux : il est deja replie, donc on ne verrait
  // qu'une partie des segments, et le calcul se ferait sur un DOM en retard
  // d'un render. Le miroir rend la mesure deterministe et en une seule passe.
  const recomputeCrumbs = useCallback(() => {
    const el = crumbsRef.current;
    const mirror = crumbsMirrorRef.current;
    if (!el || !mirror) return;

    const seg = Array.from(mirror.querySelectorAll<HTMLElement>("[data-seg]"));
    const moreEl = mirror.querySelector<HTMLElement>("[data-more]");
    if (!seg.length || !moreEl) return;

    const st = getComputedStyle(el);
    const avail =
      el.clientWidth -
      parseFloat(st.paddingLeft) -
      parseFloat(st.paddingRight);

    const w = seg.map((s) => s.getBoundingClientRect().width);
    const total = w.reduce((a, b) => a + b, 0);
    if (total <= avail) {
      setHiddenCrumbs(0);
      return;
    }

    // Ca deborde : on garde depuis la FIN (dossier courant d'abord) en
    // reservant la largeur reelle du bouton « … » (mesuree, pas estimee).
    const moreW = moreEl.getBoundingClientRect().width;
    let used = moreW;
    let keep = 0;
    for (let i = w.length - 1; i >= 0; i--) {
      if (used + w[i] > avail) break;
      used += w[i];
      keep++;
    }
    // Au moins le dossier courant reste visible (il s'ellipse en CSS s'il est
    // a lui seul trop large) => jamais de texte qui deborde de la barre.
    setHiddenCrumbs(w.length - Math.max(1, keep));
  }, []);

  useLayoutEffect(() => {
    setCrumbMenu(false);
    recomputeCrumbs();
  }, [crumbs, editingAddr, recomputeCrumbs]);

  // Recalcul a tout changement de largeur : splitter du volet nav, mais aussi
  // redimensionnement de la fenetre (que navW seul ne capte pas).
  useEffect(() => {
    const el = crumbsRef.current;
    if (!el) return;
    const ro = new ResizeObserver(recomputeCrumbs);
    ro.observe(el);
    return () => ro.disconnect();
  }, [recomputeCrumbs, editingAddr]);

  // Fermeture du choix d'emplacement au clic ailleurs.
  useEffect(() => {
    if (!pathChoices) return;
    const close = () => setPathChoices(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [pathChoices]);

  // Fermeture du menu « … » au clic ailleurs.
  useEffect(() => {
    if (!crumbMenu) return;
    const close = () => setCrumbMenu(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [crumbMenu]);

  // Racines de l'arbre local (lecteurs + acces rapide) via commande Rust.
  // Extrait en callback pour pouvoir RECHARGER apres un renommage de lecteur.
  const refreshRoots = useCallback(() => {
    if (isLocal)
      invoke<LocalRoot[]>("local_roots")
        .then(setRoots)
        .catch(() => setRoots([]));
    // `lang` : les noms des lecteurs sont fabriques par le backend, dans sa
    // langue courante ; on les redemande quand la langue change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLocal, lang]);
  useEffect(() => {
    refreshRoots();
  }, [refreshRoots]);

  const sections: TreeSection[] = useMemo(() => {
    // Cote serveur, tant qu'on n'est pas connecte, le volet de navigation reste
    // vide : pas de racine « Serveur » ni d'acces rapides a deplier (sinon on
    // verrait l'arborescence de l'ancienne connexion).
    if (!isLocal && !enabled) return [];
    const quick =
      pins.length > 0
        ? [
            {
              title: t("pane.tree.quickAccess"),
              reorderable: true,
              nodes: pins.map((p) => ({
                label: p.label,
                path: p.path,
                icon: "folder" as const,
              })),
            },
          ]
        : [];
    if (!isLocal)
      return [
        ...quick,
        {
          nodes: [
            {
              label: t("common.server"),
              path: "/",
              icon: "drive" as const,
              defaultOpen: true,
            },
          ],
        },
      ];
    return [
      ...quick,
      {
        title: t("pane.tree.thisPc"),
        nodes: roots
          .filter((r) => r.kind === "drive")
          .filter((r) => showNetworkDrives || r.driveType !== "network")
          .map((r) => ({
            label: r.label,
            path: r.path,
            icon: "drive" as const,
            driveType: r.driveType,
            unc: r.unc,
          })),
      },
    ];
  }, [isLocal, enabled, roots, pins, showNetworkDrives, lang]);

  // Chargement resilient : garde la liste precedente sur echec transitoire,
  // retente les vides suspects tant qu'une copie tourne (SFTP sature).
  const load = useCallback(
    async (target: string) => {
      if (!enabled) return;
      const seq = ++loadSeq.current;
      // Un listage plus recent a pris la main : on abandonne sans rien ecrire.
      const stale = () => seq !== loadSeq.current;
      setLoading(true);
      setError("");
      const args = listArgs(side, target);
      const MAX = 6;
      let lastErr = "";
      for (let attempt = 0; attempt < MAX; attempt++) {
        try {
          const res = await rc<{ list: Entry[] }>("operations/list", args);
          if (stale()) return;
          const list = res.list ?? [];
          if (list.length === 0 && busyRef.current && attempt < MAX - 1) {
            await new Promise((r) => setTimeout(r, 500));
            continue;
          }
          setEntries(list);
          setEntriesDir(target);
          // Rafraichissement du MEME dossier (fin de transfert, operation sur
          // un fichier...) : on garde la selection, restreinte a ce qui existe
          // encore. La vider ferait sauter la selection de l'utilisateur des
          // qu'un transfert se termine en arriere-plan. Sur une vraie
          // navigation (dossier different), on repart a zero.
          if (target === entriesDirRef.current) {
            const alive = new Set(list.map((e) => e.Path));
            setSelected((prev) => {
              const kept = new Set([...prev].filter((p) => alive.has(p)));
              return kept.size === prev.size ? prev : kept;
            });
            // Le curseur clavier est un INDEX : la liste a pu changer de
            // taille, on le ramene dans les bornes plutot que de le perdre.
            const clamp = (i: number | null) =>
              i === null ? null : list.length === 0 ? null : Math.min(i, list.length - 1);
            setAnchor(clamp);
            setLead(clamp);
          } else {
            setSelected(new Set());
            setAnchor(null);
            setLead(null);
          }
          setLoading(false);
          // Attribut « caché » de Windows : hors du nom, donc hors de rclone.
          // On garde la liste COMPLÈTE en mémoire (les noms cachés comptent pour
          // les collisions) et on ne masque qu'à l'affichage.
          hiddenAttrNames(side, target, list).then((h) => {
            if (!stale()) setHiddenAttr(h);
          });
          return;
        } catch (e) {
          if (stale()) return;
          lastErr = String(e);
          await new Promise((r) => setTimeout(r, 400));
        }
      }
      if (stale()) return;
      setError(lastErr);
      setLoading(false);
    },
    [enabled, side, busyRef],
  );

  // Navigation : pousse dans l'historique + charge.
  const navigate = useCallback(
    (target: string) => {
      setHist((h) => {
        if (h.stack[h.idx] === target) return h;
        const stack = h.stack.slice(0, h.idx + 1);
        stack.push(target);
        return { stack, idx: stack.length - 1 };
      });
      setAddr(target);
      setOpErr("");
      load(target);
    },
    [load],
  );
  // Ouvre un chemin saisi ou colle dans la barre d'adresse. Un chemin absolu
  // venu d'ailleurs (Z:\…, \\nas\partage\…, /Volumes/…, smb://…) est
  // traduit en cherchant OU il existe vraiment de ce cote (cf. chemins.ts).
  const openHit = (h: PathHit) => {
    selectAfterLoad.current = h.file ? h : null;
    navigate(h.dir);
  };
  const goToTyped = async (raw: string) => {
    setEditingAddr(false);
    setPathChoices(null);
    selectAfterLoad.current = null;
    const parsed = parsePastedPath(raw);
    if (!parsed) {
      navigate(normalizeTypedPath(raw));
      return;
    }
    setResolving(true);
    let hits: PathHit[] = [];
    try {
      hits = await resolvePastedPath(side, parsed, entriesDir, isWin);
    } finally {
      setResolving(false);
    }
    if (hits.length === 0) {
      setAddr(dir);
      setOpErr(t("pane.err.pathNotFound", { path: raw.trim() }));
    } else if (hits.length === 1) {
      openHit(hits[0]);
    } else {
      setAddr(dir);
      setPathChoices(hits);
    }
  };

  const goBack = useCallback(() => {
    setHist((h) => {
      if (h.idx === 0) return h;
      const idx = h.idx - 1;
      setAddr(h.stack[idx]);
      load(h.stack[idx]);
      return { ...h, idx };
    });
  }, [load]);
  const goForward = useCallback(() => {
    setHist((h) => {
      if (h.idx >= h.stack.length - 1) return h;
      const idx = h.idx + 1;
      setAddr(h.stack[idx]);
      load(h.stack[idx]);
      return { ...h, idx };
    });
  }, [load]);
  const goUp = useCallback(() => navigate(parentDir(dir)), [navigate, dir]);

  // Premiere charge quand le panneau devient exploitable. Cote local, on attend
  // les racines (sinon on chargerait "/", inexistant sous Windows).
  useEffect(() => {
    if (!enabled) return;
    if (isLocal && roots.length === 0) return;
    const quick = isLocal ? roots.find((r) => r.kind === "quick") : undefined;
    // Cote serveur : on ouvre le dossier resolu a la connexion (dossier de depart
    // -> partages detectes -> "/"). Cote local : acces rapide ou racine.
    const start = quick
      ? quick.path
      : isLocal
        ? rootPath
        : (startAt ?? rootPath);
    setHist({ stack: [start], idx: 0 });
    setAddr(start);
    load(start);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, isLocal, roots.length, connKey, startAt]);

  // Ce qui est REELLEMENT affiche : `entries` reste la liste complete (les noms
  // caches comptent pour les collisions de renommage), on ne masque qu'ici.
  // Basculer le reglage est donc instantane, sans relister.
  const visible = useMemo(
    () =>
      showHidden
        ? entries
        : entries.filter(
            (e) => !isNameHidden(side, e.Name) && !hiddenAttr.has(e.Name),
          ),
    [entries, hiddenAttr, showHidden, side],
  );

  // Filtre de recherche, applique AVANT le tri. Requete vide (ou barre repliee)
  // => rien n'est filtre. La selection, le « tout selectionner » et la
  // navigation clavier operent tous sur `sorted`, donc sur le sous-ensemble
  // recherche : la recherche restreint vraiment l'espace de travail.
  const searched = useMemo(
    () =>
      searchOpen && search
        ? visible.filter((e) => matchesSearch(e.Name, search))
        : visible,
    [visible, searchOpen, search],
  );

  // Publie l'etat pour le DnD / copier-coller cote App.
  const sorted = useMemo(
    () => sortEntries(searched, sortKey, sortDir),
    [searched, sortKey, sortDir],
  );
  useEffect(() => {
    // `entriesDir` (et non `dir`) : les elements selectionnes appartiennent au
    // dossier REELLEMENT affiche, c'est lui la source/destination d'un transfert.
    bus.dir = entriesDir;
    bus.selected = sorted.filter((e) => selected.has(e.Path));
    bus.refresh = () => load(dir);
    bus.clearSelection = () => setSelected(new Set());
    // Porte sur les elements VISIBLES : selectionner des fichiers caches qu'on
    // n'affiche pas les exposerait a une suppression a l'aveugle.
    bus.selectAll = () => setSelected(new Set(sorted.map((e) => e.Path)));
  });

  const selectedEntries = () => sorted.filter((e) => selected.has(e.Path));

  // Barre d'etat facon Explorateur Windows : nombre d'elements affiches (donc
  // hors caches masques et restreint par la recherche) + nombre selectionne.
  const status = useMemo(() => {
    if (!enabled) return null;
    const n = sorted.length;
    const k = sorted.reduce((c, e) => c + (selected.has(e.Path) ? 1 : 0), 0);
    return {
      count: tn("pane.status.items", n),
      sel: k > 0 ? tn("pane.status.selected", k) : "",
    };
  }, [enabled, sorted, selected, lang]);

  // Fait defiler jusqu'a un element pour qu'il soit visible. Le `rAF` laisse la
  // liste se re-rendre avant qu'on cherche la ligne : apres un renommage ou un
  // rechargement, elle n'est pas encore dans le DOM au moment de l'appel.
  const revealPath = (path: string) => {
    requestAnimationFrame(() => {
      scrollRef.current
        ?.querySelector(`[data-path="${CSS.escape(path)}"]`)
        ?.scrollIntoView({ block: "nearest" });
    });
  };

  // Chemin colle qui designait un FICHIER : une fois son dossier affiche, on
  // le selectionne et on le fait apparaitre, comme « Afficher dans le Finder ».
  useEffect(() => {
    const want = selectAfterLoad.current;
    if (!want || entriesDir !== want.dir) return;
    const hit = sorted.find((e) => e.Path === want.file);
    if (!hit) return;
    selectAfterLoad.current = null;
    setSelected(new Set([hit.Path]));
    revealPath(hit.Path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sorted, entriesDir]);

  // "Ouvrir" : un dossier => on entre dedans ; un fichier LOCAL => ouvert avec
  // l'appli par defaut de l'OS ; un fichier DISTANT => telecharge en copie
  // temporaire puis ouvert (delegue au parent, qui gere la file de transferts).
  const openEntry = (e: Entry) => {
    if (e.IsDir) {
      navigate(joinDir(entriesDir, e.Name));
    } else if (side === "local") {
      openPath(joinDir(entriesDir, e.Name)).catch(() => {});
    } else {
      onOpenRemote?.(entriesDir, e.Name, e.Size, e.ModTime);
    }
  };

  // "Ouvrir dans l'explorateur" (local) : dossier => ouvre le dossier ;
  // fichier => ouvre son emplacement en le selectionnant.
  const revealEntry = (e: Entry) => {
    const p = joinDir(entriesDir, e.Name);
    (e.IsDir ? openPath(p) : revealItemInDir(p)).catch(() => {});
  };
  const openWith = (e: Entry) =>
    invoke("open_with", { path: joinDir(entriesDir, e.Name) }).catch(() => {});

  // Selection facon Windows : simple / Ctrl (toggle) / Shift (plage).
  const clickRow = (ev: ReactMouseEvent, idx: number) => {
    onFocus();
    setLead(idx);
    const path = sorted[idx].Path;
    if (ev.shiftKey && anchor !== null) {
      const [a, b] = anchor < idx ? [anchor, idx] : [idx, anchor];
      const range = new Set(sorted.slice(a, b + 1).map((e) => e.Path));
      setSelected(range);
    } else if (ev.ctrlKey || ev.metaKey) {
      setSelected((prev) => {
        const next = new Set(prev);
        next.has(path) ? next.delete(path) : next.add(path);
        return next;
      });
      setAnchor(idx);
    } else {
      setSelected(new Set([path]));
      setAnchor(idx);
    }
  };

  const startDrag = (e: Entry) => {
    const chosen = selected.has(e.Path) ? selectedEntries() : [e];
    drag.payload = { side, dir: entriesDir, items: chosen };
  };

  // Suppression : ouvre la confirmation, puis supprime via rclone.
  const askDelete = () => {
    const items = selectedEntries();
    if (items.length) setDel(items);
  };

  // Ce que la suppression emporte VRAIMENT : poids et nombre de fichiers. Un
  // dossier n'annonce pas sa taille (il faut parcourir son arborescence) — or
  // c'est justement le chiffre qui fait renoncer quand on s'appretait a effacer
  // le mauvais dossier. La suppression est definitive : autant le voir avant.
  useEffect(() => {
    if (!del) {
      setDelInfo(null);
      return;
    }
    let cancelled = false;
    setDelInfo({ bytes: 0, count: 0, computing: true, partial: false });
    (async () => {
      let bytes = 0;
      let count = 0;
      let partial = false;
      for (const it of del) {
        if (!it.IsDir) {
          bytes += it.Size;
          count += 1;
          continue;
        }
        try {
          const r = await rc<{ bytes: number; count: number }>("operations/size", {
            fs: dirFs(side, entriesDir, it.Name),
          });
          bytes += r.bytes ?? 0;
          count += r.count ?? 0;
        } catch {
          // Taille inconnue pour ce dossier : on l'annonce comme un minimum
          // plutot que de sous-estimer en silence.
          partial = true;
        }
      }
      if (!cancelled) setDelInfo({ bytes, count, computing: false, partial });
    })();
    return () => {
      cancelled = true;
    };
  }, [del, side, entriesDir]);
  const doDelete = async () => {
    const items = del ?? [];
    setDel(null);
    for (const it of items) {
      const a = fileAddr(side, entriesDir, it.Name);
      try {
        await rc(it.IsDir ? "operations/purge" : "operations/deletefile", a);
        logEvent(
          "info",
          "operation",
          t("pane.log.deleted", {
            path: `${sideLabel(side)} ${entriesDir}${it.Name}${it.IsDir ? "/" : ""}`,
          }),
        );
      } catch (e) {
        logEvent(
          "error",
          "operation",
          t("pane.log.deleteFailed", {
            path: `${sideLabel(side)} ${entriesDir}${it.Name}`,
            err: String(e),
          }),
        );
        /* on continue les autres */
      }
    }
    setSelected(new Set());
    sectionRef.current?.focus();
    load(entriesDir);
  };

  // Ferme la confirmation SANS supprimer, et rend le focus au panneau pour que
  // les raccourcis clavier repartent aussitot (cf. sectionRef).
  const closeDel = () => {
    setDel(null);
    sectionRef.current?.focus();
  };

  // Tant que la confirmation de suppression est ouverte, le CLAVIER lui est
  // reserve : Entree valide (« Oui, supprimer »), Echap annule (« Non »), et
  // TOUTE autre touche est avalee pour qu'aucune action du panneau (ouvrir un
  // fichier avec Entree, renommer, naviguer…) ne passe derriere la modale. On
  // ecoute au niveau `window` en phase de capture, donc AVANT React : peu importe
  // ou est le focus, le raccourci est intercepte (et le onKeyDown du panneau ne
  // le voit jamais).
  useEffect(() => {
    if (!del) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        doDelete();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeDel();
      } else {
        // Bloque tout le reste (Suppr, lettres, fleches…) : rien ne doit agir
        // sur le panneau pendant qu'un prompt est ouvert.
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // doDelete/closeDel sont recrees a chaque rendu mais lisent l'etat courant
    // via cloture ; `del` suffit comme declencheur.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [del]);

  // ---- Nouveau dossier / renommer / deplacer -------------------------------

  // Cree « Nouveau dossier » puis passe directement en renommage, comme
  // l'explorateur : on tape le nom tout de suite.
  const newFolder = async () => {
    setOpErr("");
    const name = freeName(t("pane.newFolderName"), new Set(entries.map((e) => e.Name)));
    try {
      await rc("operations/mkdir", fileAddr(side, entriesDir, name));
      logEvent(
        "info",
        "operation",
        t("pane.log.newFolder", { path: `${sideLabel(side)} ${entriesDir}${name}` }),
      );
    } catch (e) {
      setOpErr(t("pane.err.create", { err: String(e) }));
      logEvent(
        "error",
        "operation",
        t("pane.log.createFailed", {
          path: `${sideLabel(side)} ${entriesDir}${name}`,
          err: String(e),
        }),
      );
      return;
    }
    await load(entriesDir);
    const path = entryPath(side, entriesDir, name);
    setSelected(new Set([path]));
    skipBlur.current = false;
    setRenaming({ path, value: name });
  };

  // Renommer = deplacer vers le meme dossier sous un autre nom. rclone n'a pas
  // de « renommer un dossier » : pour un dossier on passe par sync/move (qui
  // fait des renommages cote serveur, pas une recopie) + suppression du dossier
  // source devenu vide.
  const commitRename = async (target: Entry, raw: string) => {
    setRenaming(null);
    const name = raw.trim();
    if (name === target.Name) return;

    const bad = nameError(name);
    if (bad) {
      setOpErr(bad);
      return;
    }
    if (entries.some((e) => e.Name === name)) {
      setOpErr(t("pane.err.exists", { name }));
      return;
    }

    setOpErr("");
    setLoading(true);
    try {
      if (target.IsDir) {
        await rc("sync/move", {
          srcFs: dirFs(side, entriesDir, target.Name),
          dstFs: dirFs(side, entriesDir, name),
          deleteEmptySrcDirs: true,
        });
      } else {
        const s = fileAddr(side, entriesDir, target.Name);
        const d = fileAddr(side, entriesDir, name);
        await rc("operations/movefile", {
          srcFs: s.fs,
          srcRemote: s.remote,
          dstFs: d.fs,
          dstRemote: d.remote,
        });
      }
      logEvent(
        "info",
        "operation",
        t("pane.log.renamed", {
          path: `${sideLabel(side)} ${entriesDir}${target.Name}`,
          name,
        }),
      );
    } catch (e) {
      setOpErr(t("pane.err.rename", { err: String(e) }));
      logEvent(
        "error",
        "operation",
        t("pane.log.renameFailed", {
          path: `${sideLabel(side)} ${entriesDir}${target.Name}`,
          name,
          err: String(e),
        }),
      );
    }
    await load(entriesDir);
    // La selection SUIT l'element renomme : sous son nouveau nom il a souvent
    // change de place dans le tri, et le perdre de vue apres l'avoir renomme
    // oblige a le rechercher a l'oeil. On defile jusqu'a lui pour la meme
    // raison — un renommage peut l'envoyer tout en bas d'une longue liste.
    const moved = entryPath(side, entriesDir, name);
    setSelected(new Set([moved]));
    revealPath(moved);
  };

  const startRename = (e: Entry) => {
    skipBlur.current = false;
    setRenaming({ path: e.Path, value: e.Name });
  };

  // Un clic N'IMPORTE OU ailleurs valide le renommage et en sort.
  //
  // On ne peut PAS se contenter du `blur` du champ : le lasso appelle
  // `preventDefault()` sur le clic dans le vide, ce qui empeche le navigateur de
  // deplacer le focus — le champ garde donc le focus et ne rend jamais la main.
  // On ecoute donc le clic sur la fenetre en phase de CAPTURE, avant que qui que
  // ce soit ne puisse l'annuler.
  const renamingRef = useRef(renaming);
  renamingRef.current = renaming;
  const commitRef = useRef(commitRename);
  commitRef.current = commitRename;

  useEffect(() => {
    if (!renaming) return;
    const onDown = (ev: PointerEvent) => {
      if ((ev.target as HTMLElement).closest(".rename-input")) return;
      const cur = renamingRef.current;
      if (!cur) return;
      const target = entries.find((e) => e.Path === cur.path);
      // Le `blur` qui suivra ne doit pas revalider une seconde fois.
      skipBlur.current = true;
      if (target) commitRef.current(target, cur.value);
      else setRenaming(null);
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renaming?.path, entries]);

  // Un clic n'importe ou hors de la barre d'URL revient au fil d'Ariane (comme
  // Echap). Meme piege que le renommage : le `blur` du champ ne suffit pas, car
  // le lasso appelle `preventDefault()` sur le clic dans le vide et le focus ne
  // bouge donc pas. On ecoute le clic en phase de CAPTURE.
  useEffect(() => {
    if (!editingAddr) return;
    const onDown = (ev: PointerEvent) => {
      if ((ev.target as HTMLElement).closest(".url-bar")) return;
      setAddr(dir);
      setEditingAddr(false);
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [editingAddr, dir]);

  // Loupe : deploie / replie la barre de recherche. On la vide en repliant pour
  // ne pas garder un filtre invisible actif.
  const toggleSearch = () => {
    setSearchOpen((open) => {
      if (open) setSearch("");
      return !open;
    });
  };

  // Focus automatique du champ des qu'on deploie la barre.
  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  // Un clic hors de la barre ne la referme QUE si le champ est vide : tant qu'il
  // reste du texte, on garde la recherche ouverte et le tri en place, pour
  // pouvoir cliquer sur un resultat sans perdre le filtrage. La loupe est exclue :
  // elle a son propre toggle, sinon elle serait fermee ici puis rouverte par son
  // clic. Meme piege que le renommage / la barre d'URL : on ecoute en phase de
  // CAPTURE, car le lasso `preventDefault()` le clic dans le vide et empeche un
  // simple blur. `search` est dans les deps pour que la fermeture voie la
  // derniere valeur du champ.
  useEffect(() => {
    if (!searchOpen) return;
    const onDown = (ev: PointerEvent) => {
      if (search) return;
      const t = ev.target as HTMLElement;
      if (t.closest(".search-wrap") || t.closest(".search-toggle")) return;
      setSearchOpen(false);
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [searchOpen, search]);

  // Une recherche vaut pour le dossier AFFICHE : on la remet a zero des qu'on
  // change reellement de dossier (entriesDir), pas sur un simple rafraichissement
  // du meme dossier (ou entriesDir ne bouge pas).
  useEffect(() => {
    setSearch("");
  }, [entriesDir]);

  // Deplacement par glisser-deposer DANS le meme panneau : on lache sur un
  // dossier, les elements y entrent. (Entre panneaux, c'est une copie : cf. App.)
  const moveInto = async (payload: Payload, target: Entry) => {
    const items = payload.items.filter((i) => i.Name !== target.Name);
    if (!items.length) return;
    const destDir = joinDir(payload.dir, target.Name);

    setOpErr("");
    setLoading(true);
    for (const it of items) {
      try {
        if (it.IsDir) {
          await rc("sync/move", {
            srcFs: dirFs(side, payload.dir, it.Name),
            dstFs: dirFs(side, destDir, it.Name),
            deleteEmptySrcDirs: true,
          });
        } else {
          const s = fileAddr(side, payload.dir, it.Name);
          const d = fileAddr(side, destDir, it.Name);
          await rc("operations/movefile", {
            srcFs: s.fs,
            srcRemote: s.remote,
            dstFs: d.fs,
            dstRemote: d.remote,
          });
        }
        logEvent(
          "info",
          "operation",
          t("pane.log.moved", {
            path: `${sideLabel(side)} ${payload.dir}${it.Name}`,
            dest: destDir,
          }),
        );
      } catch (e) {
        setOpErr(t("pane.err.move", { err: String(e) }));
        logEvent(
          "error",
          "operation",
          t("pane.log.moveFailed", {
            path: `${sideLabel(side)} ${payload.dir}${it.Name}`,
            dest: destDir,
            err: String(e),
          }),
        );
      }
    }
    setSelected(new Set());
    await load(entriesDir);
  };

  // Taille d'un dossier : calculee des l'ouverture du menu contextuel (rclone
  // doit parcourir l'arborescence, d'où l'attente possible sur un gros dossier).
  useEffect(() => {
    const t = menu?.target;
    if (!t || !t.IsDir) {
      setSizeInfo(null);
      return;
    }
    let cancelled = false;
    setSizeInfo({ path: t.Path, bytes: -1, count: -1 });
    rc<{ bytes: number; count: number }>("operations/size", {
      fs: dirFs(side, entriesDir, t.Name),
    })
      .then((r) => {
        if (!cancelled)
          setSizeInfo({ path: t.Path, bytes: r.bytes ?? 0, count: r.count ?? 0 });
      })
      .catch(() => {
        if (!cancelled) setSizeInfo({ path: t.Path, bytes: -2, count: 0 });
      });
    return () => {
      cancelled = true;
    };
  }, [menu, side, entriesDir]);

  // Selection au lasso : depuis une zone vide du volet fichiers, on entoure
  // les elements ; ceux que le rectangle touche sont selectionnes.
  const onBandStart = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    const t = e.target as HTMLElement;
    if (t.closest("[data-row]")) return; // clic sur un item => pas de lasso
    const el = scrollRef.current;
    if (!el) return;
    onFocus();
    e.preventDefault();
    // Capture du pointeur : le relachement HORS de la fenetre est quand meme
    // capte => la selection est conservee (plus de deselection accidentelle).
    el.setPointerCapture(e.pointerId);
    const additive = e.ctrlKey || e.metaKey;
    bandBase.current = additive ? new Set(selected) : new Set();
    if (!additive) setSelected(new Set());
    const sx = e.clientX;
    const sy = e.clientY;
    let moved = false;
    const move = (ev: PointerEvent) => {
      moved = true;
      const x0 = Math.min(sx, ev.clientX);
      const y0 = Math.min(sy, ev.clientY);
      const x1 = Math.max(sx, ev.clientX);
      const y1 = Math.max(sy, ev.clientY);
      setBand({ x0, y0, x1, y1 });
      const next = new Set(bandBase.current);
      el.querySelectorAll<HTMLElement>("[data-row]").forEach((row) => {
        const r = row.getBoundingClientRect();
        if (
          row.dataset.path &&
          !(r.right < x0 || r.left > x1 || r.bottom < y0 || r.top > y1)
        )
          next.add(row.dataset.path);
      });
      setSelected(next);
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        /* deja relache */
      }
      setBand(null);
      if (moved) suppressClick.current = true; // n'annule pas la selection au clic
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  const onDrop = () => {
    setDropHover(false);
    if (drag.payload && drag.payload.side !== side) onDropItems(drag.payload, side);
    drag.payload = null;
  };

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setSortDir((d) => (d === 1 ? -1 : 1));
    else {
      setSortKey(key);
      setSortDir(1);
    }
  };

  const setViewMode = (v: View) => {
    setView(v);
    localStorage.setItem(`copiteur.view.${side}`, v);
  };

  // Ferme le menu contextuel : clic (ou clic droit) ailleurs, ouverture d'un
  // autre menu (y compris dans l'autre volet), Echap, molette. On ecoute
  // `pointerdown` (et non `click`) pour capter aussi le bouton droit — sans quoi
  // un clic droit dans l'autre volet laisserait ce menu-ci ouvert.
  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => {
      // Un clic DANS le menu ne le ferme pas (sinon l'action ne se declenche pas).
      if ((e.target as HTMLElement)?.closest?.(".ctx-menu")) return;
      setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenu(null);
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  // Recadre le menu pour qu'il tienne dans la fenetre (clic pres du bas / bord
  // droit). Mesure apres rendu a la position d'ancrage, puis repositionne.
  useLayoutEffect(() => {
    if (!menu) {
      setMenuPos(null);
      return;
    }
    const el = menuRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const pad = 6;
    let left = menu.x;
    let top = menu.y;
    if (left + r.width > window.innerWidth - pad)
      left = Math.max(pad, window.innerWidth - r.width - pad);
    if (top + r.height > window.innerHeight - pad)
      top = Math.max(pad, window.innerHeight - r.height - pad);
    setMenuPos({ left, top });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu]);

  // Nombre de tuiles par rangee (vue miniatures) : mesure reelle dans le DOM,
  // car la grille CSS s'adapte a la largeur du volet. En vue liste c'est 1.
  const colsPerRow = () => {
    const el = scrollRef.current;
    if (!el) return 1;
    const tiles = el.querySelectorAll<HTMLElement>(".tile");
    if (tiles.length < 2) return 1;
    const top0 = tiles[0].offsetTop;
    let cols = 1;
    for (let i = 1; i < tiles.length; i++) {
      if (tiles[i].offsetTop !== top0) break;
      cols++;
    }
    return cols;
  };

  // Deplace le curseur (`lead`) de `delta` positions. `extend` (Shift) etend la
  // selection depuis l'ancre ; sinon on selectionne le seul element vise et on
  // pose une nouvelle ancre — exactement comme l'explorateur.
  const moveSelection = (delta: number, extend: boolean) => {
    if (sorted.length === 0) return;
    const cur = lead ?? anchor ?? -1;
    const next =
      cur < 0
        ? delta > 0
          ? 0
          : sorted.length - 1
        : Math.max(0, Math.min(sorted.length - 1, cur + delta));
    setLead(next);
    if (extend && anchor !== null) {
      const [lo, hi] = anchor < next ? [anchor, next] : [next, anchor];
      setSelected(new Set(sorted.slice(lo, hi + 1).map((e) => e.Path)));
    } else {
      setSelected(new Set([sorted[next].Path]));
      setAnchor(next);
    }
    // Garde l'element vise a l'ecran.
    revealPath(sorted[next].Path);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Un prompt est ouvert (modale d'App, ou notre propre confirmation de
    // suppression) : le panneau ne doit plus rien faire au clavier. `del` est
    // deja intercepte en amont par un ecouteur `window`, mais on double la garde
    // ici pour les modales d'App.
    if (anyModal || del) return;
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === "INPUT") return;
    const arrow =
      e.key === "ArrowUp" ||
      e.key === "ArrowDown" ||
      e.key === "ArrowLeft" ||
      e.key === "ArrowRight";
    if (arrow) {
      // En liste, seul le vertical bouge (1 colonne) ; en tuiles, la grille.
      const cols = view === "tiles" ? colsPerRow() : 1;
      let delta = 0;
      if (e.key === "ArrowUp") delta = -cols;
      else if (e.key === "ArrowDown") delta = cols;
      else if (view === "tiles" && e.key === "ArrowLeft") delta = -1;
      else if (view === "tiles" && e.key === "ArrowRight") delta = 1;
      if (delta !== 0) {
        e.preventDefault();
        moveSelection(delta, e.shiftKey);
      }
      return;
    }
    // Cmd/Ctrl+A = tout selectionner DANS LE PANNEAU. Sans ca, le raccourci
    // retombait sur le « Tout selectionner » natif de la webview, qui
    // surlignait le TEXTE de l'interface au lieu des fichiers.
    if ((e.metaKey || e.ctrlKey) && (e.key === "a" || e.key === "A")) {
      e.preventDefault();
      setSelected(new Set(sorted.map((it) => it.Path)));
      return;
    }
    // Suppression au clavier facon Finder : ⌘⌫ sous macOS, Ctrl+⌫ ailleurs.
    // Le test portait sur `isMac` seul, donc sous Windows/Linux Ctrl+Backspace
    // retombait sur la branche « remonter d'un dossier ». On discrimine
    // desormais sur le MODIFICATEUR, et Backspace SEUL continue de remonter
    // (convention de l'Explorateur). Passe toujours par la confirmation.
    if ((isMac ? e.metaKey : e.ctrlKey) && e.key === "Backspace") {
      e.preventDefault();
      askDelete();
    } else if (e.key === "Backspace") {
      e.preventDefault();
      goUp();
    } else if (e.key === "Enter") {
      const sel = selectedEntries();
      if (sel.length === 1) openEntry(sel[0]);
    } else if (e.key === "F2") {
      const sel = selectedEntries();
      if (sel.length === 1) startRename(sel[0]);
    } else if (e.key === "Delete") {
      askDelete();
    } else if (e.key === "Escape") {
      setSelected(new Set());
    }
  };

  // Champ de renommage, rendu A LA PLACE du nom dans la ligne survolee.
  const renameInput = (it: Entry) => (
    <input
      className="rename-input"
      autoFocus
      value={renaming!.value}
      spellCheck={false}
      onFocus={(e) => {
        // Comme l'explorateur : on presente le nom SANS l'extension.
        const dot = it.Name.lastIndexOf(".");
        e.target.setSelectionRange(0, !it.IsDir && dot > 0 ? dot : it.Name.length);
      }}
      onChange={(e) => setRenaming({ path: it.Path, value: e.target.value })}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") commitRename(it, renaming!.value);
        else if (e.key === "Escape") {
          skipBlur.current = true;
          setRenaming(null);
        }
      }}
      onBlur={() => {
        if (skipBlur.current) {
          skipBlur.current = false;
          return;
        }
        commitRename(it, renaming!.value);
      }}
    />
  );

  // Lacher SUR un dossier. Deux cas selon la provenance :
  //   - meme panneau  -> deplacement dans ce dossier (comportement historique) ;
  //   - autre panneau -> copie DANS ce dossier, au lieu du dossier affiche.
  //
  // Ces poignees ne sont PAS posees sur toute la ligne mais seulement sur
  // l'icone + le nom. Dans un dossier rempli de sous-dossiers, prendre la ligne
  // entiere ne laisserait plus un pixel pour viser le panneau lui-meme : la
  // zone de depot globale disparaitrait. C'est la regle du Finder.
  const dropTargetProps = (it: Entry) => {
    const canDrop = () =>
      it.IsDir &&
      !!drag.payload &&
      (drag.payload.side !== side ||
        !drag.payload.items.some((x) => x.Name === it.Name));
    return {
      onDragOver: (e: React.DragEvent) => {
        if (!canDrop()) return;
        e.preventDefault();
        e.stopPropagation();
        setDropRow(it.Path);
        // Un seul surlignage a la fois : on eteint celui du panneau pour que la
        // cible visee ne fasse aucun doute.
        setDropHover(false);
      },
      onDragLeave: () => setDropRow((p) => (p === it.Path ? null : p)),
      onDrop: (e: React.DragEvent) => {
        if (!canDrop()) return;
        e.stopPropagation(); // sinon le panneau traiterait ce lacher comme une copie
        const p = drag.payload!;
        drag.payload = null;
        setDropRow(null);
        setDropHover(false);
        if (p.side === side) moveInto(p, it);
        else onDropItems(p, side, joinDir(entriesDir, it.Name));
      },
    };
  };

  return (
    <section
      ref={sectionRef}
      className={
        "explorer" + (active ? " is-active" : "") + (dropHover ? " is-drop" : "")
      }
      onMouseDown={onFocus}
      tabIndex={0}
      onFocus={onFocus}
      onKeyDown={onKeyDown}
      onDragOver={(e) => {
        if (enabled && drag.payload && drag.payload.side !== side) {
          e.preventDefault();
          setDropHover(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropHover(false);
      }}
      onDrop={onDrop}
    >
      {/* En-tete : titre + navigation + adresse + bascule de vue */}
      <header className="explorer-head">
        <span className="explorer-title">{title}</span>
        <div className="nav-btns">
          <button
            className="nav-btn"
            disabled={!enabled || hist.idx === 0}
            onClick={goBack}
            title={t("pane.head.back")}
          >
            <UiIcon name="back" />
          </button>
          <button
            className="nav-btn"
            disabled={!enabled || hist.idx >= hist.stack.length - 1}
            onClick={goForward}
            title={t("pane.head.forward")}
          >
            <UiIcon name="forward" />
          </button>
          <button
            className="nav-btn"
            disabled={!enabled}
            onClick={goUp}
            title={t("pane.head.up")}
          >
            <UiIcon name="up" />
          </button>
          <button
            className="nav-btn"
            disabled={!enabled}
            onClick={() => load(entriesDir)}
            title={t("pane.head.refresh")}
          >
            <UiIcon name="refresh" />
          </button>
        </div>
        {/* Le spinner est en overlay DANS la barre d'adresse : s'il etait un
            enfant du flux, son apparition/disparition a chaque navigation
            decalerait les boutons de vue (ils clignotaient). */}
        <div className="addr-wrap">
          {editingAddr ? (
            <input
              className="url-bar"
              autoFocus
              // Chemin selectionne en entier a l'ouverture : un Cmd+C suffit
              // pour le recuperer. Taper remplace alors tout, comme dans la
              // barre d'adresse d'un explorateur ; un clic dans le champ
              // deselectionne et permet d'editer une portion.
              onFocus={(e) => e.currentTarget.select()}
              value={addr}
              onChange={(e) => setAddr(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  goToTyped((e.target as HTMLInputElement).value);
                } else if (e.key === "Escape") {
                  setAddr(dir);
                  setEditingAddr(false);
                }
              }}
              onBlur={() => setEditingAddr(false)}
              spellCheck={false}
              disabled={!enabled}
              aria-label={t("pane.head.pathOf", { title })}
            />
          ) : (
            <div
              className="crumbs"
              ref={crumbsRef}
              title={t("pane.head.typePath")}
              onClick={(e) => {
                if (e.target === e.currentTarget && enabled) {
                  setAddr(dir);
                  setEditingAddr(true);
                }
              }}
            >
              {/* Chemin trop long : les parents lointains sont replies dans un
                  menu « … » (facon explorateur Windows) plutot que tronques. */}
              {hiddenCrumbs > 0 && (
                <span className="crumb-wrap">
                  <button
                    className="crumb crumb-more"
                    disabled={!enabled}
                    title={t("pane.head.parents")}
                    onClick={(e) => {
                      e.stopPropagation();
                      onFocus();
                      setCrumbMenu((v) => !v);
                    }}
                  >
                    …
                  </button>
                  <span className="crumb-sep">›</span>
                </span>
              )}
              {crumbs.slice(hiddenCrumbs).map((c, i, arr) => (
                <span className="crumb-wrap" key={c.path}>
                  <button
                    className="crumb"
                    disabled={!enabled}
                    onClick={() => {
                      onFocus();
                      navigate(c.path);
                    }}
                  >
                    {c.label}
                  </button>
                  {i < arr.length - 1 && <span className="crumb-sep">›</span>}
                </span>
              ))}
            </div>
          )}

          {/* Miroir de mesure : hors flux et invisible, il contient TOUJOURS
              tous les segments (+ un bouton « … » temoin) pour que le calcul du
              repli porte sur les vraies largeurs, jamais sur le fil deja replie. */}
          {!editingAddr && (
            <div className="crumbs crumbs-mirror" ref={crumbsMirrorRef} aria-hidden>
              <span className="crumb-wrap" data-more>
                <button className="crumb crumb-more" tabIndex={-1}>
                  …
                </button>
                <span className="crumb-sep">›</span>
              </span>
              {crumbs.map((c, i, arr) => (
                <span className="crumb-wrap" key={c.path} data-seg>
                  <button className="crumb" tabIndex={-1}>
                    {c.label}
                  </button>
                  {i < arr.length - 1 && <span className="crumb-sep">›</span>}
                </span>
              ))}
            </div>
          )}

          {(loading || resolving) && (
            <span className="loading-dot" title={t("pane.head.loading")} />
          )}

          {/* Chemin colle trouve a plusieurs endroits (lettre de lecteur : le
              nom du partage est perdu) : on demande plutot que deviner. */}
          {pathChoices && (
            <div className="crumb-menu" onClick={(e) => e.stopPropagation()}>
              <div className="crumb-menu-title">{t("pane.head.pathChoices")}</div>
              {pathChoices.map((h) => (
                <button
                  key={h.dir + (h.file ?? "")}
                  className="ctx-item"
                  onClick={() => {
                    setPathChoices(null);
                    onFocus();
                    openHit(h);
                  }}
                >
                  {h.file ? joinDir(h.dir, h.file) : h.dir}
                </button>
              ))}
            </div>
          )}

          {/* Menu deroulant des parents replies (du plus proche au plus loin). */}
          {crumbMenu && hiddenCrumbs > 0 && (
            <div className="crumb-menu">
              {crumbs
                .slice(0, hiddenCrumbs)
                .reverse()
                .map((c) => (
                  <button
                    key={c.path}
                    className="ctx-item"
                    onClick={() => {
                      setCrumbMenu(false);
                      onFocus();
                      navigate(c.path);
                    }}
                  >
                    {c.label}
                  </button>
                ))}
            </div>
          )}
        </div>
        {/* Barre de recherche, deployee par la loupe. Placee AVANT la loupe :
            en grandissant, elle POUSSE la barre d'adresse vers la gauche (flex),
            et le fil d'Ariane se replie tout seul (ResizeObserver) en gardant sa
            fin ancree. Repliee, elle a une largeur nulle. */}
        <div className={"search-wrap" + (searchOpen ? " open" : "")}>
          <input
            ref={searchInputRef}
            className="search-bar"
            placeholder={t("pane.head.searchHere")}
            value={search}
            disabled={!enabled}
            spellCheck={false}
            tabIndex={searchOpen ? 0 : -1}
            aria-label={t("pane.head.searchIn", { title })}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setSearch("");
                setSearchOpen(false);
              }
            }}
            // On sort du champ : s'il est vide, la barre se replie (animation
            // inverse). Rempli, on la garde ouverte pour ne pas perdre le filtre.
            onBlur={() => {
              if (!search) setSearchOpen(false);
            }}
          />
          {search && (
            <button
              type="button"
              className="search-clear"
              title={t("pane.head.clear")}
              tabIndex={searchOpen ? 0 : -1}
              // preventDefault : ne pas retirer le focus du champ (sinon un
              // champ vide se replierait alors qu'on voulait juste effacer).
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setSearch("");
                searchInputRef.current?.focus();
              }}
            >
              ✕
            </button>
          )}
        </div>
        <button
          className={"nav-btn search-toggle" + (searchOpen ? " on" : "")}
          disabled={!enabled}
          // preventDefault : ne pas retirer le focus du champ avant le clic
          // (le blur declencherait une fermeture qui se battrait avec le clic).
          // La classe `search-toggle` exclut ce bouton du clic-hors-barre, pour
          // qu'il ne soit pas ferme puis rouvert dans le meme geste.
          onMouseDown={(e) => e.preventDefault()}
          onClick={toggleSearch}
          title={t("pane.head.search")}
        >
          <UiIcon name="search" />
        </button>
        <div className="view-btns">
          <button
            className={"view-btn" + (view === "list" ? " on" : "")}
            onClick={() => setViewMode("list")}
            title={t("pane.head.listView")}
          >
            <UiIcon name="list" />
          </button>
          <button
            className={"view-btn" + (view === "tiles" ? " on" : "")}
            onClick={() => setViewMode("tiles")}
            title={t("pane.head.tilesView")}
          >
            <UiIcon name="tiles" />
          </button>
        </div>
      </header>

      <div className="explorer-body">
        <NavTree
          // Remonte tout l'arbre a chaque (re)connexion : sans ca, les noeuds
          // deja deplies garderaient en cache les sous-dossiers de l'ancien
          // serveur (chaque noeud stocke ses enfants dans son etat local).
          key={connKey ?? 0}
          side={side}
          sections={sections}
          current={dir}
          showHidden={showHidden}
          width={navW}
          onNavigate={(p) => {
            onFocus();
            navigate(p);
          }}
          onNodeContext={(e, node) => {
            e.preventDefault();
            e.stopPropagation();
            onFocus();
            setMenu({
              x: e.clientX,
              y: e.clientY,
              target: null,
              nav: {
                path: node.path,
                label: node.label,
                driveType: node.driveType,
                unc: node.unc,
              },
            });
          }}
          onReorderPin={onReorderPin}
          status={status}
        />
        {/* Poignee de redimensionnement du volet de navigation. */}
        <div className="pane-splitter" onMouseDown={resizeNav(navW)} />

        <div
          className="files-pane"
          onContextMenu={(e) => {
            e.preventDefault();
            onFocus();
            setMenu({ x: e.clientX, y: e.clientY, target: ctxTarget.current });
            ctxTarget.current = null;
          }}
          onClick={(e) => {
            // Apres un lasso, on ne re-deselectionne pas au clic de fin.
            if (suppressClick.current) {
              suppressClick.current = false;
              return;
            }
            // Clic dans le vide (ni ligne, ni en-tete) => deselection.
            const t = e.target as HTMLElement;
            if (!t.closest("[data-row]") && !t.closest(".files-head"))
              setSelected(new Set());
          }}
        >
          {enabled && error && entries.length > 0 && (
            <div className="files-banner">{t("pane.list.stale", { err: error })}</div>
          )}
          {/* Echec d'une operation (creation, renommage, deplacement) : sans ca,
              un nom refuse par le serveur echouerait en silence. */}
          {enabled && opErr && (
            <div className="files-banner files-banner-err">
              {opErr}
              <button
                className="banner-close"
                aria-label={t("common.close")}
                onClick={() => setOpErr("")}
              >
                ✕
              </button>
            </div>
          )}

          {/* En-tete de colonnes HORS de la zone qui defile : rien ne passe
              derriere (comme la barre d'URL). */}
          {enabled && view === "list" && sorted.length > 0 && (
            <div className="files-head">
              {(() => {
                const total = colW.name + colW.date + colW.type + colW.size;
                return COLS.map((col) => {
                  const w = (colW as Record<string, number>)[col.key];
                  return (
                    <div
                      key={col.key}
                      className={"fh-cell " + col.className}
                      style={{ width: `${(w / total) * 100}%` }}
                      onClick={() => toggleSort(col.key)}
                    >
                      <span className="th-label">{t(col.label)}</span>
                      {sortKey === col.key && (
                        <span className="sort-caret">
                          {sortDir === 1 ? "▲" : "▼"}
                        </span>
                      )}
                      <span
                        className="col-resizer"
                        onClick={(e) => e.stopPropagation()}
                        onMouseDown={resizeCol(col.key as keyof ColW, w)}
                      />
                    </div>
                  );
                });
              })()}
            </div>
          )}

          <div
            className="files-scroll"
            ref={scrollRef}
            onPointerDown={onBandStart}
          >
            {!enabled ? (
              <div className="files-empty">{t("pane.list.notConnected")}</div>
            ) : sorted.length === 0 ? (
              loading ? (
                <div className="files-empty">{t("pane.head.loading")}</div>
              ) : error ? (
                <div className="files-empty files-error">{error}</div>
              ) : searchOpen && search ? (
                // Filtre actif qui ne laisse rien passer.
                <div className="files-empty">
                  {t("pane.list.noResult", { query: search })}
                </div>
              ) : entries.length > 0 ? (
                // Le dossier n'est pas vide : tout son contenu est masque.
                <div className="files-empty">
                  {t("pane.list.emptyHidden")}
                </div>
              ) : (
                <div className="files-empty">{t("pane.list.empty")}</div>
              )
            ) : view === "list" ? (
              <table
                className="files-table"
                style={{ tableLayout: "fixed", width: "100%" }}
              >
                <colgroup>
                  {(() => {
                    const total = colW.name + colW.date + colW.type + colW.size;
                    return COLS.map((col) => (
                      <col
                        key={col.key}
                        style={{
                          width: `${((colW as Record<string, number>)[col.key] / total) * 100}%`,
                        }}
                      />
                    ));
                  })()}
                </colgroup>
                <tbody>
                  {sorted.map((it, idx) => (
                    <tr
                      key={it.Path}
                      data-row
                      data-path={it.Path}
                      className={
                        (selected.has(it.Path) ? "row-selected" : "") +
                        (dropRow === it.Path ? " row-drop" : "")
                      }
                      draggable={renaming?.path !== it.Path}
                      onDragStart={() => startDrag(it)}
                      onMouseDown={(e) => {
                        if (e.shiftKey) e.preventDefault();
                      }}
                      onClick={(e) => clickRow(e, idx)}
                      onDoubleClick={() => openEntry(it)}
                      onContextMenu={() => {
                        ctxTarget.current = it;
                        if (!selected.has(it.Path))
                          setSelected(new Set([it.Path]));
                      }}
                    >
                      <td className="c-name">
                        {/* Cible de depot restreinte a l'icone + le nom, pas a
                            toute la ligne : cf. `dropTargetProps`. */}
                        <div className="name-cell" {...dropTargetProps(it)}>
                          <span className="cell-icon">
                            <FileIcon kind={iconKind(it)} />
                          </span>
                          {renaming?.path === it.Path ? (
                            renameInput(it)
                          ) : (
                            <span className="cell-name">{it.Name}</span>
                          )}
                        </div>
                      </td>
                      <td className="c-date">{humanDate(it.ModTime)}</td>
                      <td className="c-type">{typeLabel(it)}</td>
                      <td className="c-size">
                        {it.IsDir ? "" : humanSize(it.Size)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="tiles">
                {sorted.map((it, idx) => (
                  <div
                    key={it.Path}
                    data-row
                    data-path={it.Path}
                    className={
                      "tile" +
                      (selected.has(it.Path) ? " tile-selected" : "") +
                      (dropRow === it.Path ? " tile-drop" : "")
                    }
                    draggable={renaming?.path !== it.Path}
                    onDragStart={() => startDrag(it)}
                    onMouseDown={(e) => {
                      if (e.shiftKey) e.preventDefault();
                    }}
                    onClick={(e) => clickRow(e, idx)}
                    onDoubleClick={() => openEntry(it)}
                    onContextMenu={() => {
                      ctxTarget.current = it;
                      if (!selected.has(it.Path)) setSelected(new Set([it.Path]));
                    }}
                    title={it.Name}
                  >
                    {/* Meme regle qu'en vue liste : la cible de depot est
                        l'icone + le nom, pas toute la tuile (qui inclut ses
                        marges). Il reste donc du vide pour viser le panneau. */}
                    <div className="tile-target" {...dropTargetProps(it)}>
                      <div className="tile-icon">
                        <FileIcon kind={iconKind(it)} />
                      </div>
                      {renaming?.path === it.Path ? (
                        renameInput(it)
                      ) : (
                        <div className="tile-name">{it.Name}</div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {menu && (
        <div
          ref={menuRef}
          className="ctx-menu"
          style={{ left: menuPos?.left ?? menu.x, top: menuPos?.top ?? menu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {menu.nav ? (
            // ---- Menu d'un dossier de l'arbre (nav pane) ----
            (() => {
              const pinned = pins.some((x) => x.path === menu.nav!.path);
              return (
                <button
                  className="ctx-item"
                  onClick={() => {
                    pinned
                      ? onUnpin(menu.nav!.path)
                      : onPin(menu.nav!.path, menu.nav!.label);
                    setMenu(null);
                  }}
                >
                  {pinned ? t("pane.ctx.unpin") : t("pane.ctx.pin")}
                </button>
              );
            })()
          ) : (
            // ---- Menu d'un fichier / dossier (file pane) ----
            <>
              {/* Taille, en tete de menu. Un dossier demande a rclone de
                  parcourir son arborescence : on affiche un rouleau tant que
                  le calcul tourne. */}
              {menu.target && (
                <>
                  <div className="ctx-size">
                    {!menu.target.IsDir ? (
                      humanSize(menu.target.Size)
                    ) : sizeInfo?.path !== menu.target.Path ? (
                      <span className="ctx-spinner" />
                    ) : sizeInfo.bytes === -1 ? (
                      <>
                        <span className="ctx-spinner" />
                        {t("pane.ctx.sizeComputing")}
                      </>
                    ) : sizeInfo.bytes === -2 ? (
                      t("pane.ctx.sizeUnavailable")
                    ) : (
                      `${humanSize(sizeInfo.bytes)} · ${tn("pane.count.files", sizeInfo.count)}`
                    )}
                  </div>
                  <div className="ctx-sep" />
                </>
              )}

              {/* Clic droit dans le vide : creer un dossier ici. */}
              {!menu.target && (
                <>
                  <button
                    className="ctx-item"
                    onClick={() => {
                      newFolder();
                      setMenu(null);
                    }}
                  >
                    {t("pane.ctx.newFolder")}
                  </button>
                  <div className="ctx-sep" />
                </>
              )}

              {/* Ouverture OS (uniquement cote local, sur un element cible). */}
              {side === "local" && menu.target && (
                <>
                  <button
                    className="ctx-item"
                    onClick={() => {
                      openEntry(menu.target!);
                      setMenu(null);
                    }}
                  >
                    {t("pane.ctx.open")}
                  </button>
                  {isWin && !menu.target.IsDir && (
                    <button
                      className="ctx-item"
                      onClick={() => {
                        openWith(menu.target!);
                        setMenu(null);
                      }}
                    >
                      {t("pane.ctx.openWith")}
                    </button>
                  )}
                  <button
                    className="ctx-item"
                    onClick={() => {
                      revealEntry(menu.target!);
                      setMenu(null);
                    }}
                  >
                    {t("pane.ctx.reveal")}
                  </button>
                  <div className="ctx-sep" />
                </>
              )}

              {/* Cote serveur : ouvrir telecharge une copie temporaire puis
                  l'ouvre (un dossier, lui, s'ouvre = on entre dedans). */}
              {side === "remote" && menu.target && (
                <>
                  <button
                    className="ctx-item"
                    onClick={() => {
                      openEntry(menu.target!);
                      setMenu(null);
                    }}
                  >
                    {t("pane.ctx.open")}
                  </button>
                  <div className="ctx-sep" />
                </>
              )}
              <button
                className="ctx-item"
                disabled={selected.size === 0}
                onClick={() => {
                  onCopy(side);
                  setMenu(null);
                }}
              >
                {t("pane.ctx.copy")}
              </button>
              <button
                className="ctx-item"
                disabled={!hasClipboard}
                onClick={() => {
                  onPaste(side);
                  setMenu(null);
                }}
              >
                {t("pane.ctx.paste")}
              </button>
              <div className="ctx-sep" />
              {menu.target && (
                <button
                  className="ctx-item"
                  disabled={selected.size > 1}
                  title={
                    selected.size > 1
                      ? t("pane.ctx.renameOne")
                      : undefined
                  }
                  onClick={() => {
                    startRename(menu.target!);
                    setMenu(null);
                  }}
                >
                  {t("common.rename")}
                </button>
              )}
              <button
                className="ctx-item ctx-danger"
                disabled={selected.size === 0}
                onClick={() => {
                  askDelete();
                  setMenu(null);
                }}
              >
                {t("common.delete")}
              </button>
              {menu.target?.IsDir &&
                (() => {
                  const p = joinDir(entriesDir, menu.target!.Name);
                  const pinned = pins.some((x) => x.path === p);
                  return (
                    <>
                      <div className="ctx-sep" />
                      <button
                        className="ctx-item"
                        onClick={() => {
                          pinned ? onUnpin(p) : onPin(p, menu.target!.Name);
                          setMenu(null);
                        }}
                      >
                        {pinned ? t("pane.ctx.unpin") : t("pane.ctx.pin")}
                      </button>
                    </>
                  );
                })()}
              {/* Dossier de depart : ouvre le serveur direct sur ce dossier a
                  chaque connexion. Toggle Definir <-> Reinitialiser selon que ce
                  dossier EST deja le depart. Serveur uniquement. */}
              {side === "remote" &&
                menu.target?.IsDir &&
                onSetStartDir &&
                (() => {
                  const p = joinDir(entriesDir, menu.target!.Name);
                  const norm = (x: string) => x.replace(/^\/+|\/+$/g, "");
                  const isStart = !!startDir && norm(p) === norm(startDir);
                  return (
                    <button
                      className="ctx-item"
                      title={
                        isStart
                          ? t("pane.ctx.startHereOffHint")
                          : t("pane.ctx.startHereHint")
                      }
                      onClick={() => {
                        onSetStartDir(isStart ? "" : p);
                        setMenu(null);
                      }}
                    >
                      {isStart ? t("pane.ctx.startHereOff") : t("pane.ctx.startHere")}
                    </button>
                  );
                })()}
              <div className="ctx-sep" />
              <button
                className="ctx-item"
                onClick={() => {
                  load(dir);
                  setMenu(null);
                }}
              >
                {t("pane.ctx.refresh")}
              </button>
            </>
          )}
        </div>
      )}

      {/* Rectangle de selection au lasso. */}
      {band &&
        scrollRef.current &&
        (() => {
          const sr = scrollRef.current.getBoundingClientRect();
          const left = Math.max(band.x0, sr.left);
          const top = Math.max(band.y0, sr.top);
          const right = Math.min(band.x1, sr.right);
          const bottom = Math.min(band.y1, sr.bottom);
          return (
            <div
              className="rubber-band"
              style={{
                left,
                top,
                width: Math.max(0, right - left),
                height: Math.max(0, bottom - top),
              }}
            />
          );
        })()}

      {/* Confirmation de suppression. */}
      {del && (
        <div className="modal-backdrop" onMouseDown={closeDel}>
          <div className="modal modal-confirm" onMouseDown={(e) => e.stopPropagation()}>
            <div className="modal-title">{t("pane.del.title")}</div>
            <div className="modal-body">
              {tx(side === "local" ? "pane.del.askLocal" : "pane.del.askRemote", {
                what: (
                  <strong>
                    {(() => {
                      const nDirs = del.filter((x) => x.IsDir).length;
                      const nFiles = del.length - nDirs;
                      return nDirs === 0
                        ? tn("pane.count.files", del.length)
                        : nFiles === 0
                          ? tn("pane.count.dirs", del.length)
                          : tn("pane.count.items", del.length);
                    })()}
                  </strong>
                ),
              })}
            </div>

            {/* Le chiffre qui fait renoncer quand on visait le mauvais dossier. */}
            <div className="modal-weight">
              {delInfo?.computing ? (
                <>
                  <span className="ctx-spinner" />
                  {t("pane.del.computing")}
                </>
              ) : delInfo ? (
                <>
                  <strong>
                    {delInfo.partial
                      ? t("pane.del.atLeast", { what: tn("pane.count.files", delInfo.count) })
                      : tn("pane.count.files", delInfo.count)}{" "}
                    · {humanSize(delInfo.bytes)}
                  </strong>
                  {delInfo.count > 0 && t("pane.del.permanent")}
                </>
              ) : null}
            </div>

            <div className="modal-actions">
              <button className="btn-ghost" onClick={closeDel}>
                {t("pane.del.no")}
              </button>
              <button className="btn-accent btn-danger" onClick={doDelete}>
                {t("pane.del.yes")}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
