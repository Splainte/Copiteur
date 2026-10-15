// ============================================================
//  Copiteur — logique partagee de l'explorateur de fichiers
//  (appels rclone, types de fichiers, tri, formatage, chemins)
// ============================================================
import { invoke } from "@tauri-apps/api/core";

// Passe-plat vers l'API RC de rclone (daemon sidecar cote Rust).
export type RcParams = Record<string, unknown>;
export function rc<T = unknown>(method: string, params: RcParams = {}): Promise<T> {
  return invoke<T>("rc_call", { method, params });
}

// Une entree renvoyee par operations/list.
export type Entry = {
  Name: string;
  Path: string;
  Size: number;
  IsDir: boolean;
  ModTime: string;
  MimeType?: string;
};

export type Side = "local" | "remote";

// Remote SFTP cree a la volee sous ce nom via config/create.
export const REMOTE = "serveur:";

// Instantane d'un panneau, partage avec App (DnD, copier-coller, transferts).
export type PaneBus = {
  side: Side;
  dir: string;
  selected: Entry[];
  refresh: () => void;
  clearSelection: () => void;
  selectAll: () => void;
};

// Charge utile d'un glisser / copier (source d'un transfert).
export type Payload = { side: Side; dir: string; items: Entry[] };

// Element en cours de glisser (partage entre panneaux, hors etat React).
export const drag: { payload: Payload | null } = { payload: null };

// Un serveur memorise (persiste cote Rust dans serveurs.json).
export type Server = {
  label: string;
  host: string;
  user: string;
  pass: string;
  port: string;
  // Dossier de depart memorise : chemin ABSOLU sur le serveur ("/share/…").
  // Absent/"" = pas de dossier de depart. Optionnel pour compat anciens serveurs.
  startDir?: string;
};

// ---- Reglages rclone (fenetre parametres) ---------------------------------
// Regles COMMUNES a tous les transferts : depuis la file d'attente, un dossier
// est eclate en fichiers (cf. planItem), donc il n'y a plus qu'un seul profil —
// plus de distinction "copie de fichier" / "copie de dossier".
// Defauts prouves sur le vrai lien (cf. README) : 107 Mo/s stables sur 1 fichier.
export type Settings = {
  parallel: number; // fichiers copies en meme temps (taille de la file active)
  streams: number; // flux paralleles par gros fichier EN TELECHARGEMENT (multi-thread-streams)
  // Idem mais pour l'ENVOI (local -> serveur). Reglage distinct : l'upload
  // multi-connexions ouvre une session SSH par flux, et un serveur peut
  // plafonner le nombre de connexions simultanees (OpenSSH MaxStartups /
  // MaxSessions, fail2ban...). En cas de refus, le transfert se rabat tout seul
  // sur moins de flux (cf. le fallback dans failXfer), donc on peut viser haut.
  uploadStreams: number;
  cutoff: string; // taille a partir de laquelle on decoupe, ex "256M"
  chunkSize: string; // taille des morceaux (multi-thread-chunk-size), ex "128M"
  sftpConcurrency: number; // concurrence SFTP (--sftp-concurrency)
  bwlimit: string; // limite de debit (--bwlimit), "" = illimite
  retries: number; // tentatives de reprise auto apres coupure (0 = illimite)
  showHidden: boolean; // afficher les fichiers et dossiers caches
  // Lecteurs reseau / volumes distants (SMB, NAS...) caches par defaut dans le
  // volet de navigation local : evite de meler par erreur une copie SFTP vers
  // un NAS avec le meme NAS monte en lecteur reseau (boucle absurde).
  showNetworkDrives: boolean;
  // Verifier au demarrage si une nouvelle version est publiee (cf. Updater.tsx).
  checkUpdates: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
  parallel: 4,
  streams: 16,
  uploadStreams: 16,
  cutoff: "256M",
  chunkSize: "128M",
  sftpConcurrency: 128,
  bwlimit: "",
  retries: 10,
  showHidden: false,
  showNetworkDrives: false,
  checkUpdates: true,
};

export function loadSettings(): Settings {
  const s = { ...DEFAULT_SETTINGS };
  try {
    const raw = JSON.parse(localStorage.getItem("copiteur.settings") || "{}");
    // On ne reprend que les cles connues : les anciens reglages (fileStreams,
    // dirTransfers, dirStreams) sont ainsi abandonnes au profit des defauts.
    for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
      if (typeof raw[k] === typeof DEFAULT_SETTINGS[k])
        (s as Record<string, unknown>)[k] = raw[k];
    }
  } catch {
    /* reglages illisibles : on garde les defauts */
  }
  return s;
}
export function saveSettings(s: Settings) {
  localStorage.setItem("copiteur.settings", JSON.stringify(s));
}

// Options rclone `_config` d'un transfert (un transfert = un fichier).
export function xferConfig(s: Settings): Record<string, unknown> {
  const c: Record<string, unknown> = {
    MultiThreadStreams: s.streams,
    MultiThreadChunkSize: s.chunkSize,
    MultiThreadCutoff: s.cutoff,
    // Liens instables (4G en itinerance, train) : on veut echouer VITE pour que
    // la reprise automatique reprenne la main, au lieu de rester pendu sur les
    // 5 minutes d'attente par defaut de rclone.
    Timeout: "1m0s",
    ConnectTimeout: "30s",
    // Ecriture DIRECTE au nom final, sans fichier « .partial » puis renommage
    // (c'est exactement l'approche de FileZilla, verifiee : ecriture en place,
    // pas de temp-file+rename). Ce renommage etait la cause du « can't move
    // object - incompatible remotes » : rclone jugeait par intermittence le
    // fichier .partial et sa destination « incompatibles » et le rename plantait
    // (constate massivement sur une copie de 450 Go, tous calibres, y compris un
    // Thumbs.db de quelques Ko -> donc PAS lie au multi-thread). Sans rename,
    // l'erreur ne peut plus survenir. Contrepartie assumee (comme FileZilla) :
    // une copie interrompue laisse un fichier tronque au nom final ; la reprise
    // auto le reecrit.
    Inplace: true,
    // TOUJOURS present : ces reglages sont poses GLOBALEMENT sur le daemon
    // (options/set), un etat persistant. Omettre BwLimit quand on retire une
    // limite la laisserait active jusqu'au redemarrage — on envoie donc « 0 »
    // (illimite). Une chaine VIDE, elle, ferait echouer TOUT le bloc cote rclone
    // (« Reshape failed to Unmarshal: empty string »), annulant aussi les
    // reglages multi-thread : d'ou le repli sur « 0 ».
    BwLimit: s.bwlimit.trim() || "0",
  };
  return c;
}

// ---- File d'attente --------------------------------------------------------
// Un transfert = UN fichier (les dossiers sont eclates a l'ajout). C'est ce qui
// rend la file lisible, la limite de transferts simultanes exacte, et la reprise
// possible fichier par fichier.
export type XferStatus =
  | "queued" // en attente d'un creneau
  | "starting" // creneau pris, on attend le numero de job de rclone
  | "running" // copie en cours
  | "retry" // coupure : attente avant reprise automatique
  | "done"
  | "error"
  | "cancelled";

export type Xfer = {
  id: number;
  group: string; // groupe de stats rclone ("copy/<id>")
  jobid: number;
  name: string; // nom du fichier
  rel: string; // sous-dossier relatif ("" si a la racine de la copie)
  srcFs: string;
  srcRemote: string;
  dstFs: string;
  dstRemote: string;
  size: number;
  bytes: number;
  speed: number;
  status: XferStatus;
  error: string;
  attempts: number;
  nextTry: number; // date (ms) de la prochaine tentative si status = "retry"
  // ENVOI seulement : nombre de flux multi-thread EFFECTIF de ce transfert. Part
  // du reglage `uploadStreams` et se divise par deux a chaque echec sans progres
  // (serveur qui refuse trop de connexions), jusqu'a 1 (mono-connexion). Absent
  // = pas encore degrade, on prend la valeur du reglage.
  upStreams?: number;
  // Date (ms) du dernier octet arrive, pour reperer un transfert FIGE sans
  // toucher aux delais reseau (cf. STALL_MS).
  movedAt?: number;
  // L'echec ressemble a un nom refuse par la destination : on proposera de le
  // renommer plutot que de reessayer a l'identique (ce qui echouerait pareil).
  nameFault?: boolean;
  // Deja renomme une fois : evite de reproposer indefiniment si ca rate encore
  // pour une autre raison.
  renamed?: boolean;
  // A echoue parce que le serveur ne sait pas calculer d'empreinte. Sert a
  // relancer exactement ces transferts une fois la connexion reconfiguree.
  hashFault?: boolean;
  // Deja relance apres la bascule « sans empreinte » : garde-fou contre une
  // boucle si l'echec se reproduit pour une autre raison.
  hashRetried?: boolean;
  // Ouverture d'un fichier distant : chemin local a ouvrir une fois la copie
  // arrivee. Absent pour un transfert normal.
  openOnDone?: string;
  // Ce telechargement doit etre mis sous surveillance d'edition une fois arrive.
  editWatch?: boolean;
  // Etat du fichier DISTANT au moment de l'ouverture (pour detecter un conflit :
  // le serveur a-t-il change depuis, avant qu'on renvoie ?).
  editBaseMod?: string;
  // Ce transfert est un RENVOI d'edition : id du fichier edite (pour re-empreindre
  // la reference une fois le renvoi termine).
  editId?: number;
};

// ---- Edition d'un fichier distant -----------------------------------------
export type EditState = "watching" | "changed" | "uploading";

// Fichier distant ouvert pour edition, surveille localement. On garde de quoi le
// renvoyer sans re-demander au backend : dossier local + nom + cible distante.
export type EditItem = {
  id: number;
  label: string;
  state: EditState;
  localDir: string; // dossier de la copie (termine par "/")
  name: string; // nom du fichier
  dstFs: string; // fs rclone distant (cible du renvoi)
  dstRemote: string; // chemin rclone distant
  // Etat du fichier distant a l'ouverture (detection de conflit avant renvoi).
  baseRemoteMod: string;
  baseRemoteSize: number;
};

export const FINAL: XferStatus[] = ["done", "error", "cancelled"];
export const isFinal = (x: Xfer) => FINAL.includes(x.status);

// Un fichier a copier, une fois le dossier eclate.
export type Plan = {
  name: string;
  rel: string;
  size: number;
  src: { fs: string; remote: string };
  dst: { fs: string; remote: string };
};

// Eclate un element depose (fichier OU dossier) en une liste de fichiers a
// copier. Un dossier est liste recursivement : chaque fichier devient une ligne
// de la file. `mkdirs` = les dossiers VIDES, qu'une copie fichier par fichier ne
// creerait jamais (rclone cree les dossiers parents des fichiers, pas les vides).
export async function planItem(
  srcSide: Side,
  srcDir: string,
  item: Entry,
  destSide: Side,
  destDir: string,
): Promise<{ plans: Plan[]; mkdirs: { fs: string; remote: string }[] }> {
  if (!item.IsDir) {
    return {
      plans: [
        {
          name: item.Name,
          rel: "",
          size: item.Size,
          src: fileAddr(srcSide, srcDir, item.Name),
          dst: fileAddr(destSide, destDir, item.Name),
        },
      ],
      mkdirs: [],
    };
  }

  const srcRoot = joinDir(srcDir, item.Name);
  const dstRoot = joinDir(destDir, item.Name);

  // PIEGE (corrige) : `operations/list` renvoie `Path` relatif au `fs` demande,
  // PAS au couple {fs, remote}. Sur un SFTP reel, lister via
  // {fs:"serveur:", remote:"a/b"} renvoie donc des Path ABSOLUS ("a/b/c.jpg"),
  // qui, re-joints a `srcRoot`, doublaient le chemin ("a/b/a/b/c.jpg") -> rclone
  // repond "object not found" sur TOUTE copie de dossier DEPUIS le serveur. On
  // ancre donc le `fs` sur `srcRoot` (remote vide) : `Path` revient alors relatif
  // a `srcRoot` des deux cotes (local ET distant), comme le suppose la suite.
  const srcRootFs = dirFs(srcSide, srcDir, item.Name);

  const files = await rc<{ list: Entry[] }>("operations/list", {
    fs: srcRootFs,
    remote: "",
    opt: { recurse: true, filesOnly: true },
  });
  // `Path` est le chemin relatif a `srcRoot` (ex. "rushs/jour1/a.mp4").
  const plans: Plan[] = (files.list ?? []).map((e) => ({
    name: e.Name,
    rel: e.Path.slice(0, Math.max(0, e.Path.length - e.Name.length - 1)),
    size: e.Size,
    src: fileAddr(srcSide, srcRoot, e.Path),
    dst: fileAddr(destSide, dstRoot, e.Path),
  }));

  // Dossiers vides = ceux qu'aucun fichier ne "traverse".
  const dirs = await rc<{ list: Entry[] }>("operations/list", {
    fs: srcRootFs,
    remote: "",
    opt: { recurse: true, dirsOnly: true },
  }).catch(() => ({ list: [] as Entry[] }));
  const traversed = new Set<string>();
  for (const p of plans) {
    let r = p.rel;
    while (r) {
      traversed.add(r);
      const i = r.lastIndexOf("/");
      r = i < 0 ? "" : r.slice(0, i);
    }
  }
  const mkdirs = (dirs.list ?? [])
    .filter((d) => !traversed.has(d.Path))
    .map((d) => fileAddr(destSide, dstRoot, d.Path));
  // Le dossier depose est lui-meme vide : rien ne le creerait.
  if (!plans.length) mkdirs.push(fileAddr(destSide, destDir, item.Name));

  return { plans, mkdirs };
}

// ---- Elements caches -------------------------------------------------------
// rclone ne connait PAS la notion de « cache » (verifie : aucun drapeau, ni pour
// le backend local, ni pour le SFTP) — il liste tout. On la reconstitue donc,
// et elle ne veut pas dire la meme chose partout :
//   - Unix / macOS / SFTP : convention de NOM (le point devant) ;
//   - Windows : ATTRIBUT du systeme de fichiers, absent du nom => backend (cf.
//     la commande `hidden_names`, qui lit aussi l'attribut « systeme »).
const isWindows = navigator.userAgent.includes("Windows");

// Bruit systeme d'un NAS (masque par les interfaces natives Synology/QNAP) : on
// le cache aussi, sinon la racine d'un volume (ex. /volume1) ou une racine brute
// ressemble a un depotoir. Reste revelable via « afficher les elements caches ».
// Conventions NAS : dossiers systeme prefixes par « @ », corbeilles « #… »,
// quotas et lost+found. Un vrai partage ne commence quasiment jamais par « @ ».
const SYNO_SYSTEM = new Set([
  "#recycle",
  "#snapshot",
  "lost+found",
  "aquota.user",
  "aquota.group",
]);

// Element cache d'apres son NOM (le seul critere hors Windows).
export function isNameHidden(side: Side, name: string): boolean {
  if (name.startsWith(".")) return true;
  if (side !== "remote") return false;
  return name.startsWith("@") || SYNO_SYSTEM.has(name);
}

// Noms portant l'attribut « cache »/« systeme » de Windows (vide ailleurs).
export async function hiddenAttrNames(
  side: Side,
  dir: string,
  list: Entry[],
): Promise<Set<string>> {
  if (side !== "local" || !isWindows || !list.length) return new Set();
  try {
    const names = await invoke<string[]>("hidden_names", {
      dir,
      names: list.map((e) => e.Name),
    });
    return new Set(names);
  } catch {
    // Attribut illisible : on prefere afficher plutot que masquer a tort.
    return new Set();
  }
}

// Choisit l'icone d'un lecteur local selon son type + son nom (detection cloud).
export type DriveKind = "fixed" | "network" | "removable" | "cdrom" | "cloud";
export function driveKindFor(label: string, driveType: string): DriveKind {
  const l = label.toLowerCase();
  if (
    driveType !== "network" &&
    /(google drive|onedrive|dropbox|icloud|nextcloud|\bmega\b|pcloud)/.test(l)
  )
    return "cloud";
  if (driveType === "network" || driveType === "removable" || driveType === "cdrom")
    return driveType;
  return "fixed";
}

// ---- Recherche permissive (facon Feedback) --------------------------------
// Normalise un texte pour une comparaison tolerante : minuscules, accents
// replies (é -> e), et surtout SUPPRESSION de tout ce qui n'est pas
// alphanumerique (espaces, underscores, tirets, points...). Ainsi la requete
// « xiaomi su7 » (-> "xiaomisu7") retrouve « XIAOMI_SU7.MP4 » (-> "xiaomisu7mp4")
// par simple sous-chaine, et « iaomi » retrouve le meme fichier.
const COMBINING = new RegExp("[\\u0300-\\u036f]", "g"); // diacritiques (NFD)
export function searchNorm(s: string): string {
  return s
    .normalize("NFD")
    .replace(COMBINING, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

// Un nom correspond a une requete si CHAQUE mot de la requete (normalise) est
// une sous-chaine du nom normalise, dans n'importe quel ordre. Decouper en mots
// rend « su7 xiaomi » aussi efficace que « xiaomi su7 ». Requete vide = tout
// passe (pas de filtrage).
export function matchesSearch(name: string, query: string): boolean {
  const tokens = query.split(/\s+/).map(searchNorm).filter(Boolean);
  if (tokens.length === 0) return true;
  const hay = searchNorm(name);
  return tokens.every((t) => hay.includes(t));
}

// ---- Types de fichiers : categorie d'icone + libelle FR --------------------
export type IconKind =
  | "folder"
  | "video"
  | "image"
  | "audio"
  | "archive"
  | "doc"
  | "premiere"
  | "aftereffects"
  | "file";

const EXT_ICON: Record<string, IconKind> = {};
const add = (kind: IconKind, exts: string) =>
  exts.split(" ").forEach((e) => (EXT_ICON[e] = kind));
add("video", "mp4 mov mkv avi m4v webm mxf mts m2ts wmv flv mpg mpeg");
add("image", "jpg jpeg png gif webp bmp tif tiff heic heif raw cr2 cr3 arw nef dng psd svg");
add("audio", "wav mp3 aac flac m4a ogg aif aiff wma");
add("archive", "zip rar 7z tar gz bz2 xz");
add("doc", "pdf doc docx txt rtf odt xls xlsx ppt pptx csv md");
add("premiere", "prproj");
add("aftereffects", "aep");

export function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

export function iconKind(e: Entry): IconKind {
  if (e.IsDir) return "folder";
  return EXT_ICON[extOf(e.Name)] ?? "file";
}

// Libelle « Type » facon Windows : « Dossier de fichiers » / « Fichier MP4 ».
export function typeLabel(e: Entry): string {
  if (e.IsDir) return "Dossier de fichiers";
  const ext = extOf(e.Name);
  return ext ? `Fichier ${ext.toUpperCase()}` : "Fichier";
}

// ---- Formatage -------------------------------------------------------------
export function humanSize(n: number): string {
  if (n < 0) return "";
  if (n === 0) return "0 o";
  const u = ["o", "Ko", "Mo", "Go", "To"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  // < 1024 o : on arrondit a l'entier. Sans ca, une valeur fractionnaire
  // (typiquement une vitesse « 0,2 o/s » en fin de transfert) s'afficherait avec
  // toutes ses decimales (« 0.2091419499856701 o/s »).
  return `${i === 0 ? Math.round(v) : v.toFixed(1).replace(".", ",")} ${u[i]}`;
}

// Convertit une taille facon rclone ("256M", "128M", "1G", "512K") en octets.
// Base 1024, comme rclone. Sert a savoir si un fichier depasse le seuil de
// decoupe multi-thread. Une chaine vide ou illisible -> 0 (tout depasse 0, donc
// on ne bride personne par erreur).
export function parseSize(s: string): number {
  const m = /^\s*([\d.,]+)\s*([KMGT])?/i.exec(s);
  if (!m) return 0;
  const n = parseFloat(m[1].replace(",", "."));
  if (!isFinite(n)) return 0;
  const mul: Record<string, number> = {
    K: 1024,
    M: 1024 ** 2,
    G: 1024 ** 3,
    T: 1024 ** 4,
  };
  return n * (m[2] ? mul[m[2].toUpperCase()] : 1);
}

// Nombre de flux multi-thread EFFECTIF d'un transfert, pour l'afficher a cote du
// debit. Envoi -> le reglage `uploadStreams`, ou la valeur DEJA rabaissee par le
// fallback (`x.upStreams`, cf. failXfer) ; telechargement -> `streams`. Un
// fichier sous le seuil de decoupe (`cutoff`) n'est jamais decoupe par rclone,
// quel que soit le reglage : 1 flux.
// `fallback` = un ENVOI rabaisse par un refus de connexions du serveur (a
// signaler visuellement) ; un simple « 1 flux » de petit fichier n'en est PAS un
// (c'est normal), on ne l'alarme donc pas.
export function xferStreams(
  x: Xfer,
  s: Settings,
): { n: number; fallback: boolean } {
  const isUpload = x.dstFs.startsWith(REMOTE);
  const requested = isUpload ? (x.upStreams ?? s.uploadStreams) : s.streams;
  const n = x.size >= parseSize(s.cutoff) ? Math.max(1, requested) : 1;
  const fallback =
    isUpload && x.upStreams !== undefined && x.upStreams < s.uploadStreams;
  return { n, fallback };
}

const DT = new Intl.DateTimeFormat("fr-FR", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
export function humanDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return DT.format(d).replace(",", "");
}

// ---- Chemins ---------------------------------------------------------------

// Un chemin colle depuis l'explorateur Windows utilise des \ (ex.
// "C:\Dossier\Sous dossier\") : Copiteur travaille en / partout, donc sans
// conversion tout le chemin colle est vu comme un seul segment du fil
// d'Ariane. On ne touche qu'aux \, jamais un caractere valide dans un nom.
export function normalizeTypedPath(s: string): string {
  return s.replace(/\\/g, "/");
}

export function trimSlashes(s: string): string {
  return s.replace(/^\/+/, "").replace(/\/+$/, "");
}
function withSlash(s: string): string {
  return s.endsWith("/") ? s : s + "/";
}

// `fs` rclone d'un dossier SERVEUR : le chemin ABSOLU est loge dans le `fs`
// (serveur:/  |  serveur:/share/x), jamais dans `remote`. rclone SFTP : un
// slash de tete = chemin absolu depuis la racine du serveur ; sans lui on reste
// prisonnier du dossier d'accueil (l'ancien `remote: trimSlashes(dir)` rabotait
// le slash et enfermait la navigation dans le home). Verifie sur SFTP reel :
// l'absolu passe par le `fs`, un `remote` a slash de tete est nettoye en relatif.
function remoteFs(dir: string): string {
  return REMOTE + "/" + trimSlashes(dir);
}

// Arguments operations/list pour lister le dossier `dir` d'un cote.
export function listArgs(side: Side, dir: string): RcParams {
  return side === "local"
    ? { fs: withSlash(dir), remote: "" }
    : { fs: remoteFs(dir), remote: "" };
}

// Le `Path` que `operations/list` donnera a une entree — c'est la CLE utilisee
// partout pour la selection et le renommage en place. Il est relatif au `fs`, et
// des deux cotes le `fs` est desormais le dossier lui-meme, donc Path = nom nu.
export function entryPath(_side: Side, _dir: string, name: string): string {
  return name;
}

// Adresse {fs, remote} d'un fichier (pour operations/copyfile). `name` peut etre
// un sous-chemin relatif (ex. "rushs/jour1/a.mp4") lors d'une copie recursive.
export function fileAddr(side: Side, dir: string, name: string) {
  return side === "local"
    ? { fs: withSlash(dir), remote: name }
    : { fs: remoteFs(dir), remote: name };
}

// Chaine `fs` COMPLETE d'un dossier (ex. "/home/alice/Rushs" ou
// "serveur:/share/a/b"). Necessaire pour les commandes qui ne prennent pas de
// couple {fs, remote} : `operations/size` (fs seul) et `sync/move` (srcFs/dstFs).
export function dirFs(side: Side, dir: string, name: string): string {
  return side === "local"
    ? withSlash(dir) + name
    : remoteFs(joinDir(dir, name));
}

// ---- Dossier de depart / detection des racines de partages -----------------
// Ou vivent les dossiers partages selon la marque (on NE devine PAS la marque :
// on sonde ces chemins, le premier qui existe gagne). Repli propre si aucun.
const SHARE_BASES = [
  "/volume1",
  "/volume2",
  "/volume3",
  "/volume4",
  "/share",
  "/shares",
  "/mnt/user",
  "/mnt/pool0",
];
// Noms qui trahissent une racine « systeme de fichiers brut » (serveur NON
// chroote). Si "/" en contient, c'est qu'on voit tout le Linux -> il faut aller
// chercher les partages. Sinon "/" est deja une liste de partages (chroot) et on
// n'y touche pas.
const RAW_ROOT_MARKERS = new Set([
  "bin",
  "sbin",
  "etc",
  "usr",
  "var",
  "lib",
  "sys",
  "proc",
  "dev",
  "boot",
  "root",
]);

// Liste les NOMS des sous-dossiers d'un dossier serveur, ou null si illisible.
async function remoteDirNames(dir: string): Promise<string[] | null> {
  try {
    const r = await rc<{ list: Entry[] }>("operations/list", {
      ...listArgs("remote", dir),
      opt: { noModTime: true, dirsOnly: true },
      _config: { ConnectTimeout: "8s", Timeout: "8s", LowLevelRetries: 1 },
    });
    return (r.list ?? []).map((e) => e.Name);
  } catch {
    return null;
  }
}

// Choisit le dossier d'ouverture du panneau serveur, dans l'ordre :
//   1. le dossier de depart memorise, s'il est LISIBLE (exigence : au moins la
//      lecture — sinon on deposerait l'utilisateur sur un dossier illisible) ;
//   2. une racine de partages detectee (/volume1, /share…), mais SEULEMENT si "/"
//      ressemble a un systeme de fichiers brut (sinon le serveur nous chroote
//      deja sur les partages — cas Synology — et on ne change rien) ;
//   3. la racine "/" par defaut.
export async function resolveRemoteStart(startDir?: string): Promise<string> {
  if (startDir) {
    const ok = await remoteDirNames(startDir);
    if (ok !== null) return startDir;
  }
  const rootNames = await remoteDirNames("/");
  if (rootNames && rootNames.some((n) => RAW_ROOT_MARKERS.has(n.toLowerCase()))) {
    for (const base of SHARE_BASES) {
      const names = await remoteDirNames(base);
      if (names && names.length) return base;
    }
  }
  return "/";
}

// Traduit un message d'erreur rclone/SSH brut en une phrase comprehensible.
// Les messages SSH ("unexpected message type 51", "handshake failed"…) sont
// illisibles pour un utilisateur : on rattrape les cas courants.
export function humanConnError(raw: string): string {
  const s = raw.toLowerCase();
  // En premier : l'erreur de cle de rclone contient aussi « handshake failed »,
  // qu'on prendrait sinon pour un mauvais mot de passe.
  if (s.includes("knownhosts") || s.includes("host key") || s.includes("hostkey"))
    return "L'identité du serveur ne correspond pas à celle mémorisée : connexion refusée par sécurité. Reconnectez-vous pour voir l'empreinte présentée.";
  if (s.includes("identité du serveur non vérifiée"))
    return "Identité du serveur non vérifiée : reconnectez-vous et acceptez son empreinte.";
  if (
    s.includes("too many authentication failures") ||
    s.includes("unable to authenticate")
  )
    return "Trop de tentatives d'authentification, le serveur a coupé. Réessayez dans un instant (souvent l'agent SSH qui propose des clés avant le mot de passe).";
  if (
    s.includes("unexpected message type 51") ||
    s.includes("handshake failed") ||
    s.includes("permission denied") ||
    s.includes("auth") // authentication failed, no auth methods…
  )
    return "Identifiant ou mot de passe refusé par le serveur. Vérifiez aussi la casse de l'identifiant (« Alice » ≠ « alice »).";
  if (
    s.includes("no route to host") ||
    s.includes("connection refused") ||
    s.includes("i/o timeout") ||
    s.includes("timeout") ||
    s.includes("ne répond pas") ||
    s.includes("no such host")
  )
    return "Serveur injoignable : vérifiez l'adresse, le port, et que le serveur est bien allumé et accessible.";
  return raw;
}

// Caracteres qu'un nom de fichier ne peut pas porter (union Windows/Unix : on
// prend le plus strict, sinon un nom valide ici serait intransferable la-bas).
const BAD_NAME = /[\\/:*?"<>|]/;

// Caracteres qui font echouer une copie chez au moins un des trois OS ou chez
// rclone (Windows les interdit, et l'encodage des backends distants peut les
// mutiler silencieusement). Les caracteres de controle sont du meme tonneau.
const BAD_IN_NAME = /[\\/:*?"<>|\x00-\x1f]/;
const BAD_IN_NAME_G = /[\\/:*?"<>|\x00-\x1f]/g;

export const hasBadChars = (name: string): boolean => BAD_IN_NAME.test(name);

// Nom nettoye, propose a l'utilisateur avant de reessayer une copie. Le tiret
// bas est la convention la plus repandue (Samba, Syncthing, la plupart des
// gestionnaires de fichiers). On resorbe ensuite les espaces et soulignes qui
// s'agglutinent, sinon « c ? learpipes.jar » donnerait « c _ learpipes.jar ».
export function sanitizeName(name: string): string {
  const clean = name
    .replace(BAD_IN_NAME_G, "_")
    .replace(/\s*_+\s*/g, "_")
    .replace(/^_+|_+$/g, "")
    .trim();
  return clean || "sans-nom";
}
export function nameError(name: string): string {
  const n = name.trim();
  if (!n) return "Le nom ne peut pas être vide.";
  if (BAD_NAME.test(n)) return "Un nom ne peut pas contenir \\ / : * ? \" < > |";
  if (n === "." || n === "..") return "Nom réservé.";
  return "";
}

// « Nouveau dossier », puis « Nouveau dossier (2) »… si le nom est deja pris.
export function freeName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const n = `${base} (${i})`;
    if (!taken.has(n)) return n;
  }
}

// Rejoint un dossier courant + un nom d'enfant.
export function joinDir(dir: string, name: string): string {
  return withSlash(dir) + name;
}

// Dossier parent (gere racines "/" Unix et "C:/" Windows).
export function parentDir(dir: string): string {
  const t = dir.replace(/\/+$/, "");
  if (/^[A-Za-z]:$/.test(t)) return dir; // racine de lecteur : pas de parent
  const i = t.lastIndexOf("/");
  if (i < 0) return dir;
  if (i === 0) return "/";
  return t.slice(0, i + 1);
}

// Fil d'Ariane cliquable : segments {label, path} du chemin courant.
export function breadcrumb(
  side: Side,
  dir: string,
): { label: string; path: string }[] {
  const crumbs: { label: string; path: string }[] = [];
  if (side === "remote") {
    crumbs.push({ label: "Serveur", path: "/" });
    let acc = "/";
    for (const seg of trimSlashes(dir).split("/").filter(Boolean)) {
      acc += seg + "/";
      crumbs.push({ label: seg, path: acc });
    }
    return crumbs;
  }
  // Local : premier segment = lecteur ("C:") ou racine "/".
  const segs = trimSlashes(dir).split("/").filter(Boolean);
  if (dir.startsWith("/")) {
    crumbs.push({ label: "/", path: "/" });
    let acc = "/";
    for (const seg of segs) {
      acc += seg + "/";
      crumbs.push({ label: seg, path: acc });
    }
  } else {
    let acc = "";
    segs.forEach((seg, idx) => {
      acc += (idx === 0 ? seg : seg) + "/";
      crumbs.push({ label: seg, path: acc });
    });
  }
  return crumbs;
}

// ---- Tri (dossiers d'abord, puis selon la colonne) -------------------------
export type SortKey = "name" | "date" | "type" | "size";

export function sortEntries(
  list: Entry[],
  key: SortKey,
  dir: 1 | -1,
): Entry[] {
  const cmp = (a: Entry, b: Entry): number => {
    // Dossiers toujours en premier, comme l'explorateur Windows.
    if (a.IsDir !== b.IsDir) return a.IsDir ? -1 : 1;
    let r = 0;
    switch (key) {
      case "name":
        r = a.Name.localeCompare(b.Name, "fr", { sensitivity: "base" });
        break;
      case "date":
        r = new Date(a.ModTime).getTime() - new Date(b.ModTime).getTime();
        break;
      case "size":
        r = a.Size - b.Size;
        break;
      case "type": {
        const ea = extOf(a.Name);
        const eb = extOf(b.Name);
        r = ea.localeCompare(eb) || a.Name.localeCompare(b.Name, "fr");
        break;
      }
    }
    return r * dir;
  };
  return [...list].sort(cmp);
}
