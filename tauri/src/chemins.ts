// ============================================================
//  Comprendre un chemin colle depuis le Finder ou l'explorateur Windows
// ============================================================
//
// On colle dans la barre d'adresse le dossier qu'on a deja sous les yeux sur
// son poste. Mais chaque systeme le decore a sa facon, et un chemin de poste
// n'est pas un chemin de serveur :
//
//   Z:\PROJETS\2026\09_SEPTEMBRE\APPLE KEYNOTE      (lettre de lecteur)
//   "Z:\PROJETS\…"                                  (« Copier en tant que chemin »)
//   \\Neufsept\frandroid\PROJETS\…                  (chemin reseau)
//   /Volumes/Frandroid/PROJETS/…                    (volume monte sur Mac)
//   smb://neufsept/frandroid/PROJETS/…              (adresse de partage)
//   file:///Volumes/Frandroid/…/APPLE%20KEYNOTE     (adresse encodee)
//   /volume1/frandroid/PROJETS/…                    (vu depuis le NAS)
//
// LA difficulte : une lettre de lecteur a perdu le nom du partage (`Z:` ne dit
// pas si c'est FRANDROID ou NUMERAMA). On ne devine donc rien : on lit le texte
// (parsePastedPath), on fabrique les emplacements possibles, et on REGARDE
// lesquels existent (resolvePastedPath). Plusieurs reponses => l'interface
// demande ; aucune => elle le dit.

import { invoke } from "@tauri-apps/api/core";
import { rc, fileAddr, listArgs, remoteDirNames, SHARE_BASES, type Side } from "./files";

// Ce qu'on a lu dans le texte colle. Ne touche a aucun disque.
export type PastedPath = {
  letter: string | null; // lettre de lecteur Windows (« Z »)
  host: string | null; // serveur nomme (UNC, smb://)
  share: string | null; // partage nomme (UNC, smb://, /Volumes/X, /volume1/X…)
  posix: string | null; // chemin Unix absolu tel qu'ecrit (candidat direct)
  segments: string[]; // ce qui suit la racine (lecteur, partage, volume)
};

// Un emplacement trouve : le dossier a ouvrir, et le fichier a y selectionner
// quand c'est un fichier qui a ete colle.
export type PathHit = { dir: string; file: string | null };

// Meme forme que les racines renvoyees par la commande Rust `local_roots`.
type LocalRoot = {
  label: string;
  path: string;
  kind: string;
  driveType: string;
  unc: string;
};

// Schemas dont le chemin est deja absolu cote serveur (sftp://hote/volume1/x).
const SERVER_SCHEMES = new Set(["sftp", "ssh", "scp", "ftp", "ftps"]);

export function parsePastedPath(raw: string): PastedPath | null {
  // Premiere ligne seulement, sans les guillemets aux extremites : le Finder
  // (« Copier … en tant que chemin d'acces ») et l'explorateur Windows
  // (« Copier en tant que chemin ») en ajoutent, droits ou typographiques.
  let s = (raw.split(/\r?\n/)[0] ?? "")
    .trim()
    .replace(/^["'«»“”‘’\s]+/, "")
    .replace(/["'«»“”‘’\s]+$/, "");
  if (!s) return null;
  // Chemin glisse dans le Terminal macOS : espaces et parentheses echappes
  // (« /Volumes/Frandroid/APPLE\ KEYNOTE »). Un \ suivi d'un tel caractere
  // n'est jamais un separateur Windows.
  if (s.startsWith("/")) s = s.replace(/\\([ ()'"&!$])/g, "$1");

  let host: string | null = null;
  let share: string | null = null;
  let letter: string | null = null;
  let posix: string | null = null;

  // Adresse : file:///…, smb://hote/partage/…, sftp://hote/chemin. On ne decode
  // les %20 QUE dans une adresse : dans un chemin brut, un « % » est un vrai
  // caractere du nom.
  const scheme = s.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (scheme) {
    s = s.slice(scheme[0].length);
    try {
      s = decodeURIComponent(s);
    } catch {
      /* encodage douteux : on garde le texte tel quel */
    }
    if (s.startsWith("/")) {
      // file:///C:/Users/… -> C:/Users/…
      if (/^\/[a-z]:/i.test(s)) s = s.slice(1);
    } else {
      const cut = s.indexOf("/");
      const h = (cut < 0 ? s : s.slice(0, cut)).replace(/^.*@/, "").replace(/:\d+$/, "");
      const rest = cut < 0 ? "/" : s.slice(cut);
      // sftp://hote/volume1/x : le chemin est deja celui du serveur.
      // smb://hote/partage/x, file://hote/partage/x : forme UNC.
      s = SERVER_SCHEMES.has(scheme[1].toLowerCase()) ? rest : `//${h}${rest}`;
    }
  }

  s = s.replace(/\\/g, "/");
  let rest: string[];

  let m: RegExpMatchArray | null;
  if (/^\/\/[^/]/.test(s)) {
    // \\hote\partage\… (devenu //hote/partage/…).
    const parts = s.slice(2).split("/");
    host = parts.shift() || null;
    share = parts.shift() || null;
    rest = parts;
  } else if ((m = s.match(/^([a-z]):(\/|$)/i))) {
    letter = m[1].toUpperCase();
    rest = s.slice(2).split("/");
  } else if (s.startsWith("/")) {
    const parts = s.split("/").filter(Boolean);
    posix = "/" + parts.join("/");
    // Points de montage connus : le dossier qui suit est le PARTAGE (sur Mac,
    // le volume porte le nom du partage dans l'immense majorite des cas).
    //   /Volumes/X (macOS)   /volume1/X (Synology)   /share/X ou
    //   /share/CACHEDEV1_DATA/X (QNAP)   /mnt/user/X (Unraid)   /media/moi/X (Linux)
    let skip = 0;
    const p0 = (parts[0] ?? "").toLowerCase();
    if (p0 === "volumes" || /^volume\d+$/.test(p0)) skip = 1;
    else if (p0 === "share") skip = /^cachedev\d+_data$/i.test(parts[1] ?? "") ? 2 : 1;
    else if (p0 === "mnt" || p0 === "media") skip = 2;
    if (skip && parts.length > skip) {
      share = parts[skip];
      rest = parts.slice(skip + 1);
    } else {
      rest = parts;
    }
  } else {
    // Chemin relatif : rien a resoudre, la barre d'adresse fait comme avant.
    return null;
  }

  const segments = rest.filter((x) => x && x !== ".");
  return { letter, host, share, posix, segments };
}

// \\hote\partage\sous\dossier -> { host, share, sub }.
function uncParts(unc: string): { host: string; share: string; sub: string[] } | null {
  const parts = unc.replace(/\\/g, "/").replace(/^\/+/, "").split("/").filter(Boolean);
  if (parts.length < 2) return null;
  return { host: parts[0], share: parts[1], sub: parts.slice(2) };
}

const eq = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0;

// Retire `prefix` du debut de `segs` (sans tenir compte de la casse) ; null si
// `segs` ne commence pas par `prefix`.
function stripPrefix(segs: string[], prefix: string[]): string[] | null {
  if (prefix.length > segs.length) return null;
  for (let i = 0; i < prefix.length; i++) if (!eq(segs[i], prefix[i])) return null;
  return segs.slice(prefix.length);
}

// Un candidat : un dossier racine (avec / final) + les segments a ajouter.
type Cand = { base: string; segs: string[] };
const slash = (s: string) => (s.endsWith("/") ? s : s + "/");

// Regarde si le candidat existe : "dir", "file" ou null.
async function probe(side: Side, c: Cand): Promise<"dir" | "file" | null> {
  const opts =
    side === "remote"
      ? { _config: { ConnectTimeout: "8s", Timeout: "8s", LowLevelRetries: 1 } }
      : {};
  try {
    if (c.segs.length === 0) {
      await rc("operations/list", {
        ...listArgs(side, c.base),
        opt: { noModTime: true, dirsOnly: true },
        ...opts,
      });
      return "dir";
    }
    const parent = slash(c.base) + c.segs.slice(0, -1).join("/");
    const r = await rc<{ item: { IsDir: boolean } | null }>("operations/stat", {
      ...fileAddr(side, parent, c.segs[c.segs.length - 1]),
      ...opts,
    });
    if (!r.item) return null;
    return r.item.IsDir ? "dir" : "file";
  } catch {
    return null;
  }
}

// Essaie les candidats d'un palier EN PARALLELE et rend ceux qui existent
// (dedoublonnes, dans l'ordre des candidats).
async function probeAll(side: Side, cands: Cand[]): Promise<PathHit[]> {
  const seen = new Set<string>();
  const uniq = cands.filter((c) => {
    const k = slash(c.base) + c.segs.join("/");
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const kinds = await Promise.all(uniq.map((c) => probe(side, c)));
  const hits: PathHit[] = [];
  uniq.forEach((c, i) => {
    const k = kinds[i];
    if (!k) return;
    if (k === "dir") hits.push({ dir: slash(c.base) + c.segs.join("/"), file: null });
    else
      hits.push({
        dir: slash(c.base) + c.segs.slice(0, -1).join("/"),
        file: c.segs[c.segs.length - 1],
      });
  });
  return hits;
}

// Noms de partage plausibles : celui ecrit dans le chemin, et celui qu'on
// retrouve via les lecteurs du poste (Z: -> \\hote\partage sous Windows,
// /Volumes/X -> //hote/partage sous macOS). `sub` = sous-dossier du partage
// auquel le lecteur est branche (un lecteur peut pointer \\hote\partage\PROJETS).
async function shareHints(
  p: PastedPath,
  roots: () => Promise<LocalRoot[]>,
): Promise<{ share: string; sub: string[] }[]> {
  const out: { share: string; sub: string[] }[] = [];
  if (p.share) out.push({ share: p.share, sub: [] });
  let mount: LocalRoot | undefined;
  if (p.letter) {
    const want = `${p.letter}:/`.toLowerCase();
    mount = (await roots()).find((r) => r.path.toLowerCase() === want);
  } else if (p.posix && p.share && /^\/volumes\//i.test(p.posix)) {
    mount = (await roots()).find((r) => eq(r.path, `/Volumes/${p.share}/`));
  }
  const u = mount?.unc ? uncParts(mount.unc) : null;
  if (u) out.push({ share: u.share, sub: u.sub });
  return out;
}

// Paliers de candidats, du plus sur au plus large. On s'arrete au premier
// palier qui trouve quelque chose : un chemin qui existe tel quel ne doit pas
// etre noye parmi des homonymes trouves ailleurs.
type Tier = () => Promise<Cand[]>;

function localTiers(p: PastedPath, roots: () => Promise<LocalRoot[]>, isWin: boolean): Tier[] {
  const segs = p.segments;
  const volumes = async () =>
    (await roots()).filter((r) => r.kind === "drive" && r.path !== "/");
  const tiers: Tier[] = [];

  if (isWin) {
    if (p.letter) tiers.push(async () => [{ base: `${p.letter}:/`, segs }]);
    if (p.share) {
      // Un lecteur reseau branche sur ce partage (et ce serveur s'il est nomme).
      tiers.push(async () =>
        (await volumes()).flatMap((r) => {
          const u = r.unc ? uncParts(r.unc) : null;
          if (!u || !eq(u.share, p.share!) || (p.host && !eq(u.host, p.host))) return [];
          const left = stripPrefix(segs, u.sub);
          return left ? [{ base: r.path, segs: left }] : [];
        }),
      );
      // Puis le chemin reseau lui-meme (\\hote\partage\…), sans lecteur.
      if (p.host) tiers.push(async () => [{ base: `//${p.host}/${p.share}/`, segs }]);
      // Puis le meme partage atteint depuis un autre serveur (Mac -> Windows :
      // le nom du serveur n'est pas ecrit).
      tiers.push(async () =>
        (await volumes()).flatMap((r) => {
          const u = r.unc ? uncParts(r.unc) : null;
          if (!u || !eq(u.share, p.share!)) return [];
          const left = stripPrefix(segs, u.sub);
          return left ? [{ base: r.path, segs: left }] : [];
        }),
      );
    }
    return tiers;
  }

  // macOS / Linux.
  if (p.posix) tiers.push(async () => [{ base: "/", segs: p.posix!.split("/").filter(Boolean) }]);
  if (p.share) {
    // Volume monte de ce partage : par son adresse (unc), ou par son nom (le
    // Finder ajoute « -1 » quand deux partages ont le meme nom).
    tiers.push(async () =>
      (await volumes()).flatMap((r) => {
        const u = r.unc ? uncParts(r.unc) : null;
        const sameShare = u ? eq(u.share, p.share!) : false;
        const sameName =
          eq(r.label, p.share!) || new RegExp(`^${escapeRe(p.share!)}-\\d+$`, "i").test(r.label);
        if (!sameShare && !sameName) return [];
        const left = u && sameShare ? stripPrefix(segs, u.sub) : segs;
        return left ? [{ base: r.path, segs: left }] : [];
      }),
    );
  }
  // Lettre de lecteur (chemin d'un collegue sous Windows) ou partage monte sous
  // un autre nom : on essaie chaque volume monte.
  if (p.letter || p.share) {
    tiers.push(async () => (await volumes()).map((r) => ({ base: r.path, segs })));
  }
  return tiers;
}

function remoteTiers(
  p: PastedPath,
  roots: () => Promise<LocalRoot[]>,
  currentDir: string,
): Tier[] {
  const segs = p.segments;
  const tiers: Tier[] = [];
  // Chemin du serveur colle tel quel (/volume1/x, sftp://hote/volume1/x).
  if (p.posix) tiers.push(async () => [{ base: "/", segs: p.posix!.split("/").filter(Boolean) }]);

  // Ou chercher les partages : le dossier courant et ses parents (le serveur
  // sur lequel on est connecte nous dit ou il les range), puis la racine et
  // les emplacements connus des NAS.
  const bases: string[] = ["/"];
  let acc = "/";
  for (const seg of currentDir.split("/").filter(Boolean).slice(0, 3)) {
    acc += seg + "/";
    bases.push(acc);
  }
  for (const b of [...SHARE_BASES, "/share/CACHEDEV1_DATA", "/share/CACHEDEV2_DATA"]) {
    if (!bases.includes(slash(b))) bases.push(slash(b));
  }
  // Noms des sous-dossiers de chaque base (une seule lecture par base, et
  // seulement si on arrive jusqu'aux paliers qui en ont besoin).
  let listed: Promise<{ base: string; names: string[] }[]> | null = null;
  const listing = () =>
    (listed ??= Promise.all(
      bases.map(async (base) => ({ base, names: (await remoteDirNames(base)) ?? [] })),
    ));

  // Partage connu (ecrit, ou retrouve via le lecteur du poste) : on le cherche
  // dans chaque base, sans tenir compte de la casse (« frandroid » dans un
  // chemin Windows, « FRANDROID » sur le NAS).
  tiers.push(async () => {
    const hints = await shareHints(p, roots);
    if (!hints.length) return [];
    return (await listing()).flatMap(({ base, names }) =>
      hints.flatMap((h) =>
        names
          .filter((n) => eq(n, h.share))
          // Le lecteur est branche sur un sous-dossier du partage : les
          // segments colles sont relatifs a ce sous-dossier.
          .map((n) => ({ base, segs: [n, ...h.sub, ...segs] })),
      ),
    );
  });

  // Partage inconnu : chaque dossier de chaque base peut etre le bon.
  tiers.push(async () =>
    (await listing()).flatMap(({ base, names }) => [
      { base, segs },
      ...names.filter((n) => !isNoise(n)).map((n) => ({ base, segs: [n, ...segs] })),
    ]),
  );
  return tiers;
}

// Dossiers systeme des NAS : jamais des partages.
function isNoise(name: string): boolean {
  return /^[@#.]/.test(name) || /^(lost\+found|aquota\..*)$/i.test(name);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Rend les emplacements ou le chemin colle existe : 0 = introuvable, 1 = on y
// va, plusieurs = l'utilisateur choisit.
export async function resolvePastedPath(
  side: Side,
  p: PastedPath,
  currentDir: string,
  isWin: boolean,
): Promise<PathHit[]> {
  let cached: Promise<LocalRoot[]> | null = null;
  const roots = () =>
    (cached ??= invoke<LocalRoot[]>("local_roots").catch(() => [] as LocalRoot[]));
  const tiers = side === "local" ? localTiers(p, roots, isWin) : remoteTiers(p, roots, currentDir);
  for (const tier of tiers) {
    // Garde-fou : un serveur avec des centaines de partages ne doit pas
    // declencher des centaines de requetes.
    const hits = await probeAll(side, (await tier()).slice(0, 80));
    if (hits.length) return hits;
  }
  return [];
}
