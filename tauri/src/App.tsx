import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openPath } from "@tauri-apps/plugin-opener";
import "./App.css";
import {
  rc,
  REMOTE,
  humanSize,
  listArgs,
  fileAddr,
  resolveRemoteStart,
  humanConnError,
  planItem,
  loadSettings,
  saveSettings,
  xferConfig,
  isFinal,
  hasBadChars,
  sanitizeName,
  type Side,
  type PaneBus,
  type Payload,
  type Server,
  type Settings,
  type Xfer,
  type EditItem,
} from "./files";
import { FilePane } from "./FilePane";
import { ServersDropdown } from "./ServersDropdown";
import { SettingsDialog } from "./SettingsDialog";
import { TransfersPanel, isStalled, type Tab } from "./TransfersPanel";
import { JournalDialog } from "./JournalDialog";
import { logEvent } from "./journal";
import { UiIcon } from "./icons";

const appWindow = getCurrentWindow();
const isMac = navigator.userAgent.includes("Macintosh");
const isWin = navigator.userAgent.includes("Windows");
const osName = isMac ? "macos" : isWin ? "windows" : "linux";

// Erreurs "reseau" : coupure du tunnel, 4G qui decroche, NAS qui redemarre…
// Elles declenchent la reprise AUTOMATIQUE. Tout le reste (droits refuses,
// disque plein, fichier introuvable) est un echec definitif : le reessayer en
// boucle ne servirait a rien.
const NETWORK_ERROR =
  /(connection|connexion|timeout|timed out|deadline|EOF|broken pipe|reset|unreachable|refused|no route|network|handshake|dial |lookup |i\/o error|closed)/i;

// Erreurs TRANSITOIRES cote rclone qui reussissent a la reprise. « can't move
// object - incompatible remotes » survient par intermittence sur un copyfile
// (rename du fichier .partial, avec des fs instancies sous des `_config`
// divergents en pleine concurrence) : constate ~25 fois sur 295, chaque fois OK
// au 2e essai. On la traite donc comme une coupure reseau : reprise auto.
const RETRYABLE_ERROR = /(incompatible remotes|can't move object|can't copy)/i;

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

export default function App() {
  const [active, setActive] = useState<Side | null>("local");
  const [connected, setConnected] = useState(false);
  // Incremente a chaque connexion reussie. Sert de « jeton » au panneau distant :
  // meme si `connected` reste vrai (on passe d'un serveur a un autre), le
  // changement de jeton force le relistage depuis la racine du NOUVEAU serveur.
  const [connKey, setConnKey] = useState(0);
  // Dossier d'ouverture du panneau serveur, resolu a la connexion (dossier de
  // depart memorise -> racine de partages detectee -> "/"). Cf resolveRemoteStart.
  const [remoteStart, setRemoteStart] = useState("/");
  const [version, setVersion] = useState("");
  // Compteur de « vies » du daemon rclone : incremente a chaque relance, il sert
  // a repousser la config globale de transfert, perdue avec l'ancien process.
  const [daemonEpoch, setDaemonEpoch] = useState(0);
  const [connErr, setConnErr] = useState("");
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
  // prend ce libelle (au lieu du « user@host » par defaut). Il se vide des qu'on
  // touche a l'un des 4 autres champs, pour ne pas coller un nom a une autre
  // connexion. Modifier les 4 champs passe donc par ces helpers.
  const [name, setName] = useState("");
  const setHostField = (v: string) => { setHost(v); setName(""); };
  const setUserField = (v: string) => { setUser(v); setName(""); };
  const setPassField = (v: string) => { setPass(v); setName(""); };
  const setPortField = (v: string) => { setPort(v); setName(""); };
  const [servers, setServers] = useState<Server[]>([]);
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [showSettings, setShowSettings] = useState(false);
  const [showJournal, setShowJournal] = useState(false);
  // Ref pour lire les reglages courants dans les callbacks memoises.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // Accès rapide (dossiers épinglés). Le local est global (dossiers systeme) ;
  // le distant est CLOISONNE PAR SERVEUR — les chemins n'ont aucun sens d'un
  // serveur a l'autre. `pins.remote` reflete le serveur COURANT ; il est
  // charge/sauve sous une cle propre a chaque serveur (cf. `remoteKey`).
  type Pin = { label: string; path: string };
  const [pins, setPins] = useState<{ local: Pin[]; remote: Pin[] }>(() => ({
    local: JSON.parse(localStorage.getItem("copiteur.pins.local") || "[]"),
    remote: [],
  }));
  // Cle du serveur distant courant (= son label `user@host`), ou null tant
  // qu'aucun serveur n'est connecte. Sert de suffixe a la cle localStorage des
  // pins distants.
  const [remoteKey, setRemoteKey] = useState<string | null>(null);
  const remotePinsKey = (label: string) => `copiteur.pins.remote::${label}`;

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
  const panes = useRef<Record<Side, PaneBus>>({
    local: { side: "local", dir: "/", selected: [], refresh: () => {}, clearSelection: () => {}, selectAll: () => {} },
    remote: { side: "remote", dir: "/", selected: [], refresh: () => {}, clearSelection: () => {}, selectAll: () => {} },
  });
  const clipboard = useRef<Payload | null>(null);
  const busyRef = useRef(false);

  // Donner le focus a un volet DESELECTIONNE l'autre : une seule selection
  // active a la fois. Sans ca, cliquer dans le volet distant en gardant une
  // selection dans le volet local laissait les deux selections vivantes.
  // Le garde `active !== side` evite de vider l'autre a chaque clic interne.
  const focusPane = (side: Side) => {
    if (active !== side)
      panes.current[side === "local" ? "remote" : "local"].clearSelection();
    setActive(side);
  };
  // Barre de connexion : sert a retirer le focus des champs quand on clique
  // ailleurs (le lasso des volets fait preventDefault, ce qui sinon empeche le
  // navigateur de deplacer le focus tout seul).
  const connBarRef = useRef<HTMLDivElement>(null);
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
    !!editAsk ||
    !!conflictAsk ||
    !!dmgMount;

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
  // Ce serveur s'est revele incapable de calculer des empreintes : on a bascule
  // la connexion en `disable_hashcheck`. Un seul basculement par connexion.
  const noHashRef = useRef(false);
  // Passe a vrai quand la connexion sans empreinte est REELLEMENT en place
  // (config reecrite + cache vide). C'est le signal qui autorise la relance.
  const [noHashReady, setNoHashReady] = useState(false);
  // Derniers identifiants utilises : necessaires pour REecrire la config du
  // remote sans redemander le mot de passe.
  const lastConnRef = useRef<Server | null>(null);
  // Jeton de tentative de connexion. Chaque clic sur « Se connecter » l'incremente
  // et INVALIDE la tentative precedente : si un serveur ne repond pas (dial SFTP
  // qui pend), recliquer relance immediatement et seule la DERNIERE tentative a le
  // droit d'ecrire l'etat (connecte / erreur). Sans ca, l'ancienne sonde en vol
  // finissait par ecraser le resultat de la nouvelle.
  const connSeq = useRef(0);
  // Vrai pendant qu'une tentative de connexion est en cours (retour visuel + on
  // laisse le bouton cliquable pour pouvoir superseder une tentative bloquee).
  const [connecting, setConnecting] = useState(false);

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
      .catch(() => setVersion("rclone injoignable"));
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
      logEvent("warn", "app", "Le moteur rclone a été relancé (il s'était arrêté)");
      setDaemonEpoch((n) => n + 1);
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
  useEffect(() => {
    if (localStorage.getItem("copiteur.pins.seeded")) return;
    invoke<{ label: string; path: string; kind: string }[]>("local_roots")
      .then((rs) => {
        const seed = rs
          .filter((r) => r.kind === "quick")
          .map((r) => ({ label: r.label, path: r.path }));
        setPins((p) => ({ ...p, local: seed }));
        localStorage.setItem("copiteur.pins.seeded", "1");
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    localStorage.setItem("copiteur.pins.local", JSON.stringify(pins.local));
  }, [pins.local]);
  // Sauve les pins distants sous la cle DU SERVEUR COURANT. Tant qu'aucun
  // serveur n'est connecte, on n'ecrit rien (pas de cle « orpheline »).
  useEffect(() => {
    if (!remoteKey) return;
    localStorage.setItem(remotePinsKey(remoteKey), JSON.stringify(pins.remote));
  }, [pins.remote, remoteKey]);

  // Clic hors de la barre de connexion : on retire le focus du champ actif. En
  // phase de CAPTURE, avant que le lasso des volets ne fasse preventDefault (qui
  // empecherait le navigateur de bouger le focus, laissant le contour colore).
  useEffect(() => {
    const onDown = (ev: PointerEvent) => {
      const bar = connBarRef.current;
      if (!bar) return;
      if (bar.contains(ev.target as Node)) return;
      const a = document.activeElement as HTMLElement | null;
      if (a && bar.contains(a)) a.blur();
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, []);

  const pinFolder = useCallback((side: Side, path: string, label: string) => {
    setPins((p) =>
      p[side].some((x) => x.path === path)
        ? p
        : { ...p, [side]: [...p[side], { label, path }] },
    );
  }, []);
  const unpinFolder = useCallback((side: Side, path: string) => {
    setPins((p) => ({ ...p, [side]: p[side].filter((x) => x.path !== path) }));
  }, []);
  // Reordonne l'acces rapide : insere `from` avant/apres `to` (index recalcule
  // APRES retrait pour rester coherent quand from est avant to).
  const reorderPins = useCallback(
    (side: Side, from: string, to: string, after: boolean) => {
      setPins((p) => {
        const arr = [...p[side]];
        const fi = arr.findIndex((x) => x.path === from);
        if (fi < 0) return p;
        const [moved] = arr.splice(fi, 1);
        const ti = arr.findIndex((x) => x.path === to);
        if (ti < 0) return p;
        arr.splice(ti + (after ? 1 : 0), 0, moved);
        return { ...p, [side]: arr };
      });
    },
    [],
  );

  // Se connecte avec les champs courants (ou ceux d'un serveur memorise) et
  // memorise la connexion pour ne pas la retaper la prochaine fois.
  const connect = async (s?: Server) => {
    const h = s ? s.host : host;
    const u = s ? s.user : user;
    const p = s ? s.pass : pass;
    const pt = s ? s.port : port;
    // Libelle du serveur memorise. Serveur RECONNECTE : on garde SON nom (sinon
    // on recreerait un doublon sous « user@host » et on perdrait le nom donne).
    // Connexion tapee a la main : le nom facultatif s'il est rempli, sinon le
    // « user@host » historique.
    const label = s ? s.label : name.trim() || `${u}@${h}`;
    // Ce clic PREND LA MAIN : toute tentative precedente encore en vol devient
    // caduque et n'ecrira plus rien.
    const seq = ++connSeq.current;
    const current = () => seq === connSeq.current;
    setConnErr("");
    setConnecting(true);
    // Nouveau serveur : on refait confiance a ses empreintes. Si elles sont
    // cassees, le premier echec le revelera et on rebasculera tout seul.
    noHashRef.current = false;
    setNoHashReady(false);
    lastConnRef.current = { label, host: h, user: u, pass: p, port: pt };
    try {
      // Identite du serveur AVANT tout envoi du mot de passe : sa cle doit etre
      // celle deja acceptee, sinon l'utilisateur tranche (cf. hostkeys.rs).
      const hk = await invoke<HostKeyStatus>("host_key_check", { host: h, port: pt });
      if (!current()) return;
      if (hk.status !== "known") {
        const ok = await askHostKey({ ...hk, host: h, port: pt || "22" });
        if (!current()) return;
        if (!ok) {
          setConnErr("Connexion annulée : identité du serveur non acceptée.");
          logEvent(
            "warn",
            "connexion",
            `Connexion à ${h} annulée — empreinte ${hk.status === "changed" ? "CHANGÉE" : "nouvelle"} refusée (${hk.fingerprint})`,
          );
          return;
        }
        await invoke("host_key_trust", { host: h, port: pt });
        logEvent(
          hk.status === "changed" ? "warn" : "info",
          "connexion",
          `${hk.status === "changed" ? "Nouvelle clé acceptée" : "Clé mémorisée"} pour ${h} : ${hk.algo} ${hk.fingerprint}`,
        );
      }
      await rc("config/create", {
        name: "serveur",
        type: "sftp",
        parameters: {
          host: h,
          user: u,
          pass: p,
          port: pt || "22",
          concurrency: String(settings.sftpConcurrency),
        },
        opt: { obscure: true },
      });
      if (!current()) return;
      // Change de serveur : rclone garde en cache la connexion (Fs) sous le nom
      // « serveur: ». Sans purge, un nouveau serveur reutiliserait l'ancienne
      // connexion. On vide le cache pour se deconnecter vraiment de l'ancien.
      await rc("fs/cache/clear").catch(() => {});
      if (!current()) return;
      // SONDE BORNEE avant de basculer l'UI en « connecte ». Sans ca, un serveur
      // injoignable laissait le panneau tourner en boucle : le dial SFTP peut
      // pendre jusqu'a ConnectTimeout (30s en config globale) x 6 relistages du
      // panneau ~= 3 min, sans qu'on puisse relancer. Ici on teste la connexion
      // AVANT, avec un `_config` court (ConnectTimeout borne le dial — verifie) et
      // sans relance (LowLevelRetries=1). Un `_config` par appel est sans danger
      // sur `operations/list` (pas de fichier « .partial » a renommer, contrairement
      // a copyfile). On double d'un garde-fou JS au cas ou rclone ignorerait la
      // borne.
      const probe = rc("operations/list", {
        fs: REMOTE,
        remote: "",
        opt: { noModTime: true },
        _config: { ConnectTimeout: "12s", Timeout: "12s", LowLevelRetries: 1 },
      });
      // Sonde en vol qui rejette APRES le garde-fou : on avale sa rejection pour
      // eviter un « unhandled rejection » (le resultat est de toute facon ignore).
      probe.catch(() => {});
      let timer: ReturnType<typeof setTimeout>;
      const timeout = new Promise<never>((_, rej) => {
        timer = setTimeout(
          () => rej(new Error("Le serveur ne répond pas (délai dépassé).")),
          14000,
        );
      });
      try {
        await Promise.race([probe, timeout]);
      } finally {
        clearTimeout(timer!);
      }
      if (!current()) return;
      // Dossier d'ouverture : dossier de depart memorise (si lisible) -> racine
      // de partages detectee -> "/". Resolu MAINTENANT (connexion live) et pose
      // AVANT setConnected pour que le panneau s'ouvre directement au bon endroit.
      const memStart =
        s?.startDir ?? servers.find((x) => x.label === label)?.startDir ?? "";
      const startAt = await resolveRemoteStart(memStart);
      if (!current()) return;
      setRemoteStart(startAt);
      setConnected(true);
      setConnKey((k) => k + 1);
      setActive("remote");
      logEvent("info", "connexion", `Connecté à ${u}@${h}:${pt || "22"}`);
      // Enregistre / met a jour le serveur (label = nom donne, ou user@host).
      // Charge l'acces rapide PROPRE a ce serveur (cloisonne par label). Sans
      // ca, on afficherait les dossiers epingles d'un autre serveur, qui n'y
      // existent pas -> « directory not found » au clic.
      setRemoteKey(label);
      setPins((p) => ({
        ...p,
        remote: JSON.parse(localStorage.getItem(remotePinsKey(label)) || "[]"),
      }));
      const saved = await invoke<Server[]>("save_server", {
        server: {
          label,
          host: h,
          user: u,
          pass: p,
          port: pt || "22",
          startDir: memStart,
        },
      });
      if (!current()) return;
      setServers(saved);
    } catch (e) {
      // Une tentative plus recente a pris la main : on se tait, c'est elle qui
      // decide desormais (ne pas ecraser son resultat avec notre echec).
      if (!current()) return;
      setConnErr(humanConnError(String(e)));
      setConnected(false);
      logEvent("error", "connexion", `Échec de connexion à ${u}@${h} — ${e}`);
    } finally {
      if (current()) setConnecting(false);
    }
  };

  const pickServer = (s: Server) => {
    setHost(s.host);
    setUser(s.user);
    setPass(s.pass);
    setPort(s.port);
    // Reflete le nom du serveur dans le champ « Nom » s'il est PERSONNALISE (pas
    // le « user@host » par defaut) : ainsi, recliquer « Se connecter » apres
    // avoir choisi ce serveur conserve son nom au lieu de recreer un doublon.
    setName(s.label === `${s.user}@${s.host}` ? "" : s.label);
    connect(s);
  };
  const deleteServer = (label: string) => {
    invoke<Server[]>("delete_server", { label }).then(setServers).catch(() => {});
  };
  // Definit (ou efface, avec "") le dossier de depart du serveur COURANT. Persiste
  // sur le serveur memorise ; prend effet a la prochaine connexion.
  const setStartDir = (path: string) => {
    if (!remoteKey) return;
    const cur = servers.find((x) => x.label === remoteKey);
    if (!cur) return;
    invoke<Server[]>("save_server", { server: { ...cur, startDir: path } })
      .then(setServers)
      .catch(() => {});
  };
  // Renomme un serveur memorise. On migre au passage la cle localStorage de ses
  // dossiers epingles distants (cloisonnes par label) et, si on est justement
  // connecte a lui, on met a jour la cle courante pour ne pas perdre ses pins.
  const renameServer = (oldLabel: string, newLabel: string) => {
    invoke<Server[]>("rename_server", { oldLabel, newLabel })
      .then((saved) => {
        setServers(saved);
        // La migration n'a lieu que si le backend a bien applique le renommage
        // (nom non vide et non deja pris) — sinon `saved` garde l'ancien label.
        if (saved.some((s) => s.label === newLabel)) {
          const old = localStorage.getItem(remotePinsKey(oldLabel));
          if (old !== null) {
            localStorage.setItem(remotePinsKey(newLabel), old);
            localStorage.removeItem(remotePinsKey(oldLabel));
          }
          setRemoteKey((k) => (k === oldLabel ? newLabel : k));
          setName((n) => (n === oldLabel ? newLabel : n));
        }
      })
      .catch(() => {});
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
    destSide: Side,
    intoDir?: string,
  ) => {
    if (src.side === destSide) return;
    const destDir = intoDir ?? panes.current[destSide].dir;

    // Ce qui existe deja a destination (pour proposer Remplacer / Ignorer).
    let existing = new Set<string>();
    try {
      const r = await rc<{ list: { Name: string }[] }>(
        "operations/list",
        listArgs(destSide, destDir),
      );
      existing = new Set((r.list ?? []).map((e) => e.Name));
    } catch {
      /* pas grave : on ne detecte juste pas les conflits */
    }

    // Choix memorise pour CETTE copie uniquement (case a cocher).
    let batch: "replace" | "ignore" | null = null;
    const keep = [];
    for (const item of src.items) {
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
      `Mise en file : ${keep.length} élément${keep.length > 1 ? "s" : ""} → ${destSide === "local" ? "Ton PC" : "Serveur"} ${destDir}`,
    );
    setTab("queue");
    setPreparing((n) => n + keep.length);
    for (const item of keep) {
      try {
        const { plans, mkdirs } = await planItem(
          src.side,
          src.dir,
          item,
          destSide,
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
    async (fileDir: string, name: string, size: number, modTime: string) => {
      try {
        // Sous-dossier frais (chemin local a slashs avant, termine par "/").
        const folder = await invoke<string>("open_cache_dir");
        const src = fileAddr("remote", fileDir, name);
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
        logEvent("error", "operation", `Ouverture impossible : ${name} — ${e}`);
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
        baseRemoteMod: x.editBaseMod ?? "",
        baseRemoteSize: x.size,
      },
    ]);
    setTab("edition");
    logEvent("info", "operation", `Édition démarrée : ${name}`);
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
  const disableHashCheck = useCallback(async () => {
    if (noHashRef.current) return;
    noHashRef.current = true;
    const s = lastConnRef.current;
    if (!s) return;
    try {
      await rc("config/create", {
        name: "serveur",
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
        "Ce serveur ne sait pas calculer d'empreinte : vérification par empreinte désactivée (la taille reste vérifiée). Les transferts échoués sont relancés.",
      );
      // Signale que la NOUVELLE config est reellement en place : relancer avant
      // ce moment referait echouer les transferts a l'identique.
      setNoHashReady(true);
    } catch {
      noHashRef.current = false; // la bascule a rate : on repassera au prochain echec
    }
  }, []);

  // Relance tout echec « empreinte » une fois la connexion reconfiguree. Vaut
  // aussi pour ceux tombes juste apres la bascule. `hashRetried` evite la
  // boucle : on ne redonne qu'UNE chance a chaque transfert.
  useEffect(() => {
    if (!noHashReady) return;
    const stuck = xfers.filter(
      (x) => x.status === "error" && x.hashFault && !x.hashRetried,
    );
    if (!stuck.length) return;
    const ids = new Set(stuck.map((x) => x.id));
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
    if (isBrokenHashSupport(err)) void disableHashCheck();
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
        const streamFallback =
          !nameFault &&
          !hashFault &&
          p.dstFs.startsWith(REMOTE) &&
          p.bytes === 0 &&
          curUp > 1;
        const nextUp = streamFallback ? Math.max(1, Math.floor(curUp / 2)) : p.upStreams;
        // Coupure reseau OU alea transitoire de rclone OU fallback de flux => on
        // reprend tout seul (0 = tentatives illimitees). Pas la peine pour une
        // empreinte cassee : `disableHashCheck` vient de relancer proprement.
        const retry =
          !nameFault &&
          !hashFault &&
          (streamFallback || NETWORK_ERROR.test(err) || RETRYABLE_ERROR.test(err)) &&
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
          // Marque l'echec comme « probablement le nom » : le message brut de
          // rclone parle d'empreintes, ce qui n'aide personne.
          nameFault,
          hashFault,
          error: nameFault
            ? `Nom refusé par la destination (« ${p.name} ») — ${err}`
            : hashFault
              ? `Le serveur n'a pas su fournir d'empreinte vérifiable — nouvelle tentative sans vérification par empreinte. (${err})`
              : streamFallback
                ? `Le serveur a refusé ${curUp} connexions simultanées en envoi — nouvelle tentative avec ${nextUp}. (${err})`
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
    logEvent("info", "transfert", `Renommé pour la copie : ${x.name} → ${clean}`);
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
        const isUpload = x.dstFs.startsWith(REMOTE);
        const upStreams = x.upStreams ?? settingsRef.current.uploadStreams;
        const { jobid } = await rc<{ jobid: number }>("operations/copyfile", {
          srcFs: x.srcFs,
          srcRemote: x.srcRemote,
          dstFs: x.dstFs,
          dstRemote: x.dstRemote,
          _async: true,
          _group: x.group,
          ...(isUpload
            ? { _config: { MultiThreadStreams: upStreams } }
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
    const next = xfers
      .filter(
        (x) =>
          x.status === "queued" ||
          (x.status === "retry" && x.nextTry <= now),
      )
      .slice(0, free);
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
              logEvent("info", "operation", `Ouverture : ${x.name}`);
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
              logEvent("info", "operation", `Renvoi après édition : ${x.name}`);
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
        } catch {
          /* daemon occupe : on retentera au prochain battement */
        }
      }
      if (anyFinished && !cancelled) {
        panes.current.local.refresh();
        panes.current.remote.refresh();
      }
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
          `Coupure, reprise auto (tentative ${x.attempts}) : ${label} — ${x.error}`,
        );
      else if (x.status === "error") {
        tally.current.error++;
        logEvent("error", "transfert", `Échec : ${label} — ${x.error}`);
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
        logEvent("info", "transfert", `Annulé : ${label}`);
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
          `Lot terminé : ${done} réussi${done > 1 ? "s" : ""}, ${error} échec${error > 1 ? "s" : ""}, ${cancelled} annulé${cancelled > 1 ? "s" : ""}`,
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
    // Un transfert relancé garde son id d'ORIGINE, qui peut être inférieur à
    // l'ancre du lot courant (posée quand la file s'est vidée après une
    // annulation) — il tomberait alors sous l'ancre et serait exclu du calcul de
    // progression : « restant » à 0 et barre figée, alors que la copie tourne.
    // On abaisse l'ancre juste sous le plus petit id relancé pour les réintégrer
    // au lot courant.
    const minId = Math.min(...ids);
    batchAnchorRef.current = Math.min(batchAnchorRef.current, minId - 1);
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
  const doCopy = useCallback((side: Side) => {
    const p = panes.current[side];
    if (p.selected.length) {
      clipboard.current = { side, dir: p.dir, items: p.selected };
      setClipboardReady(true);
    }
  }, []);
  const doPaste = useCallback(
    (side: Side) => {
      if (clipboard.current) startTransfers(clipboard.current, side);
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
      panes.current.local.clearSelection();
      panes.current.remote.clearSelection();
    };
    const onClick = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".explorer")) deselect();
    };
    window.addEventListener("click", onClick);
    window.addEventListener("blur", deselect);
    return () => {
      window.removeEventListener("click", onClick);
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
        doneBytes +=
          x.status === "done" ? x.size : x.status === "running" ? x.bytes : 0;
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
        ? ` · ${Math.ceil(eta)} s`
        : ` · ${Math.round(eta / 60)} min`
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
  // Bandeau d'erreur EPHEMERE. Il s'affichait tant qu'un echec trainait dans la
  // liste, donc indefiniment : entre deux transferts on lisait encore l'echec du
  // precedent, ce qui donnait l'impression qu'il concernait les suivants.
  // L'echec reste consultable dans l'onglet « Échoués » et dans le journal, le
  // bandeau n'a donc pas a etre permanent.
  const latestErr = failed.find((x) => x.status === "error");
  const latestErrId = latestErr?.id ?? null;
  const [errBanner, setErrBanner] = useState<string | null>(null);
  useEffect(() => {
    // Plus aucun echec en liste (le dernier a ete relance avec succes, ou
    // l'onglet a ete nettoye) : on efface TOUT DE SUITE. Sortir sans rien faire
    // laissait le bandeau affiche pour toujours — c'est ce qui se passait apres
    // une bascule « sans empreinte », ou les echecs disparaissent en etant
    // relances plutot qu'en expirant.
    if (latestErrId === null) {
      setErrBanner(null);
      return;
    }
    setErrBanner(latestErr?.error ?? null);
    const t = setTimeout(() => setErrBanner(null), 10000);
    return () => clearTimeout(t);
    // Volontairement cale sur l'ID SEUL : `failed` est un tableau recree a
    // chaque rendu, s'en servir comme dependance relancerait le minuteur en
    // boucle et le bandeau ne partirait jamais.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestErrId]);

  return (
    <div
      className="app"
      data-os={osName}
      onContextMenu={(e) => {
        // Coupe le menu natif du navigateur partout, sauf dans les champs texte.
        if (!(e.target as HTMLElement).closest("input, textarea"))
          e.preventDefault();
      }}
    >
      <div className="titlebar" data-tauri-drag-region>
        <span className="brandwrap">
          <span className="brand">Copiteur</span>
          <span className="version">0.1.0</span>
        </span>
        {!isMac && (
          <div className="win-buttons">
            <button className="win-btn" onClick={() => appWindow.minimize()} aria-label="Réduire">
              &#xE921;
            </button>
            <button className="win-btn" onClick={() => appWindow.toggleMaximize()} aria-label="Agrandir">
              &#xE922;
            </button>
            <button className="win-btn win-close" onClick={() => appWindow.close()} aria-label="Fermer">
              &#xE8BB;
            </button>
          </div>
        )}
      </div>

      <div className="connect-bar" ref={connBarRef}>
        <input className="conn-field cname" placeholder="Nom (facultatif)" value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} />
        <input className="conn-field host" placeholder="Hôte" value={host} onChange={(e) => setHostField(e.target.value)} spellCheck={false} />
        <input className="conn-field user" placeholder="Utilisateur" value={user} onChange={(e) => setUserField(e.target.value)} spellCheck={false} />
        <input className="conn-field pwd" placeholder="Mot de passe" type="password" value={pass} onChange={(e) => setPassField(e.target.value)} />
        <input className="conn-field port" placeholder="Port" value={port} onChange={(e) => setPortField(e.target.value)} spellCheck={false} />
        <button
          className={"conn-btn" + (connecting ? " is-connecting" : "")}
          onClick={() => connect()}
        >
          {/* Sizer invisible : reserve toujours la largeur du libelle le plus
              large pour que le bouton ne change pas de taille entre les etats. */}
          <span className="conn-btn-sizer" aria-hidden="true">Se connecter</span>
          <span className="conn-btn-label">{connecting ? "Connexion…" : "Se connecter"}</span>
        </button>
        <ServersDropdown
          servers={servers}
          onPick={pickServer}
          onDelete={deleteServer}
          onRename={renameServer}
        />
        <button
          className="gear-btn"
          aria-label="Journal"
          title="Journal (diagnostic)"
          onClick={() => setShowJournal(true)}
        >
          <UiIcon name="journal" />
        </button>
        <button
          className="gear-btn"
          aria-label="Paramètres"
          title="Paramètres de transfert"
          onClick={() => setShowSettings(true)}
        >
          &#x2699;
        </button>
      </div>

      {connErr && <div className="conn-error">{connErr}</div>}

      <main className="explorers">
        <FilePane
          title="Ton PC"
          side="local"
          enabled={true}
          anyModal={anyModal}
          active={active === "local"}
          onFocus={() => focusPane("local")}
          bus={panes.current.local}
          onDropItems={startTransfers}
          onCopy={doCopy}
          onPaste={doPaste}
          hasClipboard={clipboardReady}
          busyRef={busyRef}
          showHidden={settings.showHidden}
          showNetworkDrives={settings.showNetworkDrives}
          pins={pins.local}
          onPin={(path, label) => pinFolder("local", path, label)}
          onUnpin={(path) => unpinFolder("local", path)}
          onReorderPin={(from, to, after) => reorderPins("local", from, to, after)}
        />
        <FilePane
          title="Serveur"
          side="remote"
          enabled={connected}
          anyModal={anyModal}
          active={active === "remote"}
          onFocus={() => focusPane("remote")}
          bus={panes.current.remote}
          onDropItems={startTransfers}
          onCopy={doCopy}
          onPaste={doPaste}
          hasClipboard={clipboardReady}
          busyRef={busyRef}
          showHidden={settings.showHidden}
          showNetworkDrives={settings.showNetworkDrives}
          pins={pins.remote}
          onPin={(path, label) => pinFolder("remote", path, label)}
          onUnpin={(path) => unpinFolder("remote", path)}
          onReorderPin={(from, to, after) => reorderPins("remote", from, to, after)}
          onOpenRemote={openRemote}
          connKey={connKey}
          startAt={remoteStart}
          startDir={servers.find((x) => x.label === remoteKey)?.startDir ?? ""}
          onSetStartDir={setStartDir}
        />
      </main>

      {(xfers.length > 0 || preparing > 0 || edits.length > 0) && (
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
        />
      )}

      {showSettings && (
        <SettingsDialog
          settings={settings}
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
            <div className="modal-title">Le fichier existe déjà</div>
            <div className="modal-body">
              « <strong>{conflict.name}</strong> » est déjà présent dans le
              dossier de destination. Que faire ?
            </div>
            <label className="modal-check">
              <input
                type="checkbox"
                checked={conflictAll}
                onChange={(e) => setConflictAll(e.target.checked)}
              />
              Appliquer à tous les fichiers de cette copie
            </label>
            <div className="modal-actions">
              <button className="btn-ghost" onClick={() => resolveConflict("ignore")}>
                Ignorer
              </button>
              <button className="btn-accent" onClick={() => resolveConflict("replace")}>
                Remplacer
              </button>
            </div>
          </div>
        </div>
      )}

      {renameAsk && (
        <div className="modal-backdrop">
          <div className="modal">
            <div className="modal-title">Nom refusé par la destination</div>
            <div className="modal-body">
              « <strong>{renameAsk.name}</strong> » n'a pas pu être copié : la
              destination n'accepte pas certains caractères de ce nom (
              <code>\ / : * ? " &lt; &gt; |</code>).
              <br />
              <br />
              Copier sous le nom «&nbsp;<strong>{sanitizeName(renameAsk.name)}</strong>
              &nbsp;» ?
              <label className="modal-check">
                <input
                  type="checkbox"
                  checked={renameAll}
                  onChange={(ev) => setRenameAll(ev.target.checked)}
                />
                Appliquer aux autres noms refusés de cette copie
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
                Laisser tomber
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
                Renommer et copier
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
                ? "Des transferts sont en cours"
                : "Des éditions ne sont pas renvoyées"}
            </div>
            <div className="modal-body">
              {(() => {
                const n = xfers.filter((x) => !isFinal(x)).length + preparing;
                const e = edits.filter((x) => x.state !== "watching").length;
                return (
                  <>
                    {n > 0 && (
                      <>
                        {n} transfert{n > 1 ? "s" : ""} en cours ou en attente.{" "}
                      </>
                    )}
                    {e > 0 && (
                      <>
                        {e} fichier{e > 1 ? "s" : ""} édité{e > 1 ? "s" : ""} pas
                        encore renvoyé{e > 1 ? "s" : ""} sur le serveur.{" "}
                      </>
                    )}
                    Fermer maintenant perdra ces changements.
                  </>
                );
              })()}
            </div>
            <div className="modal-actions">
              <button className="btn-ghost" onClick={() => setCloseAsk(false)}>
                Annuler
              </button>
              <button
                className="btn-accent"
                onClick={() => invoke("force_quit").catch(() => appWindow.destroy())}
              >
                Fermer quand même
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Identite du serveur : 1re connexion (empreinte a accepter) ou cle qui
          a change depuis la derniere fois (alerte). */}
      {hostKeyAsk && (
        <div className="modal-backdrop">
          <div className="modal modal-hostkey">
            <div className="modal-title">
              {hostKeyAsk.status === "changed"
                ? "Attention : l'identité du serveur a changé"
                : "Première connexion à ce serveur"}
            </div>
            <div className="modal-body">
              {hostKeyAsk.status === "changed" ? (
                <>
                  La clé présentée par{" "}
                  <strong>
                    {hostKeyAsk.host}:{hostKeyAsk.port}
                  </strong>{" "}
                  ne correspond pas à celle mémorisée. C'est normal après une
                  réinstallation ou une mise à jour du serveur, mais cela peut
                  aussi signifier que quelqu'un se fait passer pour lui afin
                  d'intercepter votre mot de passe.
                  <div className="hostkey-label">Empreinte mémorisée</div>
                  <code className="hostkey-fp is-old">{hostKeyAsk.previous}</code>
                  <div className="hostkey-label">Empreinte présentée</div>
                  <code className="hostkey-fp">
                    {hostKeyAsk.algo} {hostKeyAsk.fingerprint}
                  </code>
                  <div className="modal-hint">
                    Dans le doute, annulez et vérifiez auprès de la personne qui
                    gère le serveur.
                  </div>
                </>
              ) : (
                <>
                  Copiteur ne connaît pas encore{" "}
                  <strong>
                    {hostKeyAsk.host}:{hostKeyAsk.port}
                  </strong>
                  . Voici l'empreinte de sa clé d'identité :
                  <code className="hostkey-fp">
                    {hostKeyAsk.algo} {hostKeyAsk.fingerprint}
                  </code>
                  <div className="modal-hint">
                    Si vous pouvez, comparez-la à celle donnée par la personne
                    qui gère le serveur. Copiteur la mémorise et vous alertera si
                    elle change un jour.
                  </div>
                </>
              )}
            </div>
            <div className="modal-actions">
              <button className="btn-ghost" onClick={() => answerHostKey(false)}>
                Annuler
              </button>
              <button
                className={
                  hostKeyAsk.status === "changed" ? "btn-accent btn-danger" : "btn-accent"
                }
                onClick={() => answerHostKey(true)}
              >
                {hostKeyAsk.status === "changed"
                  ? "Faire confiance à la nouvelle clé"
                  : "Faire confiance et se connecter"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* macOS : l'app tourne depuis son .dmg monte, pas encore installee. */}
      {dmgMount && (
        <div className="modal-backdrop">
          <div className="modal">
            <div className="modal-title">Installer Copiteur ?</div>
            <div className="modal-body">
              Copiteur tourne actuellement depuis son image disque (
              <strong>{dmgMount}</strong>), pas depuis le dossier
              Applications. Le déplacer évite qu'elle réapparaisse comme un
              volume dans le panneau de gauche, et l'éjecte automatiquement.
            </div>
            <div className="modal-actions">
              <button
                className="btn-ghost"
                onClick={() => setDmgMount(null)}
                disabled={dmgMoving}
              >
                Continuer depuis là
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
                      `Déplacement vers Applications impossible : ${e}`,
                    );
                  });
                  // Succes = l'app quitte cote Rust (app.exit) ; rien d'autre
                  // a faire ici, la fenetre va se fermer.
                }}
              >
                {dmgMoving ? "Déplacement…" : "Déplacer vers Applications"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirmation « le fichier edite a change — le renvoyer ? » */}
      {editAsk && (
        <div className="modal-backdrop" onMouseDown={() => ignoreEdit(editAsk.id)}>
          <div className="modal" onMouseDown={(ev) => ev.stopPropagation()}>
            <div className="modal-title">Fichier modifié</div>
            <div className="modal-body">
              « <strong>{editAsk.label}</strong> » a été modifié. Le renvoyer sur
              le serveur ?
            </div>
            <div className="modal-actions">
              <button
                className="btn-ghost"
                onClick={() => ignoreEdit(editAsk.id)}
              >
                Ignorer
              </button>
              <button
                className="btn-accent"
                onClick={() => {
                  const e = edits.find((x) => x.id === editAsk.id);
                  if (e) resendEdit(e);
                }}
              >
                Renvoyer
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
            <div className="modal-title">Conflit sur le serveur</div>
            <div className="modal-body">
              {conflictAsk.reason === "deleted" ? (
                <>
                  « <strong>{conflictAsk.e.label}</strong> » n'existe plus sur le
                  serveur (supprimé ou déplacé depuis que vous l'avez ouvert). Le
                  renvoyer le recréera.
                </>
              ) : (
                <>
                  « <strong>{conflictAsk.e.label}</strong> » a été modifié sur le
                  serveur depuis que vous l'avez ouvert. Le renvoyer{" "}
                  <strong>écrasera</strong> la version du serveur.
                </>
              )}
            </div>
            <div className="modal-actions">
              <button
                className="btn-ghost"
                onClick={() => setConflictAsk(null)}
              >
                Annuler
              </button>
              <button
                className="btn-accent btn-danger"
                onClick={() => doResend(conflictAsk.e)}
              >
                {conflictAsk.reason === "deleted" ? "Renvoyer" : "Écraser"}
              </button>
            </div>
          </div>
        </div>
      )}

      <footer className="transfer-bar">
        {queue.length > 0 ? (
          <>
            <span className="xfer-progress">
              <span
                className={
                  "xfer-progress-fill" +
                  (reconnecting || allStalled ? " is-retry" : "")
                }
                style={{ width: `${pct}%` }}
              />
            </span>
            {reconnecting ? (
              // Le lien est tombe : on le dit clairement, la file repart seule.
              <span className="xfer-text is-retry">
                Connexion perdue — reprise automatique · {queue.length} transfert
                {queue.length > 1 ? "s" : ""} en attente · reste{" "}
                {humanSize(remaining)}
              </span>
            ) : allStalled ? (
              // Rien n'avance plus, mais on n'a pas encore la preuve d'une
              // coupure : on decrit ce qu'on voit, sans rien conclure.
              <span className="xfer-text is-retry">
                Plus aucune donnée ne passe — en attente du serveur ·{" "}
                {queue.length} transfert{queue.length > 1 ? "s" : ""} · reste{" "}
                {humanSize(remaining)}
              </span>
            ) : (
              <span className="xfer-text">
                {queue.length} transfert{queue.length > 1 ? "s" : ""} · {pct}% ·
                reste {humanSize(remaining)} · {humanSize(smoothSpeed)}/s
                {etaText}
              </span>
            )}
          </>
        ) : errBanner ? (
          <span className="xfer-err">Erreur : {errBanner}</span>
        ) : (
          <span>Aucun transfert en cours</span>
        )}
        <span
          className="rclone-ver"
          title={version ? `rclone ${version}` : undefined}
        >
          {!version
            ? "démarrage de rclone…"
            : /mt-sftp/i.test(version)
              ? "Moteur rclone custom"
              : `rclone ${version}`}
        </span>
      </footer>
    </div>
  );
}
