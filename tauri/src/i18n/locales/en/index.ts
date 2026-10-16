import common from "./common";
import app from "./app";
import pane from "./pane";
import files from "./files";
import panels from "./panels";

export const en: Record<keyof typeof import("../fr").fr, string> = { ...common, ...app, ...pane, ...files, ...panels };
