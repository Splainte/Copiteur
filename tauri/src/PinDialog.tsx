// ============================================================
//  Copiteur — demande du code PIN d'un serveur protege
//
//  Le mot de passe d'un serveur protege n'arrive au front qu'apres le bon code
//  (`unlock_server`, cf. engine.rs) : cette boite le demande, puis passe le mot
//  de passe (et le code, pour pre-remplir la feuille « Modifier ») a l'appelant.
//  Les mauvais codes sont comptes cote backend, sur le disque : apres plusieurs
//  echecs, il faut patienter avant de reessayer.
// ============================================================
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { t, tn, useLang } from "./i18n";

type PinError = { kind?: "wrong" | "wait" | "other"; left?: number; secs?: number; msg?: string };

const fmtWait = (secs: number) =>
  secs < 90 ? t("app.pin.secs", { n: secs }) : t("app.pin.mins", { n: Math.ceil(secs / 60) });

export function PinDialog({
  label,
  onCancel,
  onOk,
}: {
  label: string;
  onCancel: () => void;
  onOk: (pass: string, pin: string) => void;
}) {
  useLang();
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // Le champ, desactive pendant la verification, perd le focus : on le lui
  // rend pour retaper le code sans clic.
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!busy) field.current?.focus();
  }, [busy]);
  const submit = async () => {
    if (busy || pin.length < 4) return;
    setBusy(true);
    setErr("");
    try {
      const pass = await invoke<string>("unlock_server", { label, pin });
      onOk(pass, pin);
    } catch (e) {
      const r = (typeof e === "object" && e ? e : { msg: String(e) }) as PinError;
      setErr(
        r.kind === "wrong"
          ? r.left
            ? tn("app.pin.wrong", r.left)
            : t("app.pin.wrongLast")
          : r.kind === "wait"
            ? t("app.pin.wait", { time: fmtWait(r.secs ?? 30) })
            : (r.msg ?? String(e)),
      );
      setPin("");
      setBusy(false);
    }
  };
  return (
    <div className="modal-backdrop">
      <div
        className="modal modal-pin"
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          else if (e.key === "Escape") onCancel();
        }}
      >
        <div className="modal-title">{t("app.pin.title")}</div>
        <div className="modal-body">
          {t("app.pin.body", { name: label })}
          <input
            ref={field}
            className="sheet-field pin-field"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            maxLength={8}
            value={pin}
            disabled={busy}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
            aria-label={t("app.pin.title")}
          />
          {err && <div className="sheet-error">{err}</div>}
        </div>
        <div className="modal-actions">
          <button className="btn-ghost" onClick={onCancel}>
            {t("common.cancel")}
          </button>
          <button className="btn-accent" disabled={busy || pin.length < 4} onClick={submit}>
            {busy ? t("app.pin.checking") : t("app.pin.unlock")}
          </button>
        </div>
      </div>
    </div>
  );
}
