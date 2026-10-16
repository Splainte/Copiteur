# Copiteur

**English** · [Français](README.fr.md)

Dual-pane SFTP file transfer client, FileZilla-style, powered by
**[rclone](https://rclone.org)**. Built to pull large files (video footage…) from a NAS or a
server at full speed — including when only **one big file** is left, the case where
FileZilla hits its ceiling.

Windows and macOS (Apple Silicon), in English or French. Tauri v2 + React/TypeScript,
bundled rclone.

## Install

Download the latest version from the
[Releases](https://github.com/Splainte/Copiteur/releases/latest):

- **Windows**: `Copiteur_x.y.z_x64-setup.exe`. The installer is not signed: Windows
  SmartScreen shows "Windows protected your PC" → *More info* → *Run anyway*. No
  administrator rights needed.
- **macOS**: `Copiteur_x.y.z_aarch64.dmg`, drag the app into Applications. The app is not
  notarized by Apple: on first launch, right-click the app → *Open* → *Open*
  (or System Settings → Privacy & Security → *Open Anyway*).

The language (English or French) is chosen in the installer on Windows, on first launch on
macOS, and at any time in Settings > Display.

Copiteur then keeps itself up to date: on startup it checks whether a new version exists and
offers to install it. Every update is signed; an update whose signature doesn't match is
rejected.

## What it does

**Transfers** — drag and drop between the two panes and Ctrl/Cmd+C · V, in both directions.
Dropping onto a folder copies into it. A dropped folder is split into one transfer per file.
Four-tab queue (pending / done / failed / cancelled), automatic resume after a network drop,
a "stalled" indicator when not a single byte is getting through.

**Navigation** — tree + list or thumbnails, sorting, breadcrumb, pinned folders, hidden files
hidden by default (including the Windows hidden attribute and Synology system folders).

**Files** — create, rename, move, delete (permanent, with the total size shown), folder size.
Opening a remote file opens it in its associated application; if it is modified, Copiteur
offers to **send it back to the server**, detecting conflicts.

**Log** — filterable timestamped trail, and a copyable "report" with versions, system and
settings, never any password.

## Development

```bash
cd tauri
npm install
npm run prepare-bins      # downloads rclone and checks its SHA-256 fingerprint
npm run tauri dev         # runs the app
npm run tauri build       # installers
```

Checks:

```bash
npx tsc --noEmit                    # types
cd src-tauri && cargo test          # tests (API security, log, editing, paths)
```

### Translations

Interface texts live in `tauri/src/i18n/locales/<language>/`, one file per area of the app,
with the same keys in every language (TypeScript rejects a missing key). To add a language,
copy `locales/en/` to `locales/xx/`, translate it, then declare it in `tauri/src/i18n/index.tsx`
(`DICTS` and `LANGS`). The few texts produced by the Rust side (macOS menus, drive names, some
errors) go through `tr()` in `tauri/src-tauri/src/i18n.rs`.

## Why rclone

A single SFTP connection tops out at ~11 MB/s over a high-latency link: that's the limit of
**one** connection, not of the network. FileZilla only parallelizes **across** files — as soon
as only one big file is left, you drop back to 11 MB/s. rclone can split **a single file**
into several streams to the same server, without installing anything on the NAS.

Measured on a remote NAS over VPN (2026-07-10, one single big file):

| Method | Throughput | Stability |
|---|---|---|
| 1 connection (plain SFTP / SMB) | ~11 MB/s | stable — the ceiling to beat |
| `rclone mount` + chunks | 70-90 MB/s | erratic, unusable |
| `rclone copy --multi-thread-streams 16 --multi-thread-chunk-size 128M` | **107 MB/s** | **stable** |

Confirmed in real use: **142 MB/s** aggregate on a 450 GB copy (2026-07-17).
These values are the app's defaults, adjustable in the settings.

## Technical decisions

**Driven through rclone's API** (`rclone rcd`), not by parsing text output. The app talks
HTTP locally to the daemon: listings, asynchronous copies, per-transfer stats, clean
cancellation.

**Settings applied globally** on the daemon (`options/set`, `main` block), never per job.
A per-copy `_config` made connection instances diverge between the transfer and the rename
that follows it.

**Direct writes** (`--inplace`), like FileZilla. By default rclone writes a `.partial` file
then renames it; that rename intermittently triggers
[rclone#8653](https://github.com/rclone/rclone/issues/8653) (`can't move object - incompatible
remotes`), seen massively on a 450 GB copy, at every file size — so not related to
multi-threading, it's the rename itself. `--inplace` removes that step, and therefore the bug.
*Accepted trade-off*: an interrupted copy leaves a truncated file under its final name; the
resume rewrites it. To revisit if rclone fixes the regression.

**Checksum verification dropped on the fly** when the server can't produce one.
rclone computes the remote checksum by running `md5sum` **over SSH**; if the account can't
run commands, rclone takes the unusable answer for a checksum and compares it —
"corrupted on transfer: md5 hashes differ" with an empty value on one side, and **every**
transfer fails. Copiteur recognizes the signature (an md5 is 32 hex digits), switches the
connection to `disable_hashcheck` and retries. The size is still checked. Per server, reset
on every connection: servers whose checksums work keep them.

**Short timeouts** (`Timeout` 1 min instead of 5) to fail fast on a dead link and let the
resume do its job, rather than hanging.

## Pitfalls encountered

- **Synology paths**: DSM shows `/volume1/SHARE`, but over SFTP the user lands at the root of
  the shares — the correct rclone path is `remote:/SHARE/…`, without `/volume1`.
- **`operations/list` returns a `Path` relative to the `fs`**, not to the `{fs, remote}` pair.
  Joining it back onto the root doubled the path and broke every folder copy from the server.
- **An empty `BwLimit` makes the whole `options/set` block fail** ("empty string"), which also
  cancelled the multi-thread settings. We send `0` for "unlimited".
- **Windows forbids `? < > | " * :`** in a name. rclone replaces them with their full-width
  Unicode equivalents (`？` `＜`…), which display at the width of an ideogram. A round trip
  NAS → Windows → NAS is therefore not neutral.
- **Cmd+Q on macOS doesn't go through window closing**: the default menu is wired to
  `NSApp terminate:`, which bypasses the event loop. A custom menu is needed to intercept it.
- **`scrollbar-gutter` reserves nothing on macOS** (overlay scrollbars): where space really
  needs to be cleared, only an explicit inset works.
- Inherited from the template: synchronous Tauri command = frozen UI (everything is async);
  `no_window()` mandatory on Windows `Command`s; Mica with `expect` = crash on Windows 10.

## Security

**rclone's API is locked by a secret** drawn at random on every launch (32 bytes).
That API can do anything — read, copy, **delete recursively**, read the config. Without a
secret, any program in the session could drive it while Copiteur was running, and a mere web
page could send it "simple" requests that go out without a CORS preflight. The secret is
passed through the process **environment**, never its command line, which `ps` and the Task
Manager expose. Locked down by tests.

**The rclone binary is pinned and verified**: fixed version and SHA-256 fingerprint in the
repository. `scripts/prepare-bins.mjs` rejects an archive that doesn't match — useful even if
the download server is compromised one day, since this binary ends up in the signed installer.

**Only the rclone commands the app uses get through.** The bridge between the interface and
rclone accepts only 16 API methods, and rejects any parameter or path that would make rclone
launch a program (SFTP `ssh` option, on-the-fly `:sftp,…:` remotes, `core/command`…). Even a
future display flaw would not lead to code execution. Covered by tests.

**Each server's identity is verified**, as in FileZilla. On the first connection, Copiteur
shows the fingerprint of the server's key and remembers it if accepted; if it changes later,
an alert is shown before any password is sent. rclone is configured to require the stored key
(`known_hosts_file`): an intruder slipping in between the check and the connection would be
rejected. Tested against a real SSH server.

**Passwords are encrypted** in `serveurs.json` (ChaCha20-Poly1305), with a key stored in the
system keychain — Credential Manager on Windows, Keychain on macOS. A file from an older
version (plaintext passwords) is converted on first launch. On macOS, since the app is not
signed with an Apple developer account, Keychain asks for permission again after each update
("Always Allow").

**The rclone config stays in memory** (`--config ""`): the current server's password is never
written to an `rclone.conf`.

**Strict Content Security Policy (CSP)**: the interface only loads its own files, no external
script or resource.

## Releasing a version

1. Bump the version in `tauri/src-tauri/tauri.conf.json`, `tauri/src-tauri/Cargo.toml` and
   `tauri/package.json`, merge into `main`.
2. Push an **annotated** tag whose message serves as release notes (shown in the app):
   `git tag -a v1.2.0 -m "…notes…" && git push origin v1.2.0`.
3. The *Release* workflow builds Windows + macOS, signs the updates and prepares a **draft**
   release with its `latest.json`. Test the draft's installers, then publish it: publishing is
   what triggers the update in installed apps.

Updates are signed with a private key (repository secrets `TAURI_SIGNING_PRIVATE_KEY` and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`); the public key is in `tauri.conf.json`.
**Losing the private key = no more updates possible** for already-installed apps.

## License

[MIT](LICENSE). rclone is distributed under the MIT license, see
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
