import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { getCurrentWindow, ProgressBarStatus } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openPath } from "@tauri-apps/plugin-opener";
import "./App.css";
import {
  rc,
  humanSize,
  listArgs,
  fileAddr,
  joinDir,
  resolveRemoteStart,
  humanConnError,
  planItem,
  loadSettings,
  saveSettings,
  xferConfig,
  isFinal,
  hasBadChars,
  sanitizeName,
  fsKind,
  fsRemote,
  isUploadXfer,
  touchesPhone,
  PANES,
  type Loc,
  type PaneId,
  type PaneBus,
  type Payload,
  type Phone,
  type Server,
  type Settings,
  type Xfer,
  type EditItem,
} from "./files";
import { FilePane } from "./FilePane";
import { SettingsDialog } from "./SettingsDialog";
import { TransfersPanel, isStalled, type Tab, type XferSummary } from "./TransfersPanel";
import { JournalDialog } from "./JournalDialog";
import { logEvent } from "./journal";
import { useUpdater } from "./Updater";
import { getVersion } from "@tauri-apps/api/app";
import { UiIcon } from "./icons";
import { t, tn, tx, useLang } from "./i18n";
import { FirstRunLanguage } from "./i18n/LanguagePicker";
import { ConnectSheet, MorphButton, WinTitleBar } from "./WindowChrome";
import { PinDialog } from "./PinDialog";
import { SourcePicker, type SourceMenuItem } from "./SourcePicker";
import { useMacChrome, type MenuEntry as MacMenuEntry } from "./macChrome";
import "./chrome.css";

const appWindow = getCurrentWindow();
const isMac = navigator.userAgent.includes("Macintosh");
const isWin = navigator.userAgent.includes("Windows");
const isLinux = !isMac && !isWin;
const osName = isMac ? "macos" : isWin ? "windows" : "linux";

// Erreurs "reseau" : coupure du tunnel, 4G qui decroche, NAS qui redemarre…
// Elles declenchent la reprise AUTOMATIQUE. Tout le reste (droits refuses,
// disque plein, fichier introuvable) est un echec definitif : le reessayer en
// boucle ne servirait a rien.
// « Service Unavailable » (503) : le telephone vient d'etre debranche, ou il est
// momentanement occupe (cf. copiteur-mtp) — la reprise repart quand il revient.
const NETWORK_ERROR =
  /(connection|connexion|timeout|timed out|deadline|EOF|broken pipe|reset|unreachable|refused|no route|network|handshake|dial |lookup |i\/o error|closed|service unavailable|\b503\b)/i;

// Erreurs TRANSITOIRES cote rclone qui reussissent a la reprise. « can't move
// object - incompatible remotes » survient par intermittence sur un copyfile
// (rename du fichier .partial, avec des fs instancies sous des `_config`
// divergents en pleine concurrence) : constate ~25 fois sur 295, chaque fois OK
// au 2e essai. On la traite donc comme une coupure reseau : reprise auto.
// « didn't find section » : remote momentanement absent (daemon rclone relance,
// remote repose une seconde plus tard). « job not found » : le job a disparu
// avec un daemon relance — on relance la copie.
const RETRYABLE_ERROR =
  /(incompatible remotes|can't move object|can't copy|didn't find section|job not found)/i;

// Echec d'un telechargement DECOUPE en plusieurs flux (un des morceaux a casse).
const MULTI_THREAD_ERROR = /multi-thread copy/i;

// Echec qui sent le NOM DE FICHIER plutot que le reseau : la destination refuse
// d'ecrire ce nom (caracteres interdits sous Windows, par exemple).
const NAME_ERROR = /(invalid argument|illegal (byte sequence|character)|not permitted|cannot create)/i;

// « corrupted on transfer: md5 hashes differ src(...) "A" vs dst(...) "B" »
// Un md5 valide fait 32 caracteres hexadecimaux. Si l'un des deux cotes n'en est
// pas un (vide, ou une bribe de sortie de commande), ce n'est PAS une corruption :
// c'est que le serveur ne sait pas calculer d'empreinte. Constate sur un NAS
// de test, ou rclone lance `md5sum` par SSH — commande indisponible pour ce
// compte, donc reponse inexploitable, donc ECHEC DE TOUS LES TRANSFERTS.
// Reproduit et corrige en reel avec `--sftp-md5sum-command echo` : 0/6 fichiers
// sans le correctif, 6/6 avec.
const HASH_DIFFER = /hashes differ.*?\)\s*"([^"]*)"\s*vs\b.*?\)\s*"([^"]*)"/i;
const IS_MD5 = /^[0-9a-f]{32}$/i;
export function isBrokenHashSupport(err: string): boolean {
  const m = HASH_DIFFER.exec(err);
  if (!m) return false;
  // Deux vraies empreintes qui different = vraie corruption, on n'y touche pas.
  return !IS_MD5.test(m[1]) || !IS_MD5.test(m[2]);
}

// Attente avant la reprise : 3 s, 6 s, 12 s… plafonnee a 1 min. Laisse le temps
// au tunnel de se retablir sans marteler le serveur.
function backoff(attempts: number): number {
  return Math.min(60_000, 3_000 * 2 ** Math.max(0, attempts - 1));
}

// Reponse de `host_key_check` (cf. hostkeys.rs).
type HostKeyStatus = {
  status: "known" | "new" | "changed";
  algo: string;
  fingerprint: string;
  previous: string | null;
};
type HostKeyAsk = HostKeyStatus & { host: string; port: string };

// Ce que montre un panneau (avant resolution en adresses rclone, cf. `Loc`) :
// rien encore, l'ordinateur, un serveur memorise (par son nom) ou un telephone
// (par son identifiant USB).
type PaneSrc =
  | { kind: "none" }
  | { kind: "local" }
  | { kind: "server"; label: string }
  | { kind: "phone"; id: string; name: string };

// Une connexion a un serveur memorise. Chaque serveur a SON remote rclone
// (« srv1: », « srv2: »…) : deux serveurs peuvent ainsi etre ouverts en meme
// temps (un dans chaque panneau, copie serveur <-> serveur), et une copie en
// file garde son serveur meme si le panneau change de source.
type Conn = {
  label: string;
  remote: string;
  state: "connecting" | "ok" | "error";
  err: string;
  // Dossier d'ouverture resolu a la connexion (cf. resolveRemoteStart).
  startAt: string;
  // Incremente a chaque connexion reussie : remonte les panneaux qui affichent
  // ce serveur (relistage depuis le dossier d'ouverture).
  epoch: number;
  // Identifiants utilises (pour reecrire la config sans redemander).
  server: Server;
};

// Identite stable d'une source (cles d'acces rapide, remontage des panneaux).
function srcKey(s: PaneSrc): string {
  return s.kind === "server" ? `server:${s.label}` : s.kind === "phone" ? `phone:${s.id}` : s.kind;
}
// Cle localStorage des acces rapides d'une source. Celles des serveurs gardent
// leur ancien nom (« copiteur.pins.remote::<serveur> ») : rien n'est perdu a la
// mise a jour.
function pinStoreKey(key: string): string {
  if (key.startsWith("server:")) return `copiteur.pins.remote::${key.slice(7)}`;
  if (key.startsWith("phone:")) return `copiteur.pins.phone::${key.slice(6)}`;
  return "copiteur.pins.local";
}
function readPins(key: string): { label: string; path: string }[] {
  try {
    const v = JSON.parse(localStorage.getItem(pinStoreKey(key)) || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
// Panneaux ouverts au demarrage (sources memorisees). Un serveur n'est pas
// reconnecte tout seul : le panneau propose juste de le rouvrir.
function loadPaneSrcs(): Record<PaneId, PaneSrc> {
  const def: Record<PaneId, PaneSrc> = { left: { kind: "local" }, right: { kind: "none" } };
  try {
    const raw = JSON.parse(localStorage.getItem("copiteur.panes") || "null");
    if (!raw) return def;
    const ok = (v: unknown): v is PaneSrc => {
      const o = v as PaneSrc | null;
      return (
        !!o &&
        (o.kind === "none" ||
          o.kind === "local" ||
          (o.kind === "server" && typeof o.label === "string") ||
          (o.kind === "phone" && typeof o.id === "string" && typeof o.name === "string"))
      );
    };
    return { left: ok(raw.left) ? raw.left : def.left, right: ok(raw.right) ? raw.right : def.right };
  } catch {
    return def;
  }
}

export default function App() {
  // Re-rend toute l'app dans la nouvelle langue quand elle change.
  const lang = useLang();
  // Nom du disque local dans les panneaux et sur les lignes de transfert.
  const localLabel = isMac ? t("chrome.pane.yourMac") : t("common.yourPc");
  const localLabelRef = useRef(localLabel);
  localLabelRef.current = localLabel;
  // Panneaux exploitables (source choisie et prete), lus par le copier-coller
  // et la mise en file, qui sont memoises.
  const paneEnabled = useRef<Record<PaneId, boolean>>({ left: true, right: false });
  // Feuille de connexion (nouveau serveur, ou modification du serveur courant)
  // et renommage d'un serveur memorise.
  const [connectSheet, setConnectSheet] = useState<"new" | "edit" | null>(null);
  const [renameSrv, setRenameSrv] = useState<{ old: string; value: string } | null>(null);
  // Zone des transferts sous les panneaux : visible ou cachee EN ENTIER (bouton
  // Transferts de la barre du haut, ou chevron de l'îlot).
  const [xferOpen, setXferOpen] = useState(false);
  // L'utilisateur a cache la zone lui-meme : un nouveau lot ne la fait plus
  // reapparaitre (le bouton Transferts s'etire en pilule de progression).
  const userHidXfer = useRef(false);
  const [active, setActive] = useState<PaneId | null>("left");
  // Source de chaque panneau (memorisee d'une session a l'autre).
  const [srcs, setSrcs] = useState<Record<PaneId, PaneSrc>>(loadPaneSrcs);
  useEffect(() => {
    localStorage.setItem("copiteur.panes", JSON.stringify(srcs));
  }, [srcs]);
  // Connexions aux serveurs, par nom de serveur memorise.
  const [conns, setConns] = useState<Record<string, Conn>>({});
  const connsRef = useRef(conns);
  connsRef.current = conns;
  // Remote rclone attribue a chaque serveur pour la session (« srv1 »…). Stable :
  // une reconnexion reprend le meme, donc les transferts en file aussi.
  const remoteIds = useRef<Map<string, string>>(new Map());
  // Compteur (jamais reutilise) : un serveur oublie puis recree sous le meme
  // nom recoit un remote NEUF, aucune copie ou edition en cours de l'ancien ne
  // peut atterrir sur le nouveau.
  const remoteSeq = useRef(0);
  const remoteFor = (label: string): string => {
    let r = remoteIds.current.get(label);
    if (!r) {
      r = `srv${++remoteSeq.current}`;
      remoteIds.current.set(label, r);
    }
    return r;
  };
  // Telephones Android branches (macOS : copiteur-mtp ; vide ailleurs).
  const [phones, setPhones] = useState<Phone[]>([]);
  const [phonesSupported, setPhonesSupported] = useState(false);
  // Telephones deja annonces au journal depuis leur branchement (un telephone
  // debranche puis rebranche est annonce de nouveau).
  const announcedPhones = useRef<Set<string>>(new Set());
  // Panneau vise par la feuille de connexion (« Ajouter un serveur… » ou
  // « Modifier ce serveur… » depuis son selecteur) et serveur qu'elle connecte.
  const [sheetPane, setSheetPane] = useState<PaneId>("right");
  const [sheetLabel, setSheetLabel] = useState<string | null>(null);
  const [version, setVersion] = useState("");
  // Compteur de « vies » du daemon rclone : incremente a chaque relance, il sert
  // a repousser la config globale de transfert, perdue avec l'ancien process.
  const [daemonEpoch, setDaemonEpoch] = useState(0);
  // Message ponctuel en haut de la fenetre (ex. deconnexion refusee pendant une
  // copie). S'efface tout seul.
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(""), 6000);
    return () => clearTimeout(id);
  }, [notice]);
  const [xfers, setXfers] = useState<Xfer[]>([]);
  const [tab, setTab] = useState<Tab>("queue");
  // Fichiers distants ouverts pour edition (surveilles localement).
  const [edits, setEdits] = useState<EditItem[]>([]);
  // Confirmation « le fichier a change, le renvoyer ? » (un fichier a la fois).
  const [editAsk, setEditAsk] = useState<{ id: number; label: string } | null>(
    null,
  );
  // Avertissement de conflit : le fichier a change (ou disparu) SUR LE SERVEUR
  // depuis l'ouverture, avant qu'on renvoie.
  const [conflictAsk, setConflictAsk] = useState<{
    e: EditItem;
    reason: "changed" | "deleted";
  } | null>(null);
  const editSeq = useRef(0);
  // Nombre d'elements en cours d'analyse (un dossier depose est liste
  // recursivement avant d'entrer dans la file).
  const [preparing, setPreparing] = useState(0);
  // Battement : reveille l'ordonnanceur et le suivi tant qu'il reste du travail
  // (y compris quand tout est en attente de reprise, donc sans job actif).
  const [tick, setTick] = useState(0);
  // Debit agrege LISSE de la barre globale (octets/s), mesure par nos soins sur
  // une fenetre glissante plutot que somme des debits par fichier de rclone.
  const [smoothSpeed, setSmoothSpeed] = useState(0);
  const [clipboardReady, setClipboardReady] = useState(false);

  const [host, setHost] = useState("");
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [port, setPort] = useState("");
  // Nom FACULTATIF donne a la connexion : s'il est rempli, le serveur memorise
  // prend ce libelle (au lieu du « user@host » par defaut). La feuille de
  // connexion le montre a cote des 4 autres champs ; en modification, il garde
  // le nom du serveur, qui est donc mis a jour au lieu d'etre duplique.
  const [name, setName] = useState("");
  // Code PIN de la feuille : case « demander un code » + le code. En
  // modification d'un serveur protege, pre-remplis avec le code qui vient de
  // le deverrouiller.
  const [pinOn, setPinOn] = useState(false);
  const [sheetPin, setSheetPin] = useState("");
  // Etat du code a l'ouverture de « Modifier… » : s'il n'a pas bouge, on
  // n'envoie rien (sinon le backend refait la derivation lente pour rien).
  const sheetPinOrig = useRef<{ label: string; on: boolean; pin: string } | null>(null);
  // Demande de code PIN en cours (ouvrir ou modifier un serveur protege).
  const [pinAsk, setPinAsk] = useState<{
    label: string;
    onOk: (pass: string, pin: string) => void;
  } | null>(null);
  const [servers, setServers] = useState<Server[]>([]);
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [showSettings, setShowSettings] = useState(false);
  const [showJournal, setShowJournal] = useState(false);
  // Ref pour lire les reglages courants dans les callbacks memoises.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // Accès rapide (dossiers épinglés), CLOISONNE PAR SOURCE : l'ordinateur, chaque
  // serveur, chaque telephone — les chemins n'ont aucun sens de l'un a l'autre.
  // Charge a la demande depuis localStorage (cf. pinStoreKey), sauve a chaque
  // changement.
  type Pin = { label: string; path: string };
  const [pins, setPins] = useState<Record<string, Pin[]>>(() => ({ local: readPins("local") }));
  const pinsFor = (key: string): Pin[] => pins[key] ?? readPins(key);
  const updatePins = useCallback((key: string, fn: (cur: Pin[]) => Pin[]) => {
    setPins((p) => {
      const cur = p[key] ?? readPins(key);
      const next = fn(cur);
      if (next === cur) return p;
      localStorage.setItem(pinStoreKey(key), JSON.stringify(next));
      return { ...p, [key]: next };
    });
  }, []);

  // Conflit de copie (fichier deja present a destination).
  const [conflict, setConflict] = useState<{ name: string } | null>(null);
  const [conflictAll, setConflictAll] = useState(false);
  const conflictResolver = useRef<
    ((r: { action: "replace" | "ignore"; all: boolean }) => void) | null
  >(null);

  const jobSeq = useRef(0);
  // Borne basse (id) du LOT en cours, pour que la progression globale ne compte
  // que le lot courant. Les transferts termines restent dans `xfers` (onglet
  // Terminés) jusqu'a un nettoyage manuel : sans cette borne, un nouveau lot
  // demarrerait a un pourcentage fausse par les octets d'un lot precedent. Elle
  // est recalee sur le dernier id attribue chaque fois que la file se vide (cf.
  // l'effet lie a `pending`), si bien que le lot suivant repart de zero.
  const batchAnchorRef = useRef(0);
  // Un transfert relance garde son id d'ORIGINE, qui peut etre inferieur a
  // l'ancre du lot courant (posee quand la file s'est videe, apres un echec ou
  // une annulation) : il serait alors exclu du calcul de progression (« 0 % »,
  // « restant » a 0, alors que la copie tourne). Toute remise en file passe
  // donc par ici, qui abaisse l'ancre juste sous le plus petit id relance.
  const rejoinBatch = (ids: Iterable<number>) => {
    const minId = Math.min(...ids);
    if (Number.isFinite(minId))
      batchAnchorRef.current = Math.min(batchAnchorRef.current, minId - 1);
  };
  const noop = () => {};
  const panes = useRef<Record<PaneId, PaneBus>>({
    left: { pane: "left", loc: { kind: "local", remote: "", key: "local", label: "" }, dir: "/", selected: [], refresh: noop, clearSelection: noop, selectAll: noop },
    right: { pane: "right", loc: { kind: "local", remote: "", key: "local", label: "" }, dir: "/", selected: [], refresh: noop, clearSelection: noop, selectAll: noop },
  });
  const clipboard = useRef<Payload | null>(null);
  const busyRef = useRef(false);

  // Donner le focus a un volet NE TOUCHE PAS a la selection de l'autre : on
  // selectionne a gauche, on va naviguer a droite jusqu'au bon dossier, et la
  // selection de gauche est toujours la (affichee en gris, panneau inactif).
  // Les raccourcis (copier, coller, supprimer…) visent le panneau actif.
  const focusPane = (pane: PaneId) => {
    setActive(pane);
  };
  busyRef.current = xfers.some((x) => !isFinal(x));
  // Idem pour les dossiers en cours d'eclatement (pas encore des transferts).
  const preparingRef = useRef(0);
  preparingRef.current = preparing;
  // Editions avec des modifs PAS ENCORE renvoyees sur le serveur : la fermeture
  // doit prevenir avant de les perdre.
  const editsPendingRef = useRef(0);
  editsPendingRef.current = edits.filter((e) => e.state !== "watching").length;
  // Confirmation avant fermeture quand des transferts tournent encore.
  const [closeAsk, setCloseAsk] = useState(false);
  // Identite du serveur a confirmer (1re connexion, ou cle qui a change). La
  // connexion attend la reponse : `hostKeyResolve` debloque sa promesse.
  const [hostKeyAsk, setHostKeyAsk] = useState<HostKeyAsk | null>(null);
  const hostKeyResolve = useRef<((ok: boolean) => void) | null>(null);
  const askHostKey = (a: HostKeyAsk) =>
    new Promise<boolean>((resolve) => {
      hostKeyResolve.current = resolve;
      setHostKeyAsk(a);
    });
  const answerHostKey = (ok: boolean) => {
    hostKeyResolve.current?.(ok);
    hostKeyResolve.current = null;
    setHostKeyAsk(null);
  };

  // macOS : l'app tourne encore depuis son .dmg monte (pas glissee dans
  // Applications) — on propose de la deplacer. `null` = pas concerne (autre
  // OS, ou deja dans Applications).
  const [dmgMount, setDmgMount] = useState<string | null>(null);
  const [dmgMoving, setDmgMoving] = useState(false);
  useEffect(() => {
    invoke<string | null>("mac_dmg_mount")
      .then(setDmgMount)
      .catch(() => {});
  }, []);

  // « Ce nom a été refusé — le nettoyer et réessayer ? ». Le choix « pour tous »
  // ne vaut QUE pour la salve courante : il se remet a zero des qu'il n'y a
  // plus aucun echec de nom en attente (cf. l'effet plus bas).
  const [renameAsk, setRenameAsk] = useState<Xfer | null>(null);
  const [renameAll, setRenameAll] = useState(false);
  // La DECISION « appliquer a tous », posee au clic sur le bouton. Distincte de
  // l'etat de la case a cocher ci-dessus, qu'on doit pouvoir cocher/decocher
  // librement avant de valider.
  const renameAllRef = useRef(false);

  // Miroir pour lire l'etat courant depuis les timers sans les recreer.
  const xfersRef = useRef(xfers);
  xfersRef.current = xfers;
  // Echantillons { t, octets cumules } pour le debit agrege sur fenetre
  // glissante ; `emaSpeedRef` porte la moyenne exponentielle affichee.
  const speedSamplesRef = useRef<{ t: number; b: number }[]>([]);
  const emaSpeedRef = useRef(0);
  const editsRef = useRef(edits);
  editsRef.current = edits;
  const activeRef = useRef(active);
  activeRef.current = active;
  // Serveurs (par remote, « srv2 ») qui se sont reveles incapables de calculer
  // des empreintes : leur connexion a ete basculee en `disable_hashcheck`. Un
  // seul basculement par connexion.
  const noHashRef = useRef<Set<string>>(new Set());
  // Plafond de flux en TELECHARGEMENT par serveur source (absent = le reglage).
  // Abaisse quand un telechargement multi-flux casse (lien qui ne suit pas : VPN,
  // Tailscale, 4G, NAS au processeur modeste), pour que les fichiers suivants
  // partent directement avec moins de flux au lieu d'echouer chacun a leur
  // tour. Remis a zero a chaque connexion de ce serveur.
  const downCapRef = useRef<Record<string, number>>({});
  // Serveurs dont la connexion sans empreinte est REELLEMENT en place (config
  // reecrite + cache vide). C'est le signal qui autorise la relance.
  const [noHashReady, setNoHashReady] = useState<string[]>([]);
  // Jeton de tentative de connexion PAR SERVEUR. Chaque tentative l'incremente et
  // INVALIDE la precedente : si un serveur ne repond pas (dial SFTP qui pend),
  // relancer repart immediatement et seule la DERNIERE tentative a le droit
  // d'ecrire l'etat (connecte / erreur).
  const connSeq = useRef<Record<string, number>>({});

  // Couleur d'accent systeme : le backend la lit (macOS ET Windows — le mot-cle
  // CSS `AccentColor` ne reflete pas le vrai accent dans WebView2). Relue au
  // retour de focus : si l'accent change dans les reglages de l'OS pendant que
  // l'app tourne, elle suit sans redemarrage.
  useEffect(() => {
    const applyAccent = () =>
      invoke<string | null>("get_accent_color")
        .then((hex) => {
          if (!hex) return;
          const root = document.documentElement;
          root.style.setProperty("--cp-accent", hex);
          // Texte pose SUR l'accent : noir ou blanc selon la luminance, sinon
          // du blanc sur un accent clair (jaune...) devient illisible.
          const [r, g, b] = [1, 3, 5].map((i) =>
            parseInt(hex.slice(i, i + 2), 16),
          );
          const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
          root.style.setProperty("--cp-accent-text", lum > 0.6 ? "#000000" : "#ffffff");
        })
        .catch(() => {});

    applyAccent();
    window.addEventListener("focus", applyAccent);
    return () => window.removeEventListener("focus", applyAccent);
  }, []);

  // Fermeture : si des transferts tournent (ou des dossiers sont en cours
  // d'eclatement), on intercepte pour confirmer. `close()` — le bouton custom
  // comme la fermeture native (Alt+F4, feux macOS) — passe par cet evenement ;
  // seul `destroy()` le contourne, on l'appelle donc pour fermer pour de bon.
  useEffect(() => {
    const unlisten = appWindow.onCloseRequested((e) => {
      if (
        busyRef.current ||
        preparingRef.current > 0 ||
        editsPendingRef.current > 0
      ) {
        e.preventDefault();
        setCloseAsk(true);
      }
    });
    return () => {
      unlisten.then((off) => off());
    };
  }, []);

  // Cmd+Q (macOS) quitte l'APPLICATION sans passer par `onCloseRequested`
  // ci-dessus : le noyau Rust l'intercepte a notre place, mais il lui faut
  // savoir s'il reste du travail. On lui pousse l'etat a chaque changement, et
  // on ouvre la meme modale quand il nous le demande.
  const anyBusy =
    xfers.some((x) => !isFinal(x)) ||
    preparing > 0 ||
    edits.some((e) => e.state !== "watching");
  useEffect(() => {
    invoke("set_busy", { busy: anyBusy }).catch(() => {});
  }, [anyBusy]);

  // Version de l'app (tauri.conf.json), affichee dans la barre de titre.
  const [appVersion, setAppVersion] = useState("");
  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => {});
  }, []);

  // Mise a jour integree : verification au demarrage + bouton des parametres.
  const updater = useUpdater({
    current: appVersion,
    busy: anyBusy,
    autoCheck: settings.checkUpdates,
    log: (level, msg) => logEvent(level, "app", msg),
  });

  // Une modale/dialogue est ouverte : tant que c'est le cas, AUCUNE action ne
  // doit passer au clavier (ouvrir un fichier, supprimer, copier/coller,
  // naviguer…). La souris est deja bloquee par le fond des modales ; on coupe le
  // clavier des panneaux (prop passee aux FilePane) et les raccourcis globaux
  // ci-dessous. La confirmation de suppression, interne au FilePane, se garde
  // toute seule via un ecouteur `window`.
  const anyModal =
    showSettings ||
    showJournal ||
    !!conflict ||
    !!renameAsk ||
    closeAsk ||
    !!hostKeyAsk ||
    !!pinAsk ||
    !!editAsk ||
    !!conflictAsk ||
    !!dmgMount ||
    updater.open;

  useEffect(() => {
    const unlisten = listen("copiteur://close-ask", () => setCloseAsk(true));
    return () => {
      unlisten.then((off) => off());
    };
  }, []);

  // Panne cote backend qui ne passe pas par le retour d'une commande (ex. echec
  // d'ecriture de la liste des serveurs). Sans ca, l'utilisateur croit son
  // serveur memorise et le retrouve disparu au redemarrage, sans aucune trace.
  useEffect(() => {
    const unlisten = listen<string>("copiteur://backend-error", (e) => {
      logEvent("error", "app", String(e.payload));
    });
    return () => {
      unlisten.then((off) => off());
    };
  }, []);

  // Un CHAMP texte a-t-il le focus ? Cliquer dans un champ (barre de connexion,
  // adresse…) se fait « hors des panneaux », ce qui met `active` a null. Il faut
  // quand meme garder l'entree de menu Cmd+A active dans ce cas, sinon macOS
  // grise l'item et Cmd+A ne selectionne PAS le texte du champ (l'accelerateur
  // Cmd+A appartient a cet item custom, il n'y a pas de fallback natif).
  const [fieldFocused, setFieldFocused] = useState(false);
  useEffect(() => {
    const isField = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA");
    };
    const onIn = (e: FocusEvent) => isField(e.target) && setFieldFocused(true);
    const onOut = (e: FocusEvent) => isField(e.target) && setFieldFocused(false);
    document.addEventListener("focusin", onIn);
    document.addEventListener("focusout", onOut);
    return () => {
      document.removeEventListener("focusin", onIn);
      document.removeEventListener("focusout", onOut);
    };
  }, []);

  // « Tout sélectionner » du menu macOS : il vise les FICHIERS du panneau
  // actif, OU le texte du champ focalise (cf. le listener plus bas). On grise
  // l'entree seulement quand NI panneau NI champ n'a le focus — la, sans cible,
  // l'action n'aurait aucun sens.
  useEffect(() => {
    invoke("set_pane_active", {
      active: active !== null || fieldFocused,
    }).catch(() => {});
  }, [active, fieldFocused]);

  useEffect(() => {
    const unlisten = listen("copiteur://select-all", () => {
      // Cmd+A passe par ce menu natif custom. Si le focus est dans un CHAMP
      // texte (barre de connexion, barre d'adresse, renommage…), il doit
      // selectionner le TEXTE du champ, pas les fichiers du panneau — sinon
      // Cmd+A serait inutilisable dans les champs.
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) {
        (el as HTMLInputElement).select();
        return;
      }
      if (activeRef.current) panes.current[activeRef.current].selectAll();
    });
    return () => {
      unlisten.then((off) => off());
    };
  }, []);

  useEffect(() => {
    rc<{ version: string }>("core/version")
      .then((v) => setVersion(v.version))
      .catch(() => setVersion(t("app.rclone.unreachable")));
  }, []);

  // Reglages de transfert poses GLOBALEMENT sur le daemon (bloc « main »), une
  // fois, au lieu d'un `_config` a chaque copyfile. Un `_config` par job faisait
  // diverger les instances de fs entre la copie et le renommage du fichier
  // « .partial » : rclone jugeait alors les deux « incompatible remotes » et le
  // renommage echouait par intermittence (~25/295 sur une grosse copie). En
  // config globale, copie ET renommage partagent le meme contexte -> plus de
  // divergence. Depend de `version` : des que le daemon repond (au demarrage) ou
  // que les reglages changent, on (re)pousse. Depend AUSSI de `daemonEpoch` : un
  // daemon relance (crash, process tue) repart avec les reglages par defaut, car
  // cette config vit en MEMOIRE dans rclone, pas dans son fichier de config.
  useEffect(() => {
    rc("options/set", { main: xferConfig(settings) }).catch(() => {});
  }, [settings, version, daemonEpoch]);

  // Le backend a du relancer le daemon rclone : on le trace (c'est anormal) et
  // on repousse la config globale ci-dessus.
  useEffect(() => {
    const unlisten = listen("copiteur://rclone-relance", () => {
      logEvent("warn", "app", t("app.log.rcloneRestarted"));
      setDaemonEpoch((n) => n + 1);
      // Sa config (les remotes des serveurs) vivait en memoire et a disparu
      // avec lui : on repose celle de chaque serveur connecte. (Les telephones,
      // eux, sont reposes par le backend, cf. mtp.rs.)
      reconfigureRef.current();
    });
    return () => {
      unlisten.then((off) => off());
    };
  }, []);

  // Charge les serveurs memorises au demarrage.
  useEffect(() => {
    invoke<Server[]>("list_servers")
      .then(setServers)
      .catch(() => setServers([]));
  }, []);

  // Amorce l'accès rapide local avec les dossiers systeme (une seule fois).
  // Leurs libelles (Bureau/Desktop…) viennent du backend, dans la langue
  // courante : au changement de langue, on renomme les pins amorces que
  // l'utilisateur n'a pas renommes (libelle encore egal a celui du chargement
  // precedent, garde dans `quickRoots`).
  const quickRoots = useRef<Pin[] | null>(null);
  useEffect(() => {
    invoke<{ label: string; path: string; kind: string }[]>("local_roots")
      .then((rs) => {
        const quick = rs
          .filter((r) => r.kind === "quick")
          .map((r) => ({ label: r.label, path: r.path }));
        const prev = quickRoots.current;
        quickRoots.current = quick;
        if (!localStorage.getItem("copiteur.pins.seeded")) {
          updatePins("local", () => quick);
          localStorage.setItem("copiteur.pins.seeded", "1");
          return;
        }
        if (!prev) return;
        updatePins("local", (cur) => {
          let changed = false;
          const next = cur.map((pin) => {
            const old = prev.find((r) => r.path === pin.path);
            const now = quick.find((r) => r.path === pin.path);
            if (old && now && pin.label === old.label && now.label !== pin.label) {
              changed = true;
              return { ...pin, label: now.label };
            }
            return pin;
          });
          return changed ? next : cur;
        });
      })
      .catch(() => {});
  }, [lang, updatePins]);

  // `key` = identite de la source (cf. srcKey) : chaque source a ses epingles.
  const pinFolder = useCallback(
    (key: string, path: string, label: string) =>
      updatePins(key, (cur) =>
        cur.some((x) => x.path === path) ? cur : [...cur, { label, path }],
      ),
    [updatePins],
  );
  const unpinFolder = useCallback(
    (key: string, path: string) =>
      updatePins(key, (cur) =>
        cur.some((x) => x.path === path) ? cur.filter((x) => x.path !== path) : cur,
      ),
    [updatePins],
  );
  // Reordonne l'acces rapide : insere `from` avant/apres `to` (index recalcule
  // APRES retrait pour rester coherent quand from est avant to).
  const reorderPins = useCallback(
    (key: string, from: string, to: string, after: boolean) =>
      updatePins(key, (cur) => {
        const arr = [...cur];
        const fi = arr.findIndex((x) => x.path === from);
        if (fi < 0) return cur;
        const [moved] = arr.splice(fi, 1);
        const ti = arr.findIndex((x) => x.path === to);
        if (ti < 0) return cur;
        arr.splice(ti + (after ? 1 : 0), 0, moved);
        return arr;
      }),
    [updatePins],
  );

  // ---- Sources des panneaux -------------------------------------------------
  // Met une source dans un panneau (sans rien toucher si c'est deja elle).
  const setPaneSrc = useCallback((pane: PaneId, src: PaneSrc) => {
    setSrcs((cur) => (srcKey(cur[pane]) === srcKey(src) ? cur : { ...cur, [pane]: src }));
  }, []);

  // Repose dans rclone le remote de chaque serveur connecte (apres une relance
  // du daemon, dont la config vit en memoire). Sans la sonde ni la cle d'hote :
  // ces serveurs ont deja ete verifies a la connexion.
  const reconfigureRef = useRef<() => void>(() => {});
  reconfigureRef.current = () => {
    for (const c of Object.values(connsRef.current)) {
      if (c.state !== "ok") continue;
      const name = c.remote.replace(/:$/, "");
      rc("config/create", {
        name,
        type: "sftp",
        parameters: {
          host: c.server.host,
          user: c.server.user,
          pass: c.server.pass,
          port: c.server.port || "22",
          concurrency: String(settingsRef.current.sftpConcurrency),
          ...(noHashRef.current.has(name) ? { disable_hashcheck: "true" } : {}),
        },
        opt: { obscure: true },
      }).catch(() => {});
    }
  };

  // ---- Connexion aux serveurs ----------------------------------------------
  // Connecte un serveur (memorise, ou saisi dans la feuille) et l'affiche dans
  // `pane`. Deja connecte : on l'affiche simplement (les deux panneaux peuvent
  // montrer le meme serveur). `force` refait la connexion (identifiants
  // modifies, nouvelle tentative apres un echec).
  // `fromSheet` : connexion lancee par la feuille (nouveau serveur, ou serveur
  // modifie) — le panneau ne bascule qu'une fois connecte ; d'ici la, la
  // feuille montre l'attente et l'erreur, et le panneau garde ce qu'il affichait.
  // `pin` (feuille seulement) : protection a enregistrer avec le serveur — ""
  // = aucune, un code = proteger par ce code. Hors feuille : inchangee.
  const connectServer = async (
    s: Server,
    pane: PaneId,
    force = false,
    fromSheet = false,
    pin: string | null = null,
  ) => {
    const label = s.label;
    if (!fromSheet) {
      setPaneSrc(pane, { kind: "server", label });
      setActive(pane);
    }
    const existing = connsRef.current[label];
    if (!force && existing && (existing.state === "ok" || existing.state === "connecting")) return;
    const remote = remoteFor(label);
    const fsName = remote + ":";
    // Cette tentative PREND LA MAIN sur ce serveur : toute tentative precedente
    // encore en vol devient caduque et n'ecrira plus rien.
    const seq = (connSeq.current[label] ?? 0) + 1;
    connSeq.current[label] = seq;
    const current = () => connSeq.current[label] === seq;
    const h = s.host;
    const u = s.user;
    const p = s.pass;
    const pt = s.port || "22";
    // Nouvelle connexion : on refait confiance a ses empreintes et a son debit.
    // Si elles sont cassees, le premier echec le revelera et on rebasculera.
    noHashRef.current.delete(remote);
    setNoHashReady((r) => r.filter((x) => x !== remote));
    delete downCapRef.current[fsName];
    const memStart = s.startDir ?? servers.find((x) => x.label === label)?.startDir ?? "";
    setConns((c) => ({
      ...c,
      [label]: {
        label,
        remote: fsName,
        state: "connecting",
        err: "",
        startAt: c[label]?.startAt ?? "/",
        epoch: c[label]?.epoch ?? 0,
        server: { label, host: h, user: u, pass: p, port: pt, startDir: memStart },
      },
    }));
    const fail = (msg: string) => {
      if (!current()) return;
      setConns((c) => (c[label] ? { ...c, [label]: { ...c[label], state: "error", err: msg } } : c));
    };
    try {
      // Identite du serveur AVANT tout envoi du mot de passe : sa cle doit etre
      // celle deja acceptee, sinon l'utilisateur tranche (cf. hostkeys.rs).
      const hk = await invoke<HostKeyStatus>("host_key_check", { host: h, port: pt });
      if (!current()) return;
      if (hk.status !== "known") {
        const ok = await askHostKey({ ...hk, host: h, port: pt });
        if (!current()) return;
        if (!ok) {
          fail(t("app.conn.hostKeyRefused"));
          logEvent(
            "warn",
            "connexion",
            t("app.log.hostKeyRefused", {
              host: h,
              kind: t(hk.status === "changed" ? "app.log.kindChanged" : "app.log.kindNew"),
              fp: hk.fingerprint,
            }),
          );
          return;
        }
        await invoke("host_key_trust", { host: h, port: pt });
        logEvent(
          hk.status === "changed" ? "warn" : "info",
          "connexion",
          t(hk.status === "changed" ? "app.log.keyAccepted" : "app.log.keyStored", {
            host: h,
            algo: hk.algo,
            fp: hk.fingerprint,
          }),
        );
      }
      await rc("config/create", {
        name: remote,
        type: "sftp",
        parameters: {
          host: h,
          user: u,
          pass: p,
          port: pt,
          concurrency: String(settingsRef.current.sftpConcurrency),
        },
        opt: { obscure: true },
      });
      if (!current()) return;
      // rclone garde en cache la connexion (Fs) sous ce nom : apres une
      // modification des identifiants, sans purge, il reutiliserait l'ancienne.
      // (Les copies en cours gardent leur propre connexion : rien n'est coupe.)
      await rc("fs/cache/clear").catch(() => {});
      if (!current()) return;
      // SONDE BORNEE avant de declarer la connexion etablie. Sans ca, un serveur
      // injoignable laissait le panneau tourner en boucle : le dial SFTP peut
      // pendre jusqu'a ConnectTimeout (30s en config globale) x 6 relistages du
      // panneau ~= 3 min. Ici on teste AVANT, avec un `_config` court
      // (ConnectTimeout borne le dial) et sans relance (LowLevelRetries=1),
      // double d'un garde-fou JS au cas ou rclone ignorerait la borne.
      const probe = rc("operations/list", {
        fs: fsName,
        remote: "",
        opt: { noModTime: true },
        _config: { ConnectTimeout: "12s", Timeout: "12s", LowLevelRetries: 1 },
      });
      // Sonde en vol qui rejette APRES le garde-fou : on avale sa rejection pour
      // eviter un « unhandled rejection » (le resultat est de toute facon ignore).
      probe.catch(() => {});
      let timer: ReturnType<typeof setTimeout>;
      const timeout = new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error(t("app.conn.timeout"))), 14000);
      });
      try {
        await Promise.race([probe, timeout]);
      } finally {
        clearTimeout(timer!);
      }
      if (!current()) return;
      // Dossier d'ouverture : dossier de depart memorise (si lisible) -> racine
      // de partages detectee -> "/". Resolu MAINTENANT (connexion live) et pose
      // AVANT de declarer la connexion etablie, pour que le panneau s'ouvre
      // directement au bon endroit.
      const startAt = await resolveRemoteStart(fsName, memStart);
      if (!current()) return;
      setConns((c) =>
        c[label]
          ? { ...c, [label]: { ...c[label], state: "ok", err: "", startAt, epoch: c[label].epoch + 1 } }
          : c,
      );
      if (fromSheet) {
        setPaneSrc(pane, { kind: "server", label });
        setActive(pane);
      }
      logEvent("info", "connexion", t("app.log.connected", { target: `${u}@${h}:${pt}` }));
      // Enregistre / met a jour le serveur (label = nom donne, ou user@host).
      // A part : un refus d'enregistrer (code PIN) ne doit pas faire passer
      // pour ratee une connexion qui, elle, a reussi.
      try {
        const saved = await invoke<Server[]>("save_server", {
          server: { label, host: h, user: u, pass: p, port: pt, startDir: memStart },
          pin: fromSheet ? pin : null,
        });
        setServers(saved);
      } catch (e) {
        setNotice(String(e));
        logEvent("error", "connexion", String(e));
      }
    } catch (e) {
      // Une tentative plus recente a pris la main : on se tait, c'est elle qui
      // decide desormais (ne pas ecraser son resultat avec notre echec).
      if (!current()) return;
      fail(humanConnError(String(e)));
      logEvent("error", "connexion", t("app.log.connFailed", { target: `${u}@${h}`, err: String(e) }));
    }
  };

  // Ouvre un serveur memorise. Protege par un code PIN : on le demande, sauf
  // si sa connexion de ce lancement est encore la (son mot de passe est alors
  // deja connu : une reconnexion apres une coupure ne redemande rien).
  const openServer = (s: Server, pane: PaneId, force: boolean) => {
    const c = connsRef.current[s.label];
    if (!s.locked) return void connectServer(s, pane, force);
    if (c) return void connectServer({ ...s, pass: c.server.pass }, pane, force);
    setPinAsk({
      label: s.label,
      onOk: (pass) => {
        setPinAsk(null);
        connectServer({ ...s, pass }, pane, force);
      },
    });
  };
  // Ouvre un serveur memorise dans un panneau (selecteur de source). Une
  // connexion en echec est retentee.
  const pickServer = (s: Server, pane: PaneId) => {
    const c = connsRef.current[s.label];
    openServer(s, pane, !!c && c.state === "error");
  };
  const deleteServer = (label: string) => {
    invoke<Server[]>("delete_server", { label }).then(setServers).catch(() => {});
  };
  // Definit (ou efface, avec "") le dossier de depart d'un serveur. Persiste sur
  // le serveur memorise ; prend effet a la prochaine connexion.
  const setStartDir = (label: string, path: string) => {
    const cur = servers.find((x) => x.label === label);
    if (!cur) return;
    invoke<Server[]>("save_server", { server: { ...cur, startDir: path } })
      .then(setServers)
      .catch(() => {});
    setConns((c) =>
      c[label] ? { ...c, [label]: { ...c[label], server: { ...c[label].server, startDir: path } } } : c,
    );
  };
  // Une copie (en file ou en cours) passe-t-elle par ce remote ?
  const remoteBusy = (remote: string) =>
    xfersRef.current.some(
      (x) => !isFinal(x) && (fsRemote(x.srcFs) === remote || fsRemote(x.dstFs) === remote),
    );
  // Renomme un serveur memorise. On migre au passage ses dossiers epingles
  // (cloisonnes par nom), sa connexion et les panneaux qui l'affichent.
  const renameServer = (oldLabel: string, newLabel: string) => {
    if (newLabel === oldLabel) return;
    // Nom deja pris : le backend refuserait, mais la liste qu'il renvoie
    // contient alors l'AUTRE serveur sous ce nom — on ne doit surtout pas
    // migrer (le panneau « B » viserait le serveur A).
    if (servers.some((s) => s.label === newLabel)) {
      setNotice(t("app.notice.nameTaken", { name: newLabel }));
      return;
    }
    // Connexion en cours : elle ecrirait sous l'ancien nom. On attend.
    if (connsRef.current[oldLabel]?.state === "connecting") {
      setNotice(t("app.notice.renameWait"));
      return;
    }
    invoke<Server[]>("rename_server", { oldLabel, newLabel })
      .then((saved) => {
        setServers(saved);
        // La migration n'a lieu que si le backend a bien applique le renommage
        // (l'ancien nom a disparu, le nouveau est la).
        if (saved.some((s) => s.label === oldLabel) || !saved.some((s) => s.label === newLabel)) return;
        const old = localStorage.getItem(pinStoreKey(`server:${oldLabel}`));
        if (old !== null) {
          localStorage.setItem(pinStoreKey(`server:${newLabel}`), old);
          localStorage.removeItem(pinStoreKey(`server:${oldLabel}`));
        }
        setPins((p) => {
          const n = { ...p };
          delete n[`server:${oldLabel}`];
          delete n[`server:${newLabel}`];
          return n;
        });
        const rid = remoteIds.current.get(oldLabel);
        if (rid) {
          remoteIds.current.delete(oldLabel);
          remoteIds.current.set(newLabel, rid);
        }
        connSeq.current[newLabel] = connSeq.current[oldLabel] ?? 0;
        setConns((c) => {
          if (!c[oldLabel]) return c;
          const n = { ...c };
          n[newLabel] = {
            ...c[oldLabel],
            label: newLabel,
            server: { ...c[oldLabel].server, label: newLabel },
          };
          delete n[oldLabel];
          return n;
        });
        setSrcs((cur) => {
          let changed = false;
          const n = { ...cur };
          for (const k of PANES) {
            const v = cur[k];
            if (v.kind === "server" && v.label === oldLabel) {
              n[k] = { kind: "server", label: newLabel };
              changed = true;
            }
          }
          return changed ? n : cur;
        });
        setName((n) => (n === oldLabel ? newLabel : n));
      })
      .catch(() => {});
  };

  // Se deconnecter d'un serveur (menu de son panneau). Refuse tant qu'une copie
  // passe par lui. Les panneaux qui l'affichaient reviennent a « aucune source ».
  const disconnectServer = (label: string): boolean => {
    const c = connsRef.current[label];
    if (c && (remoteBusy(c.remote) || preparingRef.current > 0)) {
      setNotice(t("chrome.conn.busy"));
      return false;
    }
    connSeq.current[label] = (connSeq.current[label] ?? 0) + 1;
    // Serveur protege : son code sera redemande a la prochaine ouverture.
    invoke("lock_server", { label }).catch(() => {});
    setConns((cur) => {
      if (!cur[label]) return cur;
      const n = { ...cur };
      delete n[label];
      return n;
    });
    setSrcs((cur) => {
      let changed = false;
      const n = { ...cur };
      for (const k of PANES) {
        const v = cur[k];
        if (v.kind === "server" && v.label === label) {
          n[k] = { kind: "none" };
          changed = true;
        }
      }
      return changed ? n : cur;
    });
    if (c) {
      rc("fs/cache/clear").catch(() => {});
      logEvent("info", "connexion", t("app.log.disconnected", { name: label }));
    }
    return true;
  };
  // Oublier un serveur : il est d'abord deconnecte (refuse pendant une copie).
  const forgetServer = (label: string) => {
    if (!disconnectServer(label)) return;
    const r = remoteIds.current.get(label);
    remoteIds.current.delete(label);
    // Un Cmd+V apres « Oublier » ne doit plus rien copier depuis ce serveur.
    if (r && clipboard.current?.loc.remote === r + ":") {
      clipboard.current = null;
      setClipboardReady(false);
    }
    deleteServer(label);
  };

  // Feuille « Nouvelle connexion » sur des champs vides, pour un panneau.
  const newConnection = (pane: PaneId) => {
    setName("");
    setHost("");
    setUser("");
    setPass("");
    setPort("");
    setPinOn(false);
    setSheetPin("");
    sheetPinOrig.current = null;
    setSheetPane(pane);
    setSheetLabel(null);
    setConnectSheet("new");
  };
  // Rouvre la feuille sur un serveur (mot de passe change, autre port…). Garder
  // le meme nom met a jour le serveur memorise au lieu d'en creer un autre.
  // Serveur protege : son code d'abord (la feuille montre le mot de passe et
  // permet de retirer la protection).
  const editConnection = (label: string, pane: PaneId) => {
    const s = servers.find((x) => x.label === label);
    if (!s) return;
    const fill = (pw: string, pin: string) => {
      setHost(s.host);
      setUser(s.user);
      setPass(pw);
      setPort(s.port);
      setName(s.label);
      setPinOn(!!s.locked);
      setSheetPin(pin);
      sheetPinOrig.current = { label: s.label, on: !!s.locked, pin };
      setSheetPane(pane);
      setSheetLabel(null);
      setConnectSheet("edit");
    };
    if (!s.locked) return fill(s.pass, "");
    setPinAsk({
      label,
      onOk: (pw, pin) => {
        setPinAsk(null);
        fill(pw, pin);
      },
    });
  };
  const pinUnchanged = (label: string) => {
    const o = sheetPinOrig.current;
    return !!o && o.label === label && o.on === pinOn && (!pinOn || o.pin === sheetPin);
  };
  // « Se connecter » dans la feuille : nom facultatif (sinon « user@host »).
  const connectFromSheet = () => {
    const label = name.trim() || `${user.trim()}@${host.trim()}`;
    setSheetLabel(label);
    connectServer(
      {
        label,
        host: host.trim(),
        user: user.trim(),
        pass,
        port: port.trim() || "22",
        startDir: servers.find((x) => x.label === label)?.startDir ?? "",
      },
      sheetPane,
      true,
      true,
      pinUnchanged(label) ? null : pinOn ? sheetPin : "",
    );
  };
  const sheetConn = sheetLabel ? conns[sheetLabel] : undefined;
  // La feuille de connexion se referme d'elle-meme une fois connecte.
  useEffect(() => {
    if (connectSheet && sheetConn?.state === "ok") {
      setConnectSheet(null);
      setSheetLabel(null);
    }
  }, [connectSheet, sheetConn?.state]);

  // ---- Telephones Android (macOS) -------------------------------------------
  // Le backend sait-il parler aux telephones ? (macOS : oui ; Windows : non —
  // l'Explorateur les gere deja, et le moteur MTP n'y est pas embarque.)
  useEffect(() => {
    invoke<boolean>("phones_supported")
      .then(setPhonesSupported)
      .catch(() => setPhonesSupported(false));
  }, []);
  const phonesRef = useRef(phones);
  phonesRef.current = phones;
  // Liste des telephones branches, relue toutes les 2 s (requete locale, sans
  // toucher a l'USB : le moteur surveille les branchements de son cote).
  useEffect(() => {
    if (!phonesSupported) return;
    let alive = true;
    let last = "";
    const poll = () =>
      invoke<Phone[]>("phones_list")
        .then((list) => {
          const json = JSON.stringify(list);
          if (!alive || json === last) return;
          last = json;
          setPhones(list);
        })
        .catch(() => {});
    poll();
    const id = setInterval(poll, 2000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [phonesSupported]);
  // Nom des telephones vus pendant la session : un panneau garde le nom d'un
  // telephone debranche (« Pixel 9 Pro — débranché »).
  const phoneNames = useRef<Map<string, string>>(new Map());
  for (const ph of phones) phoneNames.current.set(ph.id, ph.name);
  // Branchement / debranchement : journal. (L'ouverture se propose par le
  // bouton « telephone » de la barre du haut, cf. plus bas.)
  useEffect(() => {
    const ids = new Set(phones.map((p) => p.id));
    for (const id of [...announcedPhones.current]) {
      if (ids.has(id)) continue;
      announcedPhones.current.delete(id);
      logEvent("info", "operation", t("app.log.phoneUnplugged", { name: phoneNames.current.get(id) ?? id }));
    }
    for (const ph of phones) {
      if (announcedPhones.current.has(ph.id)) continue;
      announcedPhones.current.add(ph.id);
      logEvent("info", "operation", t("app.log.phonePlugged", { name: ph.name }));
    }
  }, [phones]);
  const openPhone = (id: string, pane: PaneId) => {
    const ph = phonesRef.current.find((p) => p.id === id);
    setPaneSrc(pane, { kind: "phone", id, name: ph?.name ?? phoneNames.current.get(id) ?? "" });
    setActive(pane);
  };
  const retryPhone = (id: string) => {
    invoke("phone_retry", { id }).catch(() => {});
  };

  // Demande a l'utilisateur quoi faire pour un fichier deja present.
  const askConflict = (name: string) =>
    new Promise<{ action: "replace" | "ignore"; all: boolean }>((resolve) => {
      conflictResolver.current = resolve;
      setConflictAll(false);
      setConflict({ name });
    });
  const resolveConflict = (action: "replace" | "ignore") => {
    const all = conflictAll;
    setConflict(null);
    conflictResolver.current?.({ action, all });
    conflictResolver.current = null;
  };

  // ---- Mise en file --------------------------------------------------------
  // Un depot (glisser / coller) n'ouvre plus de job tout de suite : il REMPLIT
  // la file. Les dossiers sont eclates en fichiers (planItem) pour que chaque
  // ligne soit un fichier — c'est ce qui rend la limite de transferts
  // simultanes exacte et la reprise possible fichier par fichier.
  // `intoDir` : dossier vise quand on lache PILE sur un dossier du panneau
  // d'en face. Sinon on copie dans le dossier couramment affiche.
  const startTransfers = useCallback(async (
    src: Payload,
    destPane: PaneId,
    intoDir?: string,
  ) => {
    const dest = panes.current[destPane];
    // Panneau sans source exploitable (rien de choisi, telephone debranche…).
    if (!paneEnabled.current[destPane]) return;
    const destLoc = dest.loc;
    const destDir = intoDir ?? dest.dir;

    // MEME source des deux cotes (le meme serveur, le disque local dans les deux
    // panneaux…) : copier un dossier sur lui-meme ou dans son propre
    // sous-dossier ecraserait (ecriture directe) ou boucle sans fin. On refuse.
    // Deux serveurs memorises peuvent etre le MEME compte sur la meme machine
    // (adresse locale et adresse Tailscale…) : meme garde-fou. (Ecriture
    // directe : « Remplacer » un fichier par lui-meme le viderait.)
    const account = (l: Loc) => {
      if (l.kind !== "server") return l.kind + "|" + l.remote;
      const c = Object.values(connsRef.current).find((x) => x.remote === l.remote);
      return c
        ? `server|${c.server.user}@${c.server.host.toLowerCase()}:${c.server.port || "22"}`
        : "server|" + l.remote;
    };
    const sameSource = account(src.loc) === account(destLoc);
    // Disque local de macOS et Windows : insensible a la casse.
    const fold = destLoc.kind === "local" && !isLinux;
    const norm = (d: string) => {
      const x = d.replace(/\/+$/, "") || "/";
      return fold ? x.toLowerCase() : x;
    };
    let items = src.items;
    if (sameSource) {
      if (norm(src.dir) === norm(destDir)) {
        setNotice(t("app.notice.sameFolder"));
        return;
      }
      const inside = (it: (typeof items)[number]) => {
        if (!it.IsDir) return false;
        const own = norm(joinDir(src.dir, it.Name));
        const d = norm(destDir);
        return d === own || d.startsWith(own + "/");
      };
      if (items.some(inside)) {
        setNotice(t("app.notice.intoItself"));
        items = items.filter((it) => !inside(it));
        if (!items.length) return;
      }
    }

    // Ce qui existe deja a destination (pour proposer Remplacer / Ignorer).
    let existing = new Set<string>();
    try {
      const r = await rc<{ list: { Name: string }[] }>(
        "operations/list",
        listArgs(destLoc.remote, destDir),
      );
      existing = new Set((r.list ?? []).map((e) => e.Name));
    } catch {
      /* pas grave : on ne detecte juste pas les conflits */
    }

    // Choix memorise pour CETTE copie uniquement (case a cocher).
    let batch: "replace" | "ignore" | null = null;
    const keep = [];
    for (const item of items) {
      if (existing.has(item.Name)) {
        let action = batch;
        if (!action) {
          const res = await askConflict(item.Name);
          if (res.all) batch = res.action;
          action = res.action;
        }
        if (action === "ignore") continue;
      }
      keep.push(item);
    }
    if (!keep.length) return;

    logEvent(
      "info",
      "transfert",
      tn("app.log.queued", keep.length, {
        dest: destLoc.label,
        dir: destDir,
      }),
    );
    // Trajet affiche sur chaque ligne : « Pixel 9 Pro → NAS · RUSHS ».
    const destFolder = destDir.replace(/\/+$/, "").split("/").pop() || "";
    const dstLabel = destFolder ? `${destLoc.label} · ${destFolder}` : destLoc.label;
    setTab("queue");
    setPreparing((n) => n + keep.length);
    for (const item of keep) {
      try {
        const { plans, mkdirs } = await planItem(
          src.loc.remote,
          src.dir,
          item,
          destLoc.remote,
          destDir,
        );
        // Dossiers vides : aucune copie de fichier ne les creerait.
        for (const m of mkdirs) rc("operations/mkdir", m).catch(() => {});
        setXfers((prev) => [
          ...prev,
          ...plans.map((p) => {
            const id = ++jobSeq.current;
            return {
              id,
              group: `copy/${id}`,
              jobid: 0,
              name: p.name,
              rel: p.rel,
              srcFs: p.src.fs,
              srcRemote: p.src.remote,
              dstFs: p.dst.fs,
              dstRemote: p.dst.remote,
              srcLabel: src.loc.label,
              dstLabel,
              size: p.size,
              bytes: 0,
              speed: 0,
              status: "queued" as const,
              error: "",
              attempts: 0,
              nextTry: 0,
            };
          }),
        ]);
      } catch (e) {
        // L'analyse elle-meme a echoue (dossier illisible, lien coupe).
        const id = ++jobSeq.current;
        setXfers((prev) => [
          ...prev,
          {
            id,
            group: `copy/${id}`,
            jobid: 0,
            name: item.Name,
            rel: "",
            srcFs: "",
            srcRemote: "",
            dstFs: "",
            dstRemote: "",
            srcLabel: src.loc.label,
            dstLabel,
            size: 0,
            bytes: 0,
            speed: 0,
            status: "error" as const,
            error: String(e),
            attempts: 0,
            nextTry: 0,
          },
        ]);
      } finally {
        setPreparing((n) => Math.max(0, n - 1));
      }
    }
  }, []);

  // ---- Ouvrir un fichier distant --------------------------------------------
  // On telecharge dans un cache dedie via la MEME file (progression + annulation),
  // puis l'OS ouvre la copie une fois arrivee (cf. le suivi, statut "done"). La
  // copie vit le temps de la session ; le backend la nettoie au demarrage et a la
  // fermeture. Toujours FRAICHE : pas de reutilisation entre ouvertures.
  //
  // Ouvrir = editer (modele FileZilla, action unique) : on surveille TOUJOURS la
  // copie. Si l'utilisateur la modifie et l'enregistre, on propose le renvoi ; s'il
  // ne fait que consulter, rien ne se passe. Ca supprime le piege « j'ouvre, je
  // modifie, j'enregistre, et mon travail est perdu sans un mot ».
  const openRemote = useCallback(
    async (loc: Loc, fileDir: string, name: string, size: number, modTime: string) => {
      try {
        // Sous-dossier frais (chemin local a slashs avant, termine par "/").
        const folder = await invoke<string>("open_cache_dir");
        const src = fileAddr(loc.remote, fileDir, name);
        const id = ++jobSeq.current;
        setTab("queue");
        setXfers((prev) => [
          ...prev,
          {
            id,
            group: `copy/${id}`,
            jobid: 0,
            name,
            rel: "",
            srcFs: src.fs,
            srcRemote: src.remote,
            dstFs: folder,
            dstRemote: name,
            srcLabel: loc.label,
            dstLabel: localLabelRef.current,
            size,
            bytes: 0,
            speed: 0,
            status: "queued" as const,
            error: "",
            attempts: 0,
            nextTry: 0,
            openOnDone: folder + name,
            editWatch: true,
            editBaseMod: modTime,
          },
        ]);
      } catch (e) {
        logEvent("error", "operation", t("app.log.openFailed", { name, err: String(e) }));
      }
    },
    [],
  );

  // ---- Edition d'un fichier distant -----------------------------------------
  // Une fois le telechargement « edition » arrive (cf. le suivi), on ouvre le
  // fichier ET on le met sous surveillance : `registerEdit` empreinte la copie et
  // fait apparaitre l'onglet « En cours d'édition ».
  const registerEdit = useCallback((x: Xfer) => {
    const id = ++editSeq.current;
    const localDir = x.dstFs; // dossier de la copie (termine par "/")
    const name = x.dstRemote;
    invoke("edit_register", { id, local: localDir + name, label: name }).catch(
      () => {},
    );
    setEdits((prev) => [
      ...prev,
      {
        id,
        label: name,
        state: "watching",
        localDir,
        name,
        dstFs: x.srcFs, // le renvoi est le sens inverse du telechargement
        dstRemote: x.srcRemote,
        dstLabel: x.srcLabel,
        baseRemoteMod: x.editBaseMod ?? "",
        baseRemoteSize: x.size,
      },
    ]);
    setTab("edition");
    logEvent("info", "operation", t("app.log.editStarted", { name }));
  }, []);

  // Renvoi effectif d'une copie editee vers le serveur (via la file).
  const doResend = useCallback((e: EditItem) => {
    invoke("edit_set_uploading", { id: e.id, uploading: true }).catch(() => {});
    setEdits((prev) =>
      prev.map((p) => (p.id === e.id ? { ...p, state: "uploading" } : p)),
    );
    setEditAsk((cur) => (cur?.id === e.id ? null : cur));
    setConflictAsk((cur) => (cur?.e.id === e.id ? null : cur));
    const id = ++jobSeq.current;
    setTab("queue");
    setXfers((prev) => [
      ...prev,
      {
        id,
        group: `copy/${id}`,
        jobid: 0,
        name: e.name,
        rel: "",
        srcFs: e.localDir,
        srcRemote: e.name,
        dstFs: e.dstFs,
        dstRemote: e.dstRemote,
        srcLabel: localLabelRef.current,
        dstLabel: e.dstLabel,
        size: 0,
        bytes: 0,
        speed: 0,
        status: "queued" as const,
        error: "",
        attempts: 0,
        nextTry: 0,
        editId: e.id,
      },
    ]);
  }, []);

  // Renvoi demande : on verifie d'abord si le fichier a change SUR LE SERVEUR
  // depuis l'ouverture (quelqu'un d'autre l'a edite, ou il a ete supprime). Si
  // oui, on previent avant d'ecraser ; sinon on renvoie directement.
  const resendEdit = useCallback(
    async (e: EditItem) => {
      try {
        const r = await rc<{ item: { ModTime: string; Size: number } | null }>(
          "operations/stat",
          { fs: e.dstFs, remote: e.dstRemote },
        );
        if (!r.item) {
          setConflictAsk({ e, reason: "deleted" });
          return;
        }
        if (
          r.item.ModTime !== e.baseRemoteMod ||
          r.item.Size !== e.baseRemoteSize
        ) {
          setConflictAsk({ e, reason: "changed" });
          return;
        }
      } catch {
        /* stat indisponible : on tente le renvoi quand meme */
      }
      doResend(e);
    },
    [doResend],
  );

  // « Ignorer » : on accepte l'etat courant comme nouvelle reference, sans renvoi.
  const ignoreEdit = useCallback((id: number) => {
    invoke("edit_reset", { id }).catch(() => {});
    setEdits((prev) =>
      prev.map((p) => (p.id === id ? { ...p, state: "watching" } : p)),
    );
    setEditAsk((cur) => (cur?.id === id ? null : cur));
  }, []);

  // Arrete la surveillance d'un fichier.
  const stopEdit = useCallback((id: number) => {
    invoke("edit_stop", { id }).catch(() => {});
    setEdits((prev) => prev.filter((p) => p.id !== id));
    setEditAsk((cur) => (cur?.id === id ? null : cur));
  }, []);

  // Ecoute les modifications detectees par le backend (polling « change +
  // stable »). On marque « modifie » et on propose le renvoi (un a la fois : les
  // autres restent visibles dans l'onglet, renvoyables depuis leur bouton).
  useEffect(() => {
    const un = listen<{ id: number; label: string }>("edit-changed", (ev) => {
      const { id, label } = ev.payload;
      setEdits((prev) =>
        prev.map((p) => (p.id === id ? { ...p, state: "changed" } : p)),
      );
      setEditAsk((cur) => cur ?? { id, label });
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  // Retour de focus : on force un passage de surveillance immediat (comme
  // FileZilla, qui verifie quand on revient sur la fenetre).
  useEffect(() => {
    const onFocus = () => invoke("edit_poll_now").catch(() => {});
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  // Le serveur ne sait pas calculer d'empreinte : rclone comparait donc une
  // valeur inexploitable a une vraie, concluait a une corruption, et TOUT
  // echouait. On rebascule la connexion en `disable_hashcheck` (rclone verifie
  // alors la TAILLE, comme le font FileZilla et les explorateurs). La
  // reconfiguration n'a lieu qu'UNE fois ; la relance des transferts, elle, est
  // traitee a part (cf. l'effet plus bas) — sinon ceux qui echouent APRES la
  // bascule, alors qu'ils etaient deja en vol, resteraient en echec pour
  // toujours. C'est exactement ce qu'on observait : 6 fichiers echoues, 3
  // relances seulement.
  // `remote` : le serveur en cause (« srv2: »).
  const disableHashCheck = useCallback(async (remote: string) => {
    const name = remote.replace(/:$/, "");
    if (noHashRef.current.has(name)) return;
    const s = Object.values(connsRef.current).find((c) => c.remote === remote)?.server;
    if (!s) return;
    noHashRef.current.add(name);
    try {
      await rc("config/create", {
        name,
        type: "sftp",
        parameters: {
          host: s.host,
          user: s.user,
          pass: s.pass,
          port: s.port || "22",
          concurrency: String(settingsRef.current.sftpConcurrency),
          disable_hashcheck: "true",
        },
        opt: { obscure: true },
      });
      // Les instances de connexion deja en cache gardent l'ancien reglage.
      await rc("fs/cache/clear").catch(() => {});
      logEvent(
        "warn",
        "connexion",
        t("app.log.noHash"),
      );
      // Signale que la NOUVELLE config est reellement en place : relancer avant
      // ce moment referait echouer les transferts a l'identique.
      setNoHashReady((r) => (r.includes(name) ? r : [...r, name]));
    } catch {
      noHashRef.current.delete(name); // la bascule a rate : on repassera au prochain echec
    }
  }, []);
  // Serveurs (« srv2 ») par lesquels passe un transfert : c'est sur eux que
  // porte la verification d'empreinte.
  const serverNamesOf = (x: { srcFs: string; dstFs: string }) =>
    [x.srcFs, x.dstFs]
      .filter((f) => fsKind(f) === "server")
      .map((f) => fsRemote(f).replace(/:$/, ""));

  // Relance tout echec « empreinte » une fois la connexion reconfiguree. Vaut
  // aussi pour ceux tombes juste apres la bascule. `hashRetried` evite la
  // boucle : on ne redonne qu'UNE chance a chaque transfert.
  useEffect(() => {
    if (!noHashReady.length) return;
    const stuck = xfers.filter(
      (x) =>
        x.status === "error" &&
        x.hashFault &&
        !x.hashRetried &&
        serverNamesOf(x).some((n) => noHashReady.includes(n)),
    );
    if (!stuck.length) return;
    const ids = new Set(stuck.map((x) => x.id));
    rejoinBatch(ids);
    setXfers((prev) =>
      prev.map((p) =>
        ids.has(p.id)
          ? {
              ...p,
              status: "queued" as const,
              error: "",
              bytes: 0,
              attempts: 0,
              nextTry: 0,
              hashFault: false,
              hashRetried: true,
            }
          : p,
      ),
    );
  }, [noHashReady, xfers]);

  // ---- Echec d'un transfert : reprise auto ou abandon -----------------------
  const failXfer = useCallback((id: number, err: string) => {
    // Empreinte inexploitable cote serveur : ce n'est pas une corruption, c'est
    // une verification impossible. On corrige la connexion au lieu de blamer le
    // fichier. (Le marquage `hashFault` sert a relancer les bons transferts.)
    // Seul le cote dont l'empreinte est inexploitable est bascule (copie
    // serveur -> serveur : l'autre garde sa verification).
    if (isBrokenHashSupport(err)) {
      const x = xfersRef.current.find((p) => p.id === id);
      const m = HASH_DIFFER.exec(err);
      if (x && m) {
        if (!IS_MD5.test(m[1]) && fsKind(x.srcFs) === "server") void disableHashCheck(fsRemote(x.srcFs));
        if (!IS_MD5.test(m[2]) && fsKind(x.dstFs) === "server") void disableHashCheck(fsRemote(x.dstFs));
      }
    }
    setXfers((prev) =>
      prev.map((p) => {
        if (p.id !== id || p.status === "cancelled") return p;
        const attempts = p.attempts + 1;
        const max = settingsRef.current.retries;
        const hashFault = isBrokenHashSupport(err);
        // Nom refuse par la destination : le reessayer a l'identique echouera
        // pareil. On s'arrete et on proposera de le renommer (cf. `renameAsk`).
        // Jamais quand l'empreinte est en cause : les caracteres exotiques sont
        // alors innocents (verifie en reel — ces memes fichiers passent sans
        // broncher une fois la verification d'empreinte desactivee).
        const nameFault =
          !hashFault && NAME_ERROR.test(err) && hasBadChars(p.name) && !p.renamed;
        // Fallback ENVOI multi-connexions : un echec AVANT le moindre octet
        // (p.bytes === 0) sur un upload a plusieurs flux = le serveur a refuse
        // d'ouvrir autant de connexions (MaxStartups/MaxSessions, fail2ban...).
        // On divise les flux par deux et on relance ; en cascade 16->8->4->2->1
        // on finit sur une seule connexion (= comportement d'avant le patch). Une
        // coupure EN COURS (bytes > 0) n'est pas concernee : on garde les flux.
        const curUp = p.upStreams ?? settingsRef.current.uploadStreams;
        // (Rien a rabaisser quand un telephone est en jeu : un seul flux.)
        const phone = touchesPhone(p);
        const streamFallback =
          !nameFault &&
          !hashFault &&
          !phone &&
          isUploadXfer(p) &&
          p.bytes === 0 &&
          curUp > 1;
        const nextUp = streamFallback ? Math.max(1, Math.floor(curUp / 2)) : p.upStreams;
        // Fallback TELECHARGEMENT : un morceau d'un telechargement multi-flux a
        // casse (« multi-thread copy: failed to write chunk: connection lost »),
        // typiquement un lien qui ne suit pas autant de flux : l'un d'eux finit
        // affame et coupe au bout du delai. Relancer a l'identique echouait en
        // boucle (constate : 16 flux par Tailscale vers un NAS DS418, blocage a
        // 77 % a chaque essai ; 4 flux passent). On divise donc les flux par
        // deux, pour ce fichier ET pour la suite de la connexion.
        const curDown = p.downStreams ?? settingsRef.current.streams;
        const downFallback =
          !nameFault &&
          !hashFault &&
          !phone &&
          !isUploadXfer(p) &&
          fsKind(p.srcFs) === "server" &&
          MULTI_THREAD_ERROR.test(err) &&
          curDown > 1;
        const nextDown = downFallback ? Math.max(1, Math.floor(curDown / 2)) : p.downStreams;
        // Plafond retenu pour la suite des telechargements DE CE serveur.
        if (downFallback && nextDown !== undefined) {
          const r = fsRemote(p.srcFs);
          downCapRef.current[r] = Math.min(downCapRef.current[r] ?? nextDown, nextDown);
        }
        // Coupure reseau OU alea transitoire de rclone OU fallback de flux => on
        // reprend tout seul (0 = tentatives illimitees). Pas la peine pour une
        // empreinte cassee : `disableHashCheck` vient de relancer proprement.
        const retry =
          !nameFault &&
          !hashFault &&
          (streamFallback || downFallback || NETWORK_ERROR.test(err) || RETRYABLE_ERROR.test(err)) &&
          (max === 0 || attempts < max);
        return {
          ...p,
          attempts,
          speed: 0,
          // Une reprise RECOPIE le fichier depuis le debut (rclone `copyfile`
          // ne reprend pas un fichier partiel, et l'ecriture directe Inplace
          // n'y change rien). Garder les octets de la tentative perdue laissait
          // la barre figee a l'ancien pourcentage, immobile le temps que la
          // nouvelle copie revienne au meme point : ca ressemblait a un gel.
          // On la remet a zero, ce qui reflete le vrai travail restant.
          bytes: retry ? 0 : p.bytes,
          status: retry ? ("retry" as const) : ("error" as const),
          nextTry: retry ? Date.now() + backoff(attempts) : 0,
          upStreams: nextUp,
          downStreams: nextDown,
          // Marque l'echec comme « probablement le nom » : le message brut de
          // rclone parle d'empreintes, ce qui n'aide personne.
          nameFault,
          hashFault,
          error: nameFault
            ? t("app.err.nameRefused", { name: p.name, err })
            : hashFault
              ? t("app.err.hashRetry", { err })
              : streamFallback
                ? t("app.err.streamFallback", { from: curUp ?? "", to: nextUp ?? "", err })
                : downFallback
                  ? t("app.err.downFallback", { from: curDown, to: nextDown ?? "", err })
                  : err,
        };
      }),
    );
  }, [disableHashCheck]);

  // Relance un transfert sous un nom nettoye. On ne touche qu'au DERNIER
  // segment du chemin distant : le dossier de destination, lui, est bon.
  const retryRenamed = useCallback((x: Xfer) => {
    const clean = sanitizeName(x.name);
    const cut = x.dstRemote.lastIndexOf("/");
    const dstRemote =
      cut < 0 ? clean : `${x.dstRemote.slice(0, cut)}/${clean}`;
    rejoinBatch([x.id]);
    setXfers((prev) =>
      prev.map((p) =>
        p.id === x.id
          ? {
              ...p,
              name: clean,
              dstRemote,
              renamed: true,
              nameFault: false,
              status: "queued" as const,
              error: "",
              bytes: 0,
              attempts: 0,
              nextTry: 0,
            }
          : p,
      ),
    );
    logEvent("info", "transfert", t("app.log.renamedForCopy", { from: x.name, to: clean }));
  }, []);

  // Abandonne la proposition de renommage pour ce transfert (il reste en echec).
  const declineRename = useCallback((id: number) => {
    setXfers((prev) =>
      prev.map((p) => (p.id === id ? { ...p, nameFault: false } : p)),
    );
  }, []);

  // Presente le prochain echec « nom refuse ». Si « appliquer a tous » a ete
  // VALIDE (case cochee PUIS bouton clique), on enchaine sans redemander.
  const pendingNameFault = xfers.find(
    (x) => x.status === "error" && x.nameFault,
  );
  useEffect(() => {
    if (!pendingNameFault) {
      // Plus rien en attente : la salve est finie, le « pour tous » expire.
      setRenameAsk(null);
      setRenameAll(false);
      renameAllRef.current = false;
      return;
    }
    if (renameAllRef.current) retryRenamed(pendingNameFault);
    else setRenameAsk(pendingNameFault);
    // `renameAll` est volontairement ABSENT des dependances : c'est l'etat de la
    // case a cocher, pas une decision. L'y mettre relancait l'effet des qu'on la
    // cochait, ce qui validait la modale au premier clic sur la case — plus
    // moyen de se raviser. Seul `renameAllRef`, pose au clic sur le bouton,
    // fait foi.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingNameFault, retryRenamed]);

  // ---- Ordonnanceur : garde `parallel` transferts actifs --------------------
  const launch = useCallback(
    async (x: Xfer) => {
      try {
        // Remet les compteurs du groupe a zero : sinon, sur une reprise, les
        // octets de la tentative precedente s'ajouteraient a la nouvelle.
        await rc("core/stats-reset", { group: x.group }).catch(() => {});
        // Les reglages de transfert sont poses GLOBALEMENT (bloc « main » via
        // options/set), y compris `MultiThreadStreams` = `streams` (defaut 16),
        // qui vaut pour le TELECHARGEMENT. Un `_config` par job avait jadis casse
        // le renommage du fichier « .partial » (« incompatible remotes ») ; ce
        // n'est plus le cas depuis qu'on ecrit en place (`Inplace=true`, dans la
        // config globale), car il n'y a plus de renommage. On peut donc, pour un
        // ENVOI seulement, surcharger UN seul reglage : le nombre de flux, plus
        // faible a la montee (defaut 8) car chaque flux ouvre une session SSH et
        // les serveurs plafonnent souvent a MaxSessions=10. Le `_config` COMPLETE
        // le bloc global (verifie : cutoff / chunk / Inplace restent herites), il
        // ne le remplace pas.
        // Flux effectif de l'envoi : le reglage, sauf si un echec precedent l'a
        // deja rabaisse (fallback, cf. failXfer). A 1, rclone ne multi-thread
        // pas -> exactement l'ancien comportement mono-connexion.
        const isUpload = isUploadXfer(x);
        const upStreams = x.upStreams ?? settingsRef.current.uploadStreams;
        // Telechargement : le reglage, rabaisse par un echec precedent de ce
        // fichier ou du serveur source (cf. failXfer). Au reglage plein, pas de
        // `_config` : le bloc global suffit.
        const wanted = settingsRef.current.streams;
        const cap = downCapRef.current[fsRemote(x.srcFs)];
        const downStreams = Math.min(x.downStreams ?? wanted, cap ?? wanted);
        // Telephone (MTP) : un seul flux, jamais de decoupe. Et rclone ne peut
        // pas y comparer les dates (le telephone ne les conserve pas) : a taille
        // egale il croirait le fichier identique et sauterait la copie, meme
        // apres un « Remplacer ». `IgnoreTimes` force la copie demandee.
        const phone = touchesPhone(x);
        const { jobid } = await rc<{ jobid: number }>("operations/copyfile", {
          srcFs: x.srcFs,
          srcRemote: x.srcRemote,
          dstFs: x.dstFs,
          dstRemote: x.dstRemote,
          _async: true,
          _group: x.group,
          ...(phone
            ? { _config: { MultiThreadStreams: 0, IgnoreTimes: true } }
            : isUpload
              ? { _config: { MultiThreadStreams: upStreams } }
              : downStreams < wanted
                ? { _config: { MultiThreadStreams: downStreams } }
                : {}),
        });
        // Annule pendant le demarrage : le job existe deja cote rclone, il faut
        // l'arreter — sinon la copie continuerait dans le dos de l'utilisateur.
        if (xfersRef.current.find((p) => p.id === x.id)?.status === "cancelled") {
          rc("job/stop", { jobid }).catch(() => {});
          return;
        }
        setXfers((prev) =>
          prev.map((p) =>
            p.id === x.id && p.status === "starting"
              ? {
                  ...p,
                  jobid,
                  status: "running" as const,
                  bytes: 0,
                  // Flux reellement demandes (affiches a cote du debit).
                  downStreams:
                    phone || isUpload || downStreams >= wanted ? p.downStreams : downStreams,
                  error: "",
                  // Le compte a rebours « figé » part du lancement : sans ca,
                  // un transfert qui n'a pas encore recu son premier octet
                  // paraitrait fige des la premiere seconde.
                  movedAt: Date.now(),
                }
              : p,
          ),
        );
      } catch (e) {
        failXfer(x.id, String(e));
      }
    },
    [failXfer],
  );

  // Le creneau est pris DANS l'etat (statut "starting"), pas dans un ensemble a
  // cote : un ensemble mutable est lu au moment de l'effet alors que `xfers` est
  // l'instantane du rendu. Les deux se desynchronisent, et un transfert peut
  // paraitre a la fois "pas encore lance" et "en attente" => double lancement.
  useEffect(() => {
    const now = Date.now();
    const busy = xfers.filter(
      (x) => x.status === "running" || x.status === "starting",
    ).length;
    const free = settings.parallel - busy;
    if (free <= 0) return;
    // Un telephone ne sait copier qu'UN fichier a la fois (MTP) : tant qu'un
    // transfert l'occupe, les suivants qui le touchent attendent leur tour —
    // sans bloquer ceux qui ne passent pas par lui.
    const phonesBusy = new Set<string>();
    const phonesOf = (x: Xfer) =>
      [x.srcFs, x.dstFs].filter((f) => fsKind(f) === "phone").map(fsRemote);
    for (const x of xfers)
      if (x.status === "running" || x.status === "starting")
        for (const r of phonesOf(x)) phonesBusy.add(r);
    const next: Xfer[] = [];
    for (const x of xfers) {
      if (next.length >= free) break;
      if (!(x.status === "queued" || (x.status === "retry" && x.nextTry <= now))) continue;
      const ph = phonesOf(x);
      if (ph.some((r) => phonesBusy.has(r))) continue;
      for (const r of ph) phonesBusy.add(r);
      next.push(x);
    }
    if (!next.length) return;
    const ids = new Set(next.map((x) => x.id));
    setXfers((prev) =>
      prev.map((p) =>
        ids.has(p.id) ? { ...p, status: "starting" as const, error: "" } : p,
      ),
    );
    for (const x of next) launch(x);
  }, [xfers, tick, settings.parallel, launch]);

  // ---- Battement (ordonnanceur + suivi) ------------------------------------
  // Actif tant qu'il reste du travail, MEME si aucun job ne tourne : sans ca,
  // une file entierement en attente de reprise ne repartirait jamais.
  const pending = xfers.some((x) => !isFinal(x));
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => setTick((t) => t + 1), 600);
    return () => clearInterval(timer);
  }, [pending]);

  // File vide = lot clos : tout ce qui existe (transferts termines qui restent
  // affiches) appartient au passe. On cale l'ancre sur le dernier id attribue,
  // de sorte que la progression globale du PROCHAIN lot ne compte que ses
  // propres fichiers (ids superieurs), pas les octets deja copies avant.
  useEffect(() => {
    if (!pending) batchAnchorRef.current = jobSeq.current;
  }, [pending]);

  // ---- Debit agrege lisse (barre globale) ----------------------------------
  // Le `speed` par fichier de rclone est une moyenne depuis le debut du groupe :
  // sur des petits fichiers qui s'enchainent, chaque copie finit en une fraction
  // de tick et le trou avant la suivante fait retomber la SOMME a zero — d'ou une
  // aiguille (debit + temps restant) qui saute. On mesure donc NOUS-MEMES la
  // cadence : derivee du cumul d'octets reellement transferes sur une fenetre
  // glissante, lissee par une EMA. Cela integre naturellement l'overhead par
  // fichier (ouverture/fermeture SFTP, aller-retours) qui domine le temps sur des
  // petits fichiers, la ou un debit brut octets/s serait trompeur.
  const SPEED_WINDOW_MS = 4000;
  useEffect(() => {
    const now = Date.now();
    // Cumul monotone : un fichier termine compte pour sa taille, un en cours pour
    // ses octets partiels. (Echecs/annulations ignores : octets abandonnes.)
    const cum = xfersRef.current.reduce(
      (s, x) =>
        s +
        (x.status === "done" ? x.size : x.status === "running" ? x.bytes : 0),
      0,
    );
    const buf = speedSamplesRef.current;
    // Trou plus long que la fenetre = lot precedent fini / longue pause : on
    // repart a neuf pour ne pas diluer la mesure avec du temps mort.
    const last = buf[buf.length - 1];
    if (last && now - last.t > SPEED_WINDOW_MS) {
      buf.length = 0;
      emaSpeedRef.current = 0;
    }
    buf.push({ t: now, b: cum });
    // On garde un seul point-repere juste avant le bord de la fenetre.
    const cutoff = now - SPEED_WINDOW_MS;
    while (buf.length > 2 && buf[1].t <= cutoff) buf.shift();
    const first = buf[0];
    const dt = (now - first.t) / 1000;
    // On attend ~0,8 s de recul avant de croire la derivee (sinon valeur folle
    // sur le tout premier echantillon).
    const raw = dt >= 0.8 ? Math.max(0, (cum - first.b) / dt) : emaSpeedRef.current;
    const prev = emaSpeedRef.current;
    const nextSpeed = prev > 0 ? prev + 0.35 * (raw - prev) : raw;
    emaSpeedRef.current = nextSpeed;
    setSmoothSpeed(nextSpeed);
  }, [tick]);

  const lastRefresh = useRef(0);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Relistage differe (minuterie, pas le battement : celui-ci s'arrete des que
  // la file est vide, la derniere copie doit pourtant apparaitre).
  const refreshSoon = useCallback(() => {
    if (refreshTimer.current) return;
    const wait = Math.max(0, 2000 - (Date.now() - lastRefresh.current));
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      lastRefresh.current = Date.now();
      panes.current.left.refresh();
      panes.current.right.refresh();
    }, wait);
  }, []);
  // ---- Suivi temps reel des transferts en cours ----------------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const running = xfersRef.current.filter(
        (x) => x.status === "running" && x.jobid,
      );
      let anyFinished = false;
      for (const x of running) {
        try {
          const [stats, status] = await Promise.all([
            rc<{ bytes: number; speed: number }>("core/stats", {
              group: x.group,
            }),
            rc<{ finished: boolean; error: string }>("job/status", {
              jobid: x.jobid,
            }),
          ]);
          if (cancelled) return;

          if (!status.finished) {
            setXfers((prev) =>
              prev.map((p) =>
                p.id === x.id && p.status === "running"
                  ? {
                      ...p,
                      bytes: stats.bytes ?? p.bytes,
                      speed: stats.speed ?? 0,
                      // Date du dernier octet REELLEMENT arrive. Le debit
                      // affiche est une moyenne glissante : quand le lien
                      // tombe, il decroit doucement au lieu de tomber a zero,
                      // et la copie a l'air de continuer. Ce repere-la ne
                      // ment pas.
                      movedAt:
                        (stats.bytes ?? p.bytes) !== p.bytes
                          ? Date.now()
                          : (p.movedAt ?? Date.now()),
                    }
                  : p,
              ),
            );
            continue;
          }

          anyFinished = true;
          if (status.error) {
            // Annulation par l'utilisateur : rclone nettoie le fichier partiel
            // et renvoie "context canceled" — ce n'est pas un echec.
            if (/context canceled/i.test(status.error))
              setXfers((prev) =>
                prev.map((p) =>
                  p.id === x.id
                    ? { ...p, status: "cancelled" as const, speed: 0 }
                    : p,
                ),
              );
            else failXfer(x.id, status.error);
          } else {
            // Termine — ou saute par rclone car deja present a l'identique
            // (0 octet transfere) : dans les deux cas, le fichier est en place.
            setXfers((prev) =>
              prev.map((p) =>
                p.id === x.id && p.status === "running"
                  ? {
                      ...p,
                      status: "done" as const,
                      bytes: p.size,
                      speed: 0,
                      error: "",
                    }
                  : p,
              ),
            );
            // Ouverture d'un fichier distant : la copie est arrivee, on l'ouvre
            // avec l'appli associee de l'OS. (Effet de bord hors du updater.)
            if (x.openOnDone) {
              openPath(x.openOnDone).catch(() => {});
              logEvent("info", "operation", t("app.log.opened", { name: x.name }));
              // Ouvert POUR EDITION : on met la copie sous surveillance.
              if (x.editWatch) registerEdit(x);
            }
            // Renvoi d'une edition termine : le fichier est de retour sur le
            // serveur. On CONTINUE de surveiller — un document se sauve
            // plusieurs fois de suite, et arreter au premier renvoi obligeait a
            // tout rouvrir pour la sauvegarde suivante. `edit_reset` re-arme
            // l'empreinte de reference sur la version qu'on vient d'envoyer :
            // la prochaine sauvegarde ressort donc bien comme un changement.
            if (x.editId) {
              const eid = x.editId;
              invoke("edit_reset", { id: eid }).catch(() => {});
              setEdits((prev) =>
                prev.map((p) =>
                  p.id === eid ? { ...p, state: "watching" as const } : p,
                ),
              );
              logEvent("info", "operation", t("app.log.resent", { name: x.name }));
              // La reference DISTANTE doit suivre aussi, sinon le renvoi
              // suivant se croit en conflit : le fichier du serveur a bien
              // change depuis l'ouverture… mais c'est NOUS qui venons de le
              // changer. On relit donc l'empreinte du fichier qu'on vient
              // d'envoyer et on la prend comme nouvelle reference.
              const ed = editsRef.current.find((p) => p.id === eid);
              if (ed)
                rc<{ item: { ModTime: string; Size: number } | null }>(
                  "operations/stat",
                  { fs: ed.dstFs, remote: ed.dstRemote },
                )
                  .then((r) => {
                    if (!r.item) return;
                    setEdits((prev) =>
                      prev.map((p) =>
                        p.id === eid
                          ? {
                              ...p,
                              baseRemoteMod: r.item!.ModTime,
                              baseRemoteSize: r.item!.Size,
                            }
                          : p,
                      ),
                    );
                  })
                  .catch(() => {});
            }
          }
        } catch (e) {
          // Job disparu (daemon rclone relance) : sans ca la ligne resterait
          // « en cours » a jamais — et bloquerait tout un telephone, qui ne
          // copie qu'un fichier a la fois. On la relance.
          if (/job not found/i.test(String(e))) failXfer(x.id, String(e));
          /* sinon daemon occupe : on retentera au prochain battement */
        }
      }
      // Relistage des panneaux apres des copies terminees, au plus toutes les
      // 2 s : une rafale de petits fichiers relistait a chaque fichier (couteux
      // sur un telephone, ou un gros dossier se liste lentement).
      if (anyFinished && !cancelled) refreshSoon();
    })();
    return () => {
      cancelled = true;
    };
  }, [tick, failXfer]);

  // ---- Journal des transferts ----------------------------------------------
  // On derive les evenements des TRANSITIONS de statut, en un seul endroit,
  // plutot que d'emailler des logs dans les six setXfers. Pour ne pas noyer le
  // rapport, on ne trace au fichier QUE les problemes (reprise, echec, annulation)
  // et un resume par lot — jamais chaque debut/fin de fichier.
  const loggedStatus = useRef<Map<number, string>>(new Map());
  // Bilan du CYCLE courant : on compte les transitions vers un etat final, pas
  // les transferts finaux presents dans la liste (les onglets Terminés/Échoués
  // gardent ceux des lots precedents, qui gonfleraient le total).
  const tally = useRef({ done: 0, error: 0, cancelled: 0 });
  useEffect(() => {
    for (const x of xfers) {
      const prev = loggedStatus.current.get(x.id);
      if (prev === x.status) continue;
      loggedStatus.current.set(x.id, x.status);
      const label = x.rel ? `${x.rel}/${x.name}` : x.name;
      if (x.status === "retry")
        logEvent(
          "warn",
          "transfert",
          t("app.log.retry", { n: x.attempts, label, err: x.error }),
        );
      else if (x.status === "error") {
        tally.current.error++;
        logEvent("error", "transfert", t("app.log.failed", { label, err: x.error }));
        // Renvoi d'edition echoue (fichier verrouille par l'appli ?) : on
        // repasse « modifie » pour que l'utilisateur puisse reessayer.
        if (x.editId) {
          const eid = x.editId;
          invoke("edit_set_uploading", { id: eid, uploading: false }).catch(
            () => {},
          );
          setEdits((prev) =>
            prev.map((p) => (p.id === eid ? { ...p, state: "changed" } : p)),
          );
        }
      } else if (x.status === "cancelled") {
        tally.current.cancelled++;
        logEvent("info", "transfert", t("app.log.cancelled", { label }));
        if (x.editId) {
          const eid = x.editId;
          invoke("edit_set_uploading", { id: eid, uploading: false }).catch(
            () => {},
          );
          setEdits((prev) =>
            prev.map((p) => (p.id === eid ? { ...p, state: "changed" } : p)),
          );
        }
      } else if (x.status === "done") {
        tally.current.done++; // compte, sans journaliser chaque fichier
      }
    }
    // Purge les transferts disparus (liste videe) pour ne pas fuir la memoire.
    if (xfers.length === 0) loggedStatus.current.clear();
  }, [xfers]);

  // Resume a la fin d'un lot : quand plus rien n'est en cours, une seule ligne
  // de bilan a partir du compteur du cycle (remis a zero apres). Cet effet est
  // declare APRES celui des transitions : il voit donc le compteur a jour.
  const wasPending = useRef(false);
  useEffect(() => {
    if (wasPending.current && !pending) {
      const { done, error, cancelled } = tally.current;
      if (done || error || cancelled)
        logEvent(
          error ? "warn" : "info",
          "transfert",
          t("app.log.batchDone", {
            done: tn("app.log.batchOk", done),
            failed: tn("app.log.batchFail", error),
            cancelled: tn("app.log.batchCancel", cancelled),
          }),
        );
      tally.current = { done: 0, error: 0, cancelled: 0 };
    }
    wasPending.current = pending;
  }, [pending, xfers]);

  // ---- Annulation / reprise manuelle ---------------------------------------
  const cancelXfer = useCallback(async (x: Xfer) => {
    // Marque d'abord : l'ordonnanceur ne doit pas le relancer entre-temps.
    setXfers((prev) =>
      prev.map((p) =>
        p.id === x.id ? { ...p, status: "cancelled" as const, speed: 0 } : p,
      ),
    );
    if (x.jobid)
      await rc("job/stop", { jobid: x.jobid }).catch(() => {
        /* job deja termine : rclone repond 404 */
      });
  }, []);

  const cancelAll = useCallback(() => {
    for (const x of xfersRef.current) {
      if (isFinal(x)) continue;
      if (x.jobid) rc("job/stop", { jobid: x.jobid }).catch(() => {});
    }
    setXfers((prev) =>
      prev.map((p) =>
        isFinal(p) ? p : { ...p, status: "cancelled" as const, speed: 0 },
      ),
    );
  }, []);

  // Remet un transfert echoue dans la file (compteur de tentatives remis a zero).
  const requeue = useCallback((ids: Set<number>) => {
    if (ids.size === 0) return;
    rejoinBatch(ids);
    setXfers((prev) =>
      prev.map((p) =>
        ids.has(p.id)
          ? {
              ...p,
              status: "queued" as const,
              attempts: 0,
              error: "",
              bytes: 0,
              speed: 0,
              nextTry: 0,
            }
          : p,
      ),
    );
    setTab("queue");
  }, []);
  const retryXfer = useCallback(
    (x: Xfer) => requeue(new Set([x.id])),
    [requeue],
  );
  const retryFailed = useCallback(() => {
    requeue(
      new Set(
        xfersRef.current.filter((x) => x.status === "error").map((x) => x.id),
      ),
    );
  }, [requeue]);
  // Relance en lot des ANNULES. Déclenchée uniquement par le bouton dédié de
  // l'onglet Annulés : « Tout relancer » de l'onglet Échoués ne touche jamais
  // aux annulés (arrêter un transfert soi-même n'est pas un raté). Ici, en
  // revanche, c'est un choix explicite de l'utilisateur — éviter de cliquer une
  // à une sur des centaines de croix.
  const retryCancelled = useCallback(() => {
    requeue(
      new Set(
        xfersRef.current
          .filter((x) => x.status === "cancelled")
          .map((x) => x.id),
      ),
    );
  }, [requeue]);

  // « Nettoyer » ne vide que l'onglet où on se trouve.
  const clearTab = useCallback((t: Tab) => {
    setXfers((prev) =>
      prev.filter((x) =>
        t === "done"
          ? x.status !== "done"
          : t === "cancelled"
            ? x.status !== "cancelled"
            : x.status !== "error",
      ),
    );
  }, []);

  // Copier / coller facon FileZilla (Ctrl+C sur le panneau actif, Ctrl+V colle).
  const doCopy = useCallback((pane: PaneId) => {
    const p = panes.current[pane];
    if (p.selected.length && paneEnabled.current[pane]) {
      clipboard.current = { pane, loc: p.loc, dir: p.dir, items: p.selected };
      setClipboardReady(true);
    }
  }, []);
  // Coller fonctionne dans les deux panneaux, y compris celui d'ou vient la
  // copie (copier ailleurs sur le meme serveur, par exemple) : les garde-fous
  // « meme dossier » sont dans startTransfers.
  const doPaste = useCallback(
    (pane: PaneId) => {
      if (clipboard.current) startTransfers(clipboard.current, pane);
    },
    [startTransfers],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "SELECT") return;
      // Prompt ouvert : pas de copier/coller derriere la modale.
      if (anyModal) return;
      if (!active) return;
      if (e.key === "c") doCopy(active);
      else if (e.key === "v") doPaste(active);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, doCopy, doPaste, anyModal]);

  // Deselection totale : clic en dehors des deux panneaux, OU la fenetre
  // Copiteur perd le focus (clic dans une autre appli).
  useEffect(() => {
    const deselect = () => {
      setActive(null);
      panes.current.left.clearSelection();
      panes.current.right.clearSelection();
      // Le panneau garde sinon le focus clavier : au retour du focus dans la
      // fenetre (fin d'un deplacement par la barre du haut), le navigateur le
      // lui rendait et il se re-selectionnait aussitot.
      // Jamais un champ de saisie (barre d'adresse, recherche) : on perdrait ce
      // qu'on tapait, par exemple en allant copier un chemin dans le Finder.
      const el = document.activeElement as HTMLElement | null;
      if (el && el.closest(".explorer") && !el.matches("input, textarea")) el.blur();
    };
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      // Element retire de la page par le clic lui-meme (le fil d'Ariane qui
      // laisse place a la barre d'adresse) : il n'est plus « dans » un panneau,
      // mais le clic y a bien eu lieu. Le prendre pour un clic exterieur
      // refermait aussitot la barre d'adresse.
      if (!target.isConnected) return;
      if (!target.closest(".explorer")) deselect();
    };
    // Une zone de deplacement de fenetre (barre du haut) ne produit jamais de
    // « click » : le systeme prend la main des l'appui pour deplacer la
    // fenetre. On deselectionne donc des l'appui sur une telle zone (hors
    // boutons, qui gardent leur clic normal).
    const onDown = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest("[data-tauri-drag-region]") && !el.closest("button")) deselect();
    };
    window.addEventListener("click", onClick);
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("blur", deselect);
    return () => {
      window.removeEventListener("click", onClick);
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("blur", deselect);
    };
  }, []);

  // Toutes les listes derivees de `xfers` sont recalculees ICI, en un seul
  // passage memoise sur `xfers`. Elles sont sur le CHEMIN CHAUD : sans memo,
  // trier/filtrer/sommer des dizaines de milliers de transferts se refaisait a
  // chaque battement d'horloge (600 ms) alors que rien n'avait bouge, ce qui
  // participait au gel sur les gros dossiers. Le tri et les sommes ne se
  // relancent donc plus que quand `xfers` change reellement.
  const { queue, done, failed, cancelled, totalBytes, doneBytes, anyRunning } =
    useMemo(() => {
      // File d'attente : en cours EN HAUT, puis les reprises, puis l'attente.
      const RANK = { running: 0, starting: 1, retry: 2, queued: 3 } as const;
      const queue = xfers
        .filter((x) => !isFinal(x))
        .sort(
          (a, b) =>
            RANK[a.status as keyof typeof RANK] -
              RANK[b.status as keyof typeof RANK] || a.id - b.id,
        );
      // Trois etats finaux, trois onglets. Les annules avaient leur place avec
      // les echecs ; or arreter un transfert soi-meme n'est pas un rate, et les
      // melanger faisait passer une action volontaire pour un probleme. Le plus
      // recent en premier partout.
      const done = xfers.filter((x) => x.status === "done").reverse();
      const failed = xfers.filter((x) => x.status === "error").reverse();
      const cancelled = xfers.filter((x) => x.status === "cancelled").reverse();

      // Progression GLOBALE du lot : elle doit compter les fichiers DEJA
      // termines, sinon la barre reste collee a 0 % pendant que la file se vide
      // (les termines quittent `queue`). On somme donc sur tout le lot courant
      // (ids > ancre), termines compris ; un termine compte pour sa taille
      // pleine, un transfert en cours pour ses octets partiels, un en attente
      // pour zero. Echecs/annulations exclus : octets abandonnes, ni « restant »
      // ni « fait ». `totalBytes - doneBytes` redonne exactement le nombre
      // d'octets restants (les termines s'annulent entre les deux sommes).
      const anchor = batchAnchorRef.current;
      let totalBytes = 0;
      let doneBytes = 0;
      for (const x of xfers) {
        if (x.id <= anchor || x.status === "error" || x.status === "cancelled")
          continue;
        totalBytes += x.size;
        // Borne de securite a la taille du fichier : un compteur rclone qui
        // deborde (octets d'une tentative precedente non remis a zero, cf.
        // `core/stats-reset` au lancement) ne doit jamais faire afficher plus
        // de 100 % au lot.
        doneBytes +=
          x.status === "done"
            ? x.size
            : x.status === "running"
              ? Math.min(x.bytes, x.size)
              : 0;
      }

      const anyRunning = queue.some(
        (x) => x.status === "running" || x.status === "starting",
      );
      return {
        queue,
        done,
        failed,
        cancelled,
        totalBytes,
        doneBytes,
        anyRunning,
      };
    }, [xfers]);

  const remaining = Math.max(0, totalBytes - doneBytes);
  const pct = totalBytes > 0 ? Math.round((doneBytes / totalBytes) * 100) : 0;
  // Debit et temps restant s'appuient sur la mesure lissee (cf. l'effet plus
  // haut), pas sur la somme instantanee des debits par fichier.
  const eta = smoothSpeed > 1024 ? remaining / smoothSpeed : 0;
  const etaText =
    eta > 0
      ? eta < 60
        ? t("app.bar.etaSec", { s: Math.ceil(eta) })
        : t("app.bar.etaMin", { m: Math.round(eta / 60) })
      : "";
  // « Connexion perdue » n'est vrai que si TOUT est a l'arret. Si des transferts
  // tournent encore, le lien n'est PAS perdu : les items en reprise attendent
  // juste un creneau libre (ou un petit backoff). On evite ainsi le bandeau
  // alarmant « connexion perdue » alors que la copie avance en parallele.
  const reconnecting =
    !anyRunning && queue.some((x) => x.status === "retry");
  // TOUT ce qui tourne est fige : plus un octet ne passe nulle part. On le dit
  // au lieu de laisser le debit moyen s'eteindre en douceur, ce qui donne
  // l'illusion que ca avance. On ne coupe rien pour autant : les vrais delais
  // reseau gardent la main sur la decision d'abandonner. `Date.now()` en depend :
  // hors du memo, sinon il se figerait sur l'instantane d'`xfers`.
  const running = queue.filter(
    (x) => x.status === "running" || x.status === "starting",
  );
  const allStalled =
    running.length > 0 && running.every((x) => isStalled(x, Date.now()));
  // Un nouveau lot fait apparaitre la zone des transferts — sauf si on l'avait
  // cachee expres (le bouton Transferts montre alors la progression).
  const activeCount = queue.length + preparing;
  const prevActive = useRef(0);
  useEffect(() => {
    if (activeCount > 0 && prevActive.current === 0 && !userHidXfer.current) setXferOpen(true);
    prevActive.current = activeCount;
  }, [activeCount]);
  // Resume des transferts : en-tete de l'îlot et bouton-pilule de la barre.
  const xferState: XferSummary["state"] =
    queue.length === 0 ? "idle" : reconnecting || allStalled ? "retry" : "run";
  const summary: XferSummary = {
    active: activeCount,
    pct: queue.length > 0 ? pct : null,
    line:
      queue.length === 0
        ? t("chrome.xfer.idle")
        : xferState === "retry"
          ? t("chrome.xfer.paused")
          : `${t("common.perSecond", { size: humanSize(smoothSpeed) })} · ${t("chrome.xfer.remaining", { size: humanSize(remaining) })}${etaText}`,
    state: xferState,
  };
  // Le bouton Transferts montre / cache la zone EN ENTIER (le chevron de
  // l'îlot, lui, la replie sur sa ligne de resume).
  const toggleXfer = () => {
    const next = !xferOpen;
    userHidXfer.current = !next;
    setXferOpen(next);
  };
  // Chevron de l'îlot : meme effet que le bouton Transferts quand la zone est
  // ouverte (cachee entierement, le bouton reprend la progression).
  const hideXfer = () => {
    userHidXfer.current = true;
    setXferOpen(false);
  };
  // Zone cachee pendant une copie : le bouton s'etire en pilule de progression.
  const showProgress = !xferOpen && summary.active > 0;
  // ---- Panneaux : source resolue, selecteur, message d'attente --------------
  type PaneView = {
    loc: Loc;
    enabled: boolean;
    // Change a chaque (re)connexion : remonte le panneau (relistage).
    epoch: number;
    startAt?: string;
    placeholder?: ReactNode;
    busy: boolean;
    icon: "computer" | "server" | "phone" | null;
  };
  // Message affiche a la place de la liste (+ bouton d'action eventuel). Il
  // arrete l'appui souris : sinon le lasso du panneau capturerait le pointeur
  // et le bouton ne recevrait jamais son clic.
  const paneMsg = (text: string, action?: { label: string; run: () => void }, spin = false) => (
    <div className="pane-msg" onPointerDown={(e) => e.stopPropagation()}>
      {spin && <span className="ctx-spinner" />}
      <span className="pane-msg-text">{text}</span>
      {action && (
        <button className="btn-ghost pane-msg-btn" onClick={action.run}>
          {action.label}
        </button>
      )}
    </div>
  );
  const viewOf = (pane: PaneId): PaneView => {
    const s = srcs[pane];
    if (s.kind === "local")
      return {
        loc: { kind: "local", remote: "", key: "local", label: localLabel },
        enabled: true,
        epoch: 0,
        busy: false,
        icon: "computer",
      };
    if (s.kind === "server") {
      const c = conns[s.label];
      const loc: Loc = { kind: "server", remote: c?.remote ?? "", key: srcKey(s), label: s.label };
      if (c?.state === "ok")
        return { loc, enabled: true, epoch: c.epoch, startAt: c.startAt, busy: false, icon: "server" };
      const saved = servers.find((x) => x.label === s.label);
      const placeholder =
        c?.state === "connecting"
          ? paneMsg(t("app.src.connecting", { name: s.label }), undefined, true)
          : !saved
            ? paneMsg(t("app.src.serverGone", { name: s.label }))
            : paneMsg(c?.state === "error" ? c.err : t("app.src.notConnected", { name: s.label }), {
                label: c?.state === "error" ? t("common.retry") : t("app.conn.connect"),
                run: () => openServer(saved, pane, true),
              });
      return { loc, enabled: false, epoch: c?.epoch ?? 0, placeholder, busy: c?.state === "connecting", icon: "server" };
    }
    if (s.kind === "phone") {
      const ph = phones.find((p) => p.id === s.id);
      const name = ph?.name || s.name || t("app.phone.generic");
      const loc: Loc = { kind: "phone", remote: ph?.remote ?? "", key: srcKey(s), label: name };
      if (ph?.state === "ready" && ph.remote)
        return { loc, enabled: true, epoch: 0, busy: false, icon: "phone" };
      const retry = { label: t("common.retry"), run: () => retryPhone(s.id) };
      const placeholder = !ph
        ? paneMsg(t("app.phone.unplugged", { name }))
        : ph.state === "connecting" || (ph.state === "ready" && !ph.remote)
          ? paneMsg(t("app.phone.connecting", { name }), undefined, true)
          : ph.state === "locked"
            ? paneMsg(t("app.phone.locked", { name }), retry)
            : ph.state === "busy"
              ? paneMsg(t("app.phone.busy", { name }), retry)
              : paneMsg(
                  ph.error ? t("app.phone.error", { name, err: ph.error }) : t("app.phone.errorUnknown", { name }),
                  retry,
                );
      return { loc, enabled: false, epoch: 0, placeholder, busy: ph?.state === "connecting", icon: "phone" };
    }
    return {
      loc: { kind: "local", remote: "", key: "none", label: t("app.src.pick") },
      enabled: false,
      epoch: 0,
      placeholder: paneMsg(t("app.src.pickHint")),
      busy: false,
      icon: null,
    };
  };
  const views: Record<PaneId, PaneView> = { left: viewOf("left"), right: viewOf("right") };
  paneEnabled.current = { left: views.left.enabled, right: views.right.enabled };

  // Etat court d'un telephone, a cote de son nom dans le selecteur.
  const phoneDetail = (ph: Phone): string =>
    ph.state === "ready"
      ? t("app.phone.usb")
      : ph.state === "locked"
        ? t("app.phone.stateLocked")
        : ph.state === "busy"
          ? t("app.phone.stateBusy")
          : ph.state === "connecting"
            ? t("chrome.conn.connecting")
            : t("app.phone.stateError");
  // Menu du selecteur de source d'un panneau.
  const menuFor = (pane: PaneId): SourceMenuItem[] => {
    const cur = srcs[pane];
    const items: SourceMenuItem[] = [
      { type: "header", text: isMac ? t("app.src.thisMac") : t("app.src.thisPc") },
      { type: "item", id: "local", icon: "computer", text: localLabel, checked: cur.kind === "local" },
    ];
    if (phonesSupported) {
      items.push({ type: "header", text: t("app.src.phones") });
      if (!phones.length) items.push({ type: "note", text: t("app.src.noPhone") });
      for (const ph of phones)
        items.push({
          type: "item",
          id: `phone:${ph.id}`,
          icon: "phone",
          text: ph.name,
          detail: phoneDetail(ph),
          checked: cur.kind === "phone" && cur.id === ph.id,
        });
    }
    items.push({ type: "header", text: t("app.src.servers") });
    if (!servers.length) items.push({ type: "note", text: t("chrome.conn.none") });
    for (const sv of servers) {
      const c = conns[sv.label];
      items.push({
        type: "item",
        id: `server:${sv.label}`,
        icon: "server",
        text: sv.label,
        detail:
          c?.state === "ok"
            ? t("app.src.connected")
            : c?.state === "connecting"
              ? t("chrome.conn.connecting")
              : sv.locked
                ? t("app.src.pin")
                : undefined,
        checked: cur.kind === "server" && cur.label === sv.label,
      });
    }
    items.push({ type: "item", id: "new", icon: "plus", text: t("app.src.addServer") });
    if (cur.kind === "server" && servers.some((x) => x.label === cur.label)) {
      items.push(
        { type: "sep" },
        { type: "item", id: "edit", text: t("app.src.editServer") },
        { type: "item", id: "rename", text: t("app.src.renameServer") },
        { type: "item", id: "forget", text: t("chrome.conn.forget") },
        { type: "item", id: "disconnect", text: t("chrome.conn.disconnect"), disabled: !conns[cur.label] },
      );
    }
    return items;
  };
  const onPick = (pane: PaneId, id: string) => {
    const cur = srcs[pane];
    if (id === "local") {
      setPaneSrc(pane, { kind: "local" });
      setActive(pane);
    } else if (id.startsWith("phone:")) openPhone(id.slice(6), pane);
    else if (id.startsWith("server:")) {
      const sv = servers.find((x) => x.label === id.slice(7));
      if (sv) pickServer(sv, pane);
    } else if (id === "new") newConnection(pane);
    else if (cur.kind === "server") {
      if (id === "edit") editConnection(cur.label, pane);
      else if (id === "rename") setRenameSrv({ old: cur.label, value: cur.label });
      else if (id === "forget") forgetServer(cur.label);
      else if (id === "disconnect") disconnectServer(cur.label);
    }
  };
  const renderPane = (pane: PaneId) => {
    const v = views[pane];
    const s = srcs[pane];
    const serverLabel = s.kind === "server" ? s.label : null;
    return (
      <FilePane
        // Changer de source (ou se reconnecter) remonte le panneau : historique,
        // selection et arbre repartent de zero, sur la nouvelle source.
        key={`${pane}|${v.loc.key}|${v.epoch}`}
        pane={pane}
        loc={v.loc}
        picker={
          <SourcePicker
            icon={v.icon}
            label={v.loc.label}
            busy={v.busy}
            items={menuFor(pane)}
            onPick={(id) => onPick(pane, id)}
          />
        }
        placeholder={v.placeholder}
        rootLabel={v.loc.kind === "local" ? (isMac ? "Macintosh HD" : undefined) : v.loc.label}
        enabled={v.enabled}
        anyModal={anyModal}
        active={active === pane}
        onFocus={() => focusPane(pane)}
        bus={panes.current[pane]}
        onDropItems={startTransfers}
        onCopy={doCopy}
        onPaste={doPaste}
        hasClipboard={clipboardReady}
        busyRef={busyRef}
        showHidden={settings.showHidden}
        showNetworkDrives={settings.showNetworkDrives}
        pins={v.enabled ? pinsFor(v.loc.key) : []}
        onPin={(path, label) => pinFolder(v.loc.key, path, label)}
        onUnpin={(path) => unpinFolder(v.loc.key, path)}
        onReorderPin={(from, to, after) => reorderPins(v.loc.key, from, to, after)}
        onOpenRemote={v.loc.kind === "local" ? undefined : openRemote}
        connKey={v.epoch}
        startAt={v.loc.kind === "local" ? undefined : (v.startAt ?? "/")}
        startDir={serverLabel ? (servers.find((x) => x.label === serverLabel)?.startDir ?? "") : ""}
        onSetStartDir={serverLabel ? (path) => setStartDir(serverLabel, path) : undefined}
      />
    );
  };
  // Bouton « telephone » de la barre du haut (macOS) : les telephones branches
  // qui ne sont encore ouverts dans aucun panneau, avec Ouvrir a gauche / a
  // droite. Remplace l'ancien bandeau, qui mangeait de la hauteur.
  const waitingPhones = phones.filter(
    (ph) => !PANES.some((k) => srcs[k].kind === "phone" && (srcs[k] as { id: string }).id === ph.id),
  );
  const phoneState = (ph: Phone): string =>
    ph.state === "ready"
      ? t("app.phone.bannerReady", {
          used: humanSize(ph.storages.reduce((n, st) => n + Math.max(0, st.total - st.free), 0)),
        })
      : ph.state === "locked"
        ? t("app.phone.bannerLocked")
        : ph.state === "busy"
          ? t("app.phone.bannerBusy")
          : t("app.phone.bannerOther");
  const phoneToolbar: { title: string; tip: string; entries: MacMenuEntry[] } | null = waitingPhones.length
    ? {
        title:
          waitingPhones.length === 1
            ? waitingPhones[0].name
            : t("app.phone.several", { n: String(waitingPhones.length) }),
        tip: t("app.phone.toolbarTip"),
        entries: waitingPhones.flatMap((ph, i) => [
          ...(i > 0 ? [{ separator: true }] : []),
          { header: true, title: `${ph.name} · ${phoneState(ph)}` },
          { id: `left:${ph.id}`, title: t("app.phone.openLeft"), symbol: "rectangle.lefthalf.inset.filled" },
          { id: `right:${ph.id}`, title: t("app.phone.openRight"), symbol: "rectangle.righthalf.inset.filled" },
        ]),
      }
    : null;
  // macOS : barre d'outils NATIVE (cf. chrome_mac.rs) ; rend sa hauteur.
  const tbH = useMacChrome({
    appVersion,
    phone: phoneToolbar,
    showProgress,
    summary,
    handlers: {
      phone: (entry) => {
        const i = entry.indexOf(":");
        if (i < 0) return;
        const side = entry.slice(0, i);
        if (side === "left" || side === "right") openPhone(entry.slice(i + 1), side);
      },
      toggleTransfers: toggleXfer,
      journal: () => setShowJournal(true),
      settings: () => setShowSettings(true),
    },
  });
  // Meme progression globale reportee sur l'icone de l'app : bouton de la barre
  // des taches sous Windows (comme une copie de l'Explorateur), icone du Dock
  // sous macOS. Jaune (« en pause ») quand la copie est figee ou reconnecte,
  // indeterminee tant que le lot n'a pas encore de taille connue, effacee quand
  // la file est vide. Dedoublonne : `pct` est entier, on n'appelle l'OS qu'a
  // chaque changement reel, pas a chaque tick de sondage.
  const taskbarKey =
    queue.length === 0
      ? "none"
      : totalBytes === 0
        ? "indeterminate"
        : `${reconnecting || allStalled ? "paused" : "normal"}:${pct}`;
  const taskbarKeyRef = useRef("none");
  useEffect(() => {
    if (taskbarKeyRef.current === taskbarKey) return;
    taskbarKeyRef.current = taskbarKey;
    const [kind] = taskbarKey.split(":");
    const status =
      kind === "none"
        ? ProgressBarStatus.None
        : kind === "indeterminate"
          ? ProgressBarStatus.Indeterminate
          : kind === "paused"
            ? ProgressBarStatus.Paused
            : ProgressBarStatus.Normal;
    appWindow
      .setProgressBar({ status, progress: Math.min(100, Math.max(0, pct)) })
      .catch(() => {});
  }, [taskbarKey, pct]);
  return (
    <div
      className="app"
      data-os={osName}
      style={{ ["--tb-h" as string]: `${tbH}px` }}
      onContextMenu={(e) => {
        // Coupe le menu natif du navigateur partout, sauf dans les champs texte.
        if (!(e.target as HTMLElement).closest("input, textarea"))
          e.preventDefault();
      }}
    >
      {isMac ? (
        // macOS : la barre d'outils est NATIVE (dessinee par AppKit au-dessus de
        // la webview) ; on ne fait que lui reserver sa hauteur. Cette bande,
        // sous la barre, recoit les clics dans ses vides -> zone de deplacement.
        <div className="tb-band" data-tauri-drag-region />
      ) : (
        <WinTitleBar
          version={appVersion}
          right={
            <>
              <MorphButton
                expanded={showProgress}
                summary={summary}
                on={xferOpen}
                title={t(xferOpen ? "chrome.xfer.hideAll" : "chrome.xfer.show")}
                onClick={toggleXfer}
              />
              <button className="w11-tool" title={t("app.conn.journalTitle")} onClick={() => setShowJournal(true)}>
                <UiIcon name="journal" />
              </button>
              <button className="w11-tool" title={t("app.conn.settings")} onClick={() => setShowSettings(true)}>
                <span className="w11-glyph" aria-hidden>
                  &#xE713;
                </span>
              </button>
            </>
          }
        />
      )}

      {notice && <div className="conn-error">{notice}</div>}

      <div className="shell">
        <main className="explorers">
          {renderPane("left")}
          {renderPane("right")}
        </main>
        {/* Îlot des transferts sous les panneaux. Toujours monte : il apparait
            et disparait en ANIMANT sa hauteur (cf. chrome.css). */}
        <div
          className={"transfers-host" + (xferOpen ? "" : " is-hidden")}
          aria-hidden={!xferOpen}
        >
          <TransfersPanel
            queue={queue}
            done={done}
            failed={failed}
            cancelled={cancelled}
            edits={edits}
            tab={tab}
            onTab={setTab}
            preparing={preparing}
            now={Date.now()}
            settings={settings}
            onCancel={cancelXfer}
            onCancelAll={cancelAll}
            onRetry={retryXfer}
            onRetryFailed={retryFailed}
            onRetryCancelled={retryCancelled}
            onClear={clearTab}
            onEditResend={resendEdit}
            onEditStop={stopEdit}
            summary={summary}
            onHide={hideXfer}
          />
        </div>
      </div>

      {showSettings && (
        <SettingsDialog
          settings={settings}
          appVersion={appVersion}
          onCheckUpdates={updater.checkNow}
          onSave={(s) => {
            setSettings(s);
            saveSettings(s);
          }}
          onClose={() => setShowSettings(false)}
        />
      )}

      {showJournal && (
        <JournalDialog
          settings={settings}
          rcloneVersion={version}
          onClose={() => setShowJournal(false)}
        />
      )}

      {/* Dialogue de conflit : fichier deja present a destination. */}
      {conflict && (
        <div className="modal-backdrop">
          <div className="modal">
            <div className="modal-title">{t("app.conflict.title")}</div>
            <div className="modal-body">
              {tx("app.conflict.body", { name: <strong>{conflict.name}</strong> })}
            </div>
            <label className="modal-check">
              <input
                type="checkbox"
                checked={conflictAll}
                onChange={(e) => setConflictAll(e.target.checked)}
              />
              {t("app.conflict.applyAll")}
            </label>
            <div className="modal-actions">
              <button className="btn-ghost" onClick={() => resolveConflict("ignore")}>
                {t("app.conflict.skip")}
              </button>
              <button className="btn-accent" onClick={() => resolveConflict("replace")}>
                {t("app.conflict.replace")}
              </button>
            </div>
          </div>
        </div>
      )}

      {renameAsk && (
        <div className="modal-backdrop">
          <div className="modal">
            <div className="modal-title">{t("app.rename.title")}</div>
            <div className="modal-body">
              {tx("app.rename.body", {
                name: <strong>{renameAsk.name}</strong>,
                chars: <code>{'\\ / : * ? " < > |'}</code>,
              })}
              <br />
              <br />
              {tx("app.rename.ask", {
                name: <strong>{sanitizeName(renameAsk.name)}</strong>,
              })}
              <label className="modal-check">
                <input
                  type="checkbox"
                  checked={renameAll}
                  onChange={(ev) => setRenameAll(ev.target.checked)}
                />
                {t("app.rename.applyAll")}
              </label>
            </div>
            <div className="modal-actions">
              <button
                className="btn-ghost"
                onClick={() => {
                  const id = renameAsk.id;
                  setRenameAsk(null);
                  declineRename(id);
                }}
              >
                {t("app.rename.drop")}
              </button>
              <button
                className="btn-accent"
                onClick={() => {
                  const x = renameAsk;
                  // C'est ICI que la case prend effet, pas au moment ou on la
                  // coche : on doit pouvoir se raviser avant de valider.
                  renameAllRef.current = renameAll;
                  setRenameAsk(null);
                  retryRenamed(x);
                }}
              >
                {t("app.rename.confirm")}
              </button>
            </div>
          </div>
        </div>
      )}

      {closeAsk && (
        <div className="modal-backdrop is-top">
          <div className="modal">
            <div className="modal-title">
              {xfers.some((x) => !isFinal(x)) || preparing > 0
                ? t("app.close.titleXfers")
                : t("app.close.titleEdits")}
            </div>
            <div className="modal-body">
              {(() => {
                const n = xfers.filter((x) => !isFinal(x)).length + preparing;
                const e = edits.filter((x) => x.state !== "watching").length;
                return (
                  <>
                    {n > 0 && <>{tn("app.close.xfers", n)} </>}
                    {e > 0 && <>{tn("app.close.edits", e)} </>}
                    {t("app.close.lose")}
                  </>
                );
              })()}
            </div>
            <div className="modal-actions">
              <button className="btn-ghost" onClick={() => setCloseAsk(false)}>
                {t("common.cancel")}
              </button>
              <button
                className="btn-accent"
                onClick={() => invoke("force_quit").catch(() => appWindow.destroy())}
              >
                {t("app.close.force")}
              </button>
            </div>
          </div>
        </div>
      )}

      {updater.dialog}

      {/* Premier lancement : choix de la langue (cf. i18n). */}
      <FirstRunLanguage />

      {/* Identite du serveur : 1re connexion (empreinte a accepter) ou cle qui
          a change depuis la derniere fois (alerte). */}
      {hostKeyAsk && (
        <div className="modal-backdrop is-above-sheet">
          <div className="modal modal-hostkey">
            <div className="modal-title">
              {hostKeyAsk.status === "changed"
                ? t("app.hostkey.titleChanged")
                : t("app.hostkey.titleNew")}
            </div>
            <div className="modal-body">
              {hostKeyAsk.status === "changed" ? (
                <>
                  {tx("app.hostkey.changedBody", {
                    server: (
                      <strong>
                        {hostKeyAsk.host}:{hostKeyAsk.port}
                      </strong>
                    ),
                  })}
                  <div className="hostkey-label">{t("app.hostkey.stored")}</div>
                  <code className="hostkey-fp is-old">{hostKeyAsk.previous}</code>
                  <div className="hostkey-label">{t("app.hostkey.presented")}</div>
                  <code className="hostkey-fp">
                    {hostKeyAsk.algo} {hostKeyAsk.fingerprint}
                  </code>
                  <div className="modal-hint">
                    {t("app.hostkey.changedHint")}
                  </div>
                </>
              ) : (
                <>
                  {tx("app.hostkey.newBody", {
                    server: (
                      <strong>
                        {hostKeyAsk.host}:{hostKeyAsk.port}
                      </strong>
                    ),
                  })}
                  <code className="hostkey-fp">
                    {hostKeyAsk.algo} {hostKeyAsk.fingerprint}
                  </code>
                  <div className="modal-hint">
                    {t("app.hostkey.newHint")}
                  </div>
                </>
              )}
            </div>
            <div className="modal-actions">
              {/* Le focus quitte la feuille de connexion dessous : sinon Entree y
                  relancait la connexion et orphelinait cette question. */}
              <button
                className="btn-ghost"
                autoFocus={hostKeyAsk.status === "changed"}
                onClick={() => answerHostKey(false)}
              >
                {t("common.cancel")}
              </button>
              <button
                className={
                  hostKeyAsk.status === "changed" ? "btn-accent btn-danger" : "btn-accent"
                }
                autoFocus={hostKeyAsk.status !== "changed"}
                onClick={() => answerHostKey(true)}
              >
                {hostKeyAsk.status === "changed"
                  ? t("app.hostkey.trustNew")
                  : t("app.hostkey.trust")}
              </button>
            </div>
          </div>
        </div>
      )}

      {pinAsk && (
        <PinDialog
          key={pinAsk.label}
          label={pinAsk.label}
          onCancel={() => setPinAsk(null)}
          onOk={pinAsk.onOk}
        />
      )}

      {/* macOS : l'app tourne depuis son .dmg monte, pas encore installee. */}
      {dmgMount && (
        <div className="modal-backdrop">
          <div className="modal">
            <div className="modal-title">{t("app.dmg.title")}</div>
            <div className="modal-body">
              {tx("app.dmg.body", { mount: <strong>{dmgMount}</strong> })}
            </div>
            <div className="modal-actions">
              <button
                className="btn-ghost"
                onClick={() => setDmgMount(null)}
                disabled={dmgMoving}
              >
                {t("app.dmg.stay")}
              </button>
              <button
                className="btn-accent"
                disabled={dmgMoving}
                onClick={() => {
                  setDmgMoving(true);
                  invoke("move_to_applications").catch((e) => {
                    setDmgMoving(false);
                    logEvent(
                      "error",
                      "operation",
                      t("app.log.moveFailed", { err: String(e) }),
                    );
                  });
                  // Succes = l'app quitte cote Rust (app.exit) ; rien d'autre
                  // a faire ici, la fenetre va se fermer.
                }}
              >
                {dmgMoving ? t("app.dmg.moving") : t("app.dmg.move")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirmation « le fichier edite a change — le renvoyer ? » */}
      {editAsk && (
        <div className="modal-backdrop" onMouseDown={() => ignoreEdit(editAsk.id)}>
          <div className="modal" onMouseDown={(ev) => ev.stopPropagation()}>
            <div className="modal-title">{t("app.edit.title")}</div>
            <div className="modal-body">
              {tx("app.edit.body", { name: <strong>{editAsk.label}</strong> })}
            </div>
            <div className="modal-actions">
              <button
                className="btn-ghost"
                onClick={() => ignoreEdit(editAsk.id)}
              >
                {t("app.edit.ignore")}
              </button>
              <button
                className="btn-accent"
                onClick={() => {
                  const e = edits.find((x) => x.id === editAsk.id);
                  if (e) resendEdit(e);
                }}
              >
                {t("app.edit.resend")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Conflit : le fichier a change (ou disparu) sur le serveur depuis
          l'ouverture. On previent avant d'ecraser. */}
      {conflictAsk && (
        <div
          className="modal-backdrop"
          onMouseDown={() => setConflictAsk(null)}
        >
          <div className="modal" onMouseDown={(ev) => ev.stopPropagation()}>
            <div className="modal-title">{t("app.editConflict.title")}</div>
            <div className="modal-body">
              {conflictAsk.reason === "deleted" ? (
                tx("app.editConflict.deleted", {
                  name: <strong>{conflictAsk.e.label}</strong>,
                })
              ) : (
                tx("app.editConflict.changed", {
                  name: <strong>{conflictAsk.e.label}</strong>,
                  overwrite: <strong>{t("app.editConflict.overwriteWord")}</strong>,
                })
              )}
            </div>
            <div className="modal-actions">
              <button
                className="btn-ghost"
                onClick={() => setConflictAsk(null)}
              >
                {t("common.cancel")}
              </button>
              <button
                className="btn-accent btn-danger"
                onClick={() => doResend(conflictAsk.e)}
              >
                {conflictAsk.reason === "deleted"
                  ? t("app.edit.resend")
                  : t("app.editConflict.overwrite")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Feuille de connexion (nouveau serveur / modification) et renommage. */}
      {connectSheet && (
        <ConnectSheet
          mode={connectSheet}
          name={name}
          host={host}
          user={user}
          pass={pass}
          port={port}
          setName={setName}
          setHost={setHost}
          setUser={setUser}
          setPass={setPass}
          pinOn={pinOn}
          setPinOn={setPinOn}
          pin={sheetPin}
          setPin={setSheetPin}
          setPort={setPort}
          connecting={sheetConn?.state === "connecting"}
          error={sheetConn?.state === "error" ? sheetConn.err : ""}
          onConnect={connectFromSheet}
          onClose={() => {
            setConnectSheet(null);
            setSheetLabel(null);
          }}
        />
      )}
      {renameSrv && (
        <div className="modal-backdrop" onMouseDown={() => setRenameSrv(null)}>
          <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
            <div className="modal-title">{t("chrome.rename.title")}</div>
            <div className="modal-body">
              <input
                className="sheet-field sheet-rename"
                autoFocus
                aria-label={t("chrome.rename.label")}
                value={renameSrv.value}
                onChange={(e) => setRenameSrv({ ...renameSrv, value: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && renameSrv.value.trim()) {
                    renameServer(renameSrv.old, renameSrv.value.trim());
                    setRenameSrv(null);
                  } else if (e.key === "Escape") setRenameSrv(null);
                }}
              />
            </div>
            <div className="modal-actions">
              <button className="btn-ghost" onClick={() => setRenameSrv(null)}>
                {t("common.cancel")}
              </button>
              <button
                className="btn-accent"
                disabled={!renameSrv.value.trim()}
                onClick={() => {
                  renameServer(renameSrv.old, renameSrv.value.trim());
                  setRenameSrv(null);
                }}
              >
                {t("common.rename")}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
