// Compile le sidecar copiteur-mtp (telephones Android en MTP -> WebDAV local)
// et le range dans src-tauri/binaries/ sous le nom attendu par `externalBin` :
//   binaries/copiteur-mtp-<target-triple>
//
// Usage : node scripts/build-mtp.mjs [--force] [--fake-only] [--keep-temp]
//   --force      recompile meme si le binaire existe deja
//   --fake-only  (toute plateforme) binaire SANS USB (CGO_ENABLED=0), utile
//                seulement pour developper/tester avec `--fake DIR`
//   --keep-temp  garde le dossier de travail (libusb) pour inspection
//   --static-libusb-check (Linux, dev) : refait toute la chaine libusb
//                statique + edition de liens vers un dossier temporaire et
//                verifie qu'aucune libusb dynamique n'est referencee. Sert a
//                valider ce script hors macOS.
//
// macOS SEULEMENT en production (Windows n'embarque pas ce binaire).
//
// libusb est compilee ICI, en STATIQUE, depuis l'archive officielle dont
// l'empreinte SHA-256 est figee ci-dessous : pas de dylib Homebrew a
// embarquer ni a signer, et le binaire fonctionne sur un Mac sans Homebrew.
// libusb est sous LGPL-2.1 : edition de liens statique acceptable car
// Copiteur est open source (voir tauri/mtp/NOTICES.md).
//
// Aucune dependance npm : Node 20 (fetch, crypto) + outils systeme (tar,
// make, cc, go, otool).

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { cpus, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TAURI_DIR = join(__dirname, "..");
const MTP_DIR = join(TAURI_DIR, "mtp");
const BIN_DIR = join(TAURI_DIR, "src-tauri", "binaries");

// libusb : version et empreinte FIGEES (verifiee aussi contre le "digest"
// publie par GitHub pour cet asset).
const LIBUSB_VERSION = "1.0.29";
const LIBUSB_URL = `https://github.com/libusb/libusb/releases/download/v${LIBUSB_VERSION}/libusb-${LIBUSB_VERSION}.tar.bz2`;
const LIBUSB_SHA256 =
  "5977fc950f8d1395ccea9bd48c06b3f808fd3c2c961b44b0c2e6e29fc3a70a85";

const MACOS_MIN = "11.0";
const GO_MIN = [1, 24]; // directive "go" de tauri/mtp/go.mod

const args = new Set(process.argv.slice(2));
const force = args.has("--force");
const fakeOnly = args.has("--fake-only");
const keepTemp = args.has("--keep-temp");
const staticCheck = args.has("--static-libusb-check");

const isMac = process.platform === "darwin";

function die(msg) {
  console.error(`build-mtp : ${msg}`);
  process.exit(1);
}

function run(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, { stdio: "inherit", ...opts });
  if (r.error) die(`${cmd} : ${r.error.message}`);
  if (r.status !== 0) die(`${cmd} ${argv.join(" ")} a echoue (code ${r.status})`);
}

function capture(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, { encoding: "utf8", ...opts });
  if (r.error || r.status !== 0) return null;
  return r.stdout;
}

function hostTriple() {
  const t = {
    "darwin-arm64": "aarch64-apple-darwin",
    "darwin-x64": "x86_64-apple-darwin",
    "linux-x64": "x86_64-unknown-linux-gnu",
    "linux-arm64": "aarch64-unknown-linux-gnu",
    "win32-x64": "x86_64-pc-windows-msvc",
  }[`${process.platform}-${process.arch}`];
  if (!t) die(`plateforme non geree : ${process.platform}-${process.arch}`);
  return t;
}

// --- localisation de Go ---------------------------------------------------

function parseGoVersion(out) {
  const m = /go(\d+)\.(\d+)(?:\.(\d+))?/.exec(out || "");
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : null;
}

function cmpVer(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d;
  }
  return 0;
}

function goVersionOf(bin) {
  return parseGoVersion(capture(bin, ["version"]));
}

// Ordre : PATH, cache d'outils du runner GitHub (version la plus haute),
// Homebrew, installation officielle.
function findGo(env = process.env, arch = process.arch) {
  const tried = [];
  const ok = (bin) => {
    const v = goVersionOf(bin);
    tried.push(`${bin} -> ${v ? v.join(".") : "absent"}`);
    return v && cmpVer(v, GO_MIN) >= 0 ? bin : null;
  };
  let found = ok("go");
  if (found) return { go: found, tried };
  const cache = env.RUNNER_TOOL_CACHE;
  if (cache && existsSync(join(cache, "go"))) {
    const archDir = arch === "arm64" ? "arm64" : "x64";
    const versions = readdirSync(join(cache, "go"))
      .map((v) => ({ v, p: parseGoVersion("go" + v) }))
      .filter((x) => x.p)
      .sort((a, b) => cmpVer(b.p, a.p));
    for (const { v } of versions) {
      found = ok(join(cache, "go", v, archDir, "bin", "go"));
      if (found) return { go: found, tried };
    }
  }
  for (const p of ["/opt/homebrew/bin/go", "/usr/local/go/bin/go", "/usr/local/bin/go"]) {
    if (existsSync(p) && (found = ok(p))) return { go: found, tried };
  }
  return { go: null, tried };
}

function requireGo() {
  const { go, tried } = findGo();
  if (!go) {
    die(
      `Go >= ${GO_MIN.join(".")} introuvable. Essais :\n  ${tried.join("\n  ")}\n` +
        "Installer Go (https://go.dev/dl/ ou `brew install go`), ou sur GitHub Actions ajouter actions/setup-go.",
    );
  }
  console.log(`Go : ${go} (${goVersionOf(go).join(".")})`);
  return go;
}

// --- libusb statique --------------------------------------------------------

async function buildStaticLibusb(work, extraEnv) {
  const tarball = join(work, `libusb-${LIBUSB_VERSION}.tar.bz2`);
  console.log(`Telechargement de libusb ${LIBUSB_VERSION}`);
  const res = await fetch(LIBUSB_URL, { headers: { "User-Agent": "copiteur-build-mtp" } });
  if (!res.ok) die(`telechargement de libusb : HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = createHash("sha256").update(buf).digest("hex");
  if (got !== LIBUSB_SHA256) {
    die(
      "ARCHIVE libusb REFUSEE : empreinte SHA-256 inattendue.\n" +
        `  attendue : ${LIBUSB_SHA256}\n  obtenue  : ${got}`,
    );
  }
  writeFileSync(tarball, buf);
  console.log(`Empreinte SHA-256 verifiee : ${got.slice(0, 16)}…`);

  const src = join(work, "src");
  mkdirSync(src);
  run("tar", ["-xjf", tarball, "-C", src, "--strip-components", "1"]);
  const prefix = join(work, "prefix");
  const env = { ...process.env, ...extraEnv };
  run(
    "./configure",
    [
      "--disable-shared",
      "--enable-static",
      "--disable-dependency-tracking",
      `--prefix=${prefix}`,
      ...(process.platform === "linux" ? ["--disable-udev"] : []),
    ],
    { cwd: src, env },
  );
  run("make", [`-j${Math.max(cpus().length, 2)}`], { cwd: src, env });
  run("make", ["install"], { cwd: src, env });
  const lib = join(prefix, "lib", "libusb-1.0.a");
  if (!existsSync(lib)) die(`libusb statique absente : ${lib}`);
  if (readdirSync(join(prefix, "lib")).some((f) => /\.(dylib|so)/.test(f))) {
    die("une libusb dynamique a ete produite malgre --disable-shared");
  }
  return prefix;
}

// cgo appelle `$PKG_CONFIG --cflags|--libs -- libusb-1.0` (paquet
// github.com/ganeshrvel/usb : `#cgo pkg-config: libusb-1.0`). Plutot que de
// dependre de pkg-config/pkgconf et de risquer qu'il trouve la libusb de
// Homebrew, on fournit un petit script qui ne connait QUE notre libusb
// statique (chemin absolu vers le .a : pas de -L, donc aucune dylib ne peut
// etre choisie a la place).
function writePkgConfigShim(work, prefix, sysLibs) {
  const cflags = `-I${join(prefix, "include", "libusb-1.0")}`;
  const libs = [join(prefix, "lib", "libusb-1.0.a"), ...sysLibs].join(" ");
  const shim = join(work, "pkg-config-libusb");
  writeFileSync(
    shim,
    `#!/bin/sh
# genere par build-mtp.mjs : pkg-config minimal pour la libusb statique
for a in "$@"; do
  case "$a" in
    --cflags) out="$out ${cflags}" ;;
    --libs) out="$out ${libs}" ;;
    --modversion) echo "${LIBUSB_VERSION}"; exit 0 ;;
    --exists|--print-errors|--) ;;
    libusb-1.0) ;;
    -*) ;;
    *) echo "pkg-config shim: paquet inconnu $a" >&2; exit 1 ;;
  esac
done
echo $out
`,
  );
  chmodSync(shim, 0o755);
  return shim;
}

function goBuild(go, out, env) {
  run(go, ["build", "-trimpath", "-ldflags", "-s -w", "-o", out, "."], {
    cwd: MTP_DIR,
    env: { ...process.env, GOFLAGS: "-mod=readonly", ...env },
  });
}

// --- modes ------------------------------------------------------------------

async function buildMac() {
  const triple = hostTriple();
  mkdirSync(BIN_DIR, { recursive: true });
  const out = join(BIN_DIR, `copiteur-mtp-${triple}`);
  if (existsSync(out) && !force) {
    console.log(`copiteur-mtp deja present : ${out} (--force pour recompiler)`);
    return;
  }
  const go = requireGo();
  const work = mkdtempSync(join(tmpdir(), "copiteur-mtp-build-"));
  try {
    const macEnv = {
      MACOSX_DEPLOYMENT_TARGET: MACOS_MIN,
      CFLAGS: `-O2 -mmacosx-version-min=${MACOS_MIN}`,
    };
    const prefix = await buildStaticLibusb(work, macEnv);
    const shim = writePkgConfigShim(work, prefix, [
      "-lobjc",
      "-framework IOKit",
      "-framework CoreFoundation",
      "-framework Security",
    ]);
    console.log(`Compilation de copiteur-mtp -> ${out}`);
    goBuild(go, out, {
      CGO_ENABLED: "1",
      GOOS: "darwin",
      GOARCH: process.arch === "arm64" ? "arm64" : "amd64",
      PKG_CONFIG: shim,
      MACOSX_DEPLOYMENT_TARGET: MACOS_MIN,
      CGO_CFLAGS: `-O2 -mmacosx-version-min=${MACOS_MIN}`,
      CGO_LDFLAGS: `-mmacosx-version-min=${MACOS_MIN}`,
    });
    // Verification : aucune libusb dynamique referencee.
    const deps = capture("otool", ["-L", out]);
    if (deps === null) die("otool -L a echoue");
    console.log(deps.trim());
    if (/libusb/i.test(deps)) {
      rmSync(out, { force: true });
      die("le binaire reference une libusb dynamique (attendu : libusb statique)");
    }
    console.log(`OK -> ${out}`);
  } finally {
    if (keepTemp) console.log(`Dossier de travail conserve : ${work}`);
    else rmSync(work, { recursive: true, force: true });
  }
}

function buildFakeOnly() {
  const triple = hostTriple();
  const ext = process.platform === "win32" ? ".exe" : "";
  mkdirSync(BIN_DIR, { recursive: true });
  const out = join(BIN_DIR, `copiteur-mtp-${triple}${ext}`);
  if (existsSync(out) && !force) {
    console.log(`copiteur-mtp deja present : ${out} (--force pour recompiler)`);
    return;
  }
  const go = requireGo();
  console.log(`Compilation de copiteur-mtp SANS USB (--fake seulement) -> ${out}`);
  goBuild(go, out, { CGO_ENABLED: "0" });
  console.log(`OK -> ${out}`);
}

// Verification hors macOS de la chaine "libusb statique + shim pkg-config".
async function staticLibusbCheck() {
  if (process.platform !== "linux") die("--static-libusb-check : Linux seulement");
  const go = requireGo();
  const work = mkdtempSync(join(tmpdir(), "copiteur-mtp-check-"));
  try {
    const prefix = await buildStaticLibusb(work, { CFLAGS: "-O2" });
    const shim = writePkgConfigShim(work, prefix, ["-lpthread"]);
    const out = join(work, "copiteur-mtp");
    goBuild(go, out, { CGO_ENABLED: "1", PKG_CONFIG: shim });
    const deps = capture("ldd", [out]) || "";
    console.log(deps.trim());
    if (/libusb/i.test(deps)) die("libusb dynamique referencee");
    console.log("OK : libusb liee statiquement");
  } finally {
    if (keepTemp) console.log(`Dossier de travail conserve : ${work}`);
    else rmSync(work, { recursive: true, force: true });
  }
}

if (staticCheck) {
  await staticLibusbCheck();
} else if (fakeOnly) {
  buildFakeOnly();
} else if (isMac) {
  await buildMac();
} else {
  console.log(
    "copiteur-mtp : binaire macOS uniquement, rien a faire sur cette plateforme " +
      "(--fake-only pour un binaire de test sans USB).",
  );
}
