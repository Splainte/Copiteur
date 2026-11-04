// English texts — « app » namespace. Same keys as ../fr/app.ts.
import type fr from "../fr/app";

export default {
  "app.win.minimize": "Minimize",
  "app.win.maximize": "Maximize",
  "app.win.close": "Close",

  "app.conn.name": "Name (optional)",
  "app.conn.host": "Host",
  "app.conn.user": "User",
  "app.conn.password": "Password",
  "app.conn.port": "Port",
  "app.conn.connect": "Connect",
  "app.conn.connecting": "Connecting…",
  "app.conn.journal": "Log",
  "app.conn.journalTitle": "Log (diagnostics)",
  "app.conn.settings": "Settings",
  "app.conn.hostKeyRefused": "Connection cancelled: server identity not accepted.",
  "app.conn.timeout": "The server is not responding (timed out).",

  "app.rclone.unreachable": "rclone unreachable",

  "app.err.nameRefused": "Name rejected by the destination (“{name}”) — {err}",
  "app.err.hashRetry":
    "The server could not provide a verifiable checksum — retrying without checksum verification. ({err})",
  "app.err.streamFallback":
    "The server refused {from} simultaneous upload connections — retrying with {to}. ({err})",
  "app.err.downFallback":
    "The connection couldn't keep up with {from} download streams — retrying with {to}. ({err})",

  "app.conflict.title": "File already exists",
  "app.conflict.body": "“{name}” already exists in the destination folder. What do you want to do?",
  "app.conflict.applyAll": "Apply to all files in this copy",
  "app.conflict.skip": "Skip",
  "app.conflict.replace": "Replace",

  "app.rename.title": "Name rejected by the destination",
  "app.rename.body":
    "“{name}” could not be copied: the destination does not accept some characters in this name ({chars}).",
  "app.rename.ask": "Copy it as “{name}”?",
  "app.rename.applyAll": "Apply to other rejected names in this copy",
  "app.rename.drop": "Skip it",
  "app.rename.confirm": "Rename and copy",

  "app.close.titleXfers": "Transfers in progress",
  "app.close.titleEdits": "Edits not sent back",
  "app.close.xfers_one": "{n} transfer in progress or queued.",
  "app.close.xfers_other": "{n} transfers in progress or queued.",
  "app.close.edits_one": "{n} edited file not yet sent back to the server.",
  "app.close.edits_other": "{n} edited files not yet sent back to the server.",
  "app.close.lose": "Closing now will lose these changes.",
  "app.close.force": "Close anyway",

  "app.hostkey.titleChanged": "Warning: the server's identity has changed",
  "app.hostkey.titleNew": "First connection to this server",
  "app.hostkey.changedBody":
    "The key presented by {server} does not match the one on record. This is normal after the server is reinstalled or upgraded, but it may also mean someone is impersonating it to intercept your password.",
  "app.hostkey.stored": "Stored fingerprint",
  "app.hostkey.presented": "Presented fingerprint",
  "app.hostkey.changedHint":
    "If in doubt, cancel and check with whoever manages the server.",
  "app.hostkey.newBody": "Copiteur does not know {server} yet. Here is the fingerprint of its identity key:",
  "app.hostkey.newHint":
    "If you can, compare it with the one given by whoever manages the server. Copiteur remembers it and will warn you if it ever changes.",
  "app.hostkey.trustNew": "Trust the new key",
  "app.hostkey.trust": "Trust and connect",

  "app.dmg.title": "Install Copiteur?",
  "app.dmg.body":
    "Copiteur is currently running from its disk image ({mount}), not from the Applications folder. Moving it keeps the image from showing up as a volume in the left pane, and ejects it automatically.",
  "app.dmg.stay": "Keep running from here",
  "app.dmg.moving": "Moving…",
  "app.dmg.move": "Move to Applications",

  "app.edit.title": "File modified",
  "app.edit.body": "“{name}” has been modified. Send it back to the server?",
  "app.edit.ignore": "Ignore",
  "app.edit.resend": "Send back",
  "app.editConflict.title": "Conflict on the server",
  "app.editConflict.deleted":
    "“{name}” no longer exists on the server (deleted or moved since you opened it). Sending it back will recreate it.",
  "app.editConflict.changed":
    "“{name}” has been modified on the server since you opened it. Sending it back {overwrite} the server's version.",
  "app.editConflict.overwriteWord": "will overwrite",
  "app.editConflict.overwrite": "Overwrite",

  "app.bar.etaSec": " · {s} s",
  "app.bar.etaMin": " · {m} min",

  "app.log.rcloneRestarted": "The rclone engine was restarted (it had stopped)",
  "app.log.hostKeyRefused": "Connection to {host} cancelled — {kind} fingerprint rejected ({fp})",
  "app.log.kindChanged": "CHANGED",
  "app.log.kindNew": "new",
  "app.log.keyAccepted": "New key accepted for {host}: {algo} {fp}",
  "app.log.keyStored": "Key stored for {host}: {algo} {fp}",
  "app.log.connected": "Connected to {target}",
  "app.log.connFailed": "Connection to {target} failed — {err}",
  "app.log.queued_one": "Queued: {n} item → {dest} {dir}",
  "app.log.queued_other": "Queued: {n} items → {dest} {dir}",
  "app.log.openFailed": "Could not open: {name} — {err}",
  "app.log.editStarted": "Editing started: {name}",
  "app.log.noHash":
    "This server cannot compute checksums: checksum verification disabled (size is still checked). Failed transfers are being retried.",
  "app.log.renamedForCopy": "Renamed for copy: {from} → {to}",
  "app.log.opened": "Opening: {name}",
  "app.log.resent": "Sent back after editing: {name}",
  "app.log.retry": "Connection dropped, auto-resume (attempt {n}): {label} — {err}",
  "app.log.failed": "Failed: {label} — {err}",
  "app.log.cancelled": "Cancelled: {label}",
  "app.log.batchDone": "Batch finished: {done}, {failed}, {cancelled}",
  "app.log.batchOk_one": "{n} succeeded",
  "app.log.batchOk_other": "{n} succeeded",
  "app.log.batchFail_one": "{n} failed",
  "app.log.batchFail_other": "{n} failed",
  "app.log.batchCancel_one": "{n} cancelled",
  "app.log.batchCancel_other": "{n} cancelled",
  "app.log.moveFailed": "Could not move to Applications: {err}",

// Pane sources (picker at the top of each pane).
  "app.src.pick": "Choose a source",
  "app.src.pickHint": "Choose what this pane shows with the menu at the top left: your computer, a phone or a server.",
  "app.src.thisMac": "This Mac",
  "app.src.thisPc": "This computer",
  "app.src.phones": "Phones",
  "app.src.noPhone": "No phone. Plugged in? Unlock it and choose “File transfer”.",
  "app.src.servers": "Servers",
  "app.src.connected": "connected",
  "app.src.addServer": "Add a server…",
  "app.src.editServer": "Edit this server…",
  "app.src.renameServer": "Rename this server…",
  "app.src.menuTitle": "Choose what this pane shows",
  "app.src.connecting": "Connecting to {name}…",
  "app.src.notConnected": "{name} is not connected.",
  "app.src.serverGone": "The server “{name}” is no longer saved. Choose another source.",

  // Android phones (macOS).
  "app.phone.generic": "Phone",
  "app.phone.usb": "USB",
  "app.phone.stateLocked": "locked",
  "app.phone.stateBusy": "busy",
  "app.phone.stateError": "error",
  "app.phone.unplugged": "{name} is unplugged. Plug it back in to continue.",
  "app.phone.connecting": "Connecting to {name}…",
  "app.phone.locked": "Unlock {name}, then choose “File transfer” in the phone's USB notification.",
  "app.phone.busy": "{name} is already used by another program (OpenMTP, Android File Transfer, Image Capture…). Quit it, then try again.",
  "app.phone.error": "Cannot read {name}: {err}",
  "app.phone.errorUnknown": "Cannot read {name}. Unplug it and plug it back in.",
  "app.phone.bannerReady": "plugged in over USB · {used} used",
  "app.phone.bannerLocked": "plugged in: unlock it and choose “File transfer”",
  "app.phone.bannerBusy": "plugged in, but used by another program",
  "app.phone.bannerOther": "plugged in over USB",
  "app.phone.openLeft": "Open on the left",
  "app.phone.openRight": "Open on the right",

  // Copy safeguards (same source on both sides).
  "app.notice.sameFolder": "Source and destination are the same folder: nothing to copy.",
  "app.notice.intoItself": "A folder cannot be copied into itself: it was skipped.",
  "app.notice.nameTaken": "A server is already called “{name}”.",
  "app.notice.renameWait": "Connecting: rename this server once it is connected.",

  "app.log.disconnected": "Disconnected from {name}",
  "app.log.phonePlugged": "Phone plugged in: {name}",
  "app.log.phoneUnplugged": "Phone unplugged: {name}",
} satisfies Record<keyof typeof fr, string>;
