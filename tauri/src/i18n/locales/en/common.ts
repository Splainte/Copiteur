// English shared texts. Same keys as ../fr/common.ts.
import type fr from "../fr/common";

export default {
  "common.cancel": "Cancel",
  "common.ok": "OK",
  "common.close": "Close",
  "common.save": "Save",
  "common.delete": "Delete",
  "common.rename": "Rename",
  "common.retry": "Retry",
  "common.continue": "Continue",
  "common.yourPc": "Your computer",
  "common.server": "Server",

  "common.unit.b": "B",
  "common.unit.kb": "KB",
  "common.unit.mb": "MB",
  "common.unit.gb": "GB",
  "common.unit.tb": "TB",
  "common.perSecond": "{size}/s",

  "common.language": "Language",
  "common.languageHint": "Interface language",
  "common.welcome.title": "Welcome to Copiteur",
  "common.welcome.body": "Choose the interface language. You can change it later in the settings.",
} satisfies Record<keyof typeof fr, string>;
