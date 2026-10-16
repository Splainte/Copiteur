// English texts — « files » namespace. Same keys as ../fr/files.ts.
import type fr from "../fr/files";

export default {
  "files.type.folder": "File folder",
  "files.type.ext": "{ext} file",
  "files.type.file": "File",

  "files.untitled": "untitled",

  "files.name.empty": "The name can't be empty.",
  "files.name.badChars": "A name can't contain {chars}",
  "files.name.reserved": "Reserved name.",

  "files.err.hostKeyMismatch":
    "The server's identity doesn't match the one on record: connection refused for security. Reconnect to see the fingerprint it presented.",
  "files.err.macLocalNetwork":
    "Server unreachable from this Mac: check that the VPN is connected and that the server (or its VPN) is running. If the server responds otherwise, macOS may be blocking Copiteur: System Settings > Privacy & Security > Local Network, turn on Copiteur.",
  "files.err.hostKeyUnverified":
    "Server identity not verified: reconnect and accept its fingerprint.",
  "files.err.tooManyAuth":
    "Too many authentication attempts, the server closed the connection. Try again in a moment (often the SSH agent offering keys before the password).",
  "files.err.badLogin":
    "Username or password rejected by the server. Also check the username's case (\"Alice\" ≠ \"alice\").",
  "files.err.unreachable":
    "Server unreachable: check the address and port, and that the server is on and reachable.",

  "files.servers.placeholder": "Saved servers…",
  "files.servers.empty": "No saved servers",
  "files.servers.rename": "Rename this server",
  "files.servers.forget": "Forget this server",
} satisfies Record<keyof typeof fr, string>;
