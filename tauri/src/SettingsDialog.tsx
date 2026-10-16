// ============================================================
//  Copiteur — fenetre parametres (reglages rclone)
// ============================================================
import { useState } from "react";
import { DEFAULT_SETTINGS, type Settings } from "./files";
import { getLang, setLang, tx, useT, type Lang } from "./i18n";
import { LanguageChoice } from "./i18n/LanguagePicker";

function NumberRow({
  label,
  hint,
  value,
  min = 1,
  onChange,
}: {
  label: string;
  hint: string;
  value: number;
  min?: number;
  onChange: (v: number) => void;
}) {
  const t = useT();
  const clamp = (v: number) => Math.max(min, v);
  return (
    <label className="set-row">
      <span className="set-label">
        {label}
        <span className="set-hint">{hint}</span>
      </span>
      {/* Spinner natif masque + fleches custom (pas de carre sombre). */}
      <span className="num-field">
        <input
          className="set-input num-input"
          type="number"
          min={min}
          value={value}
          onChange={(e) => onChange(clamp(Number(e.target.value) || min))}
        />
        <span className="num-steppers">
          <button
            type="button"
            className="num-step"
            tabIndex={-1}
            aria-label={t("panels.set.increase")}
            onClick={() => onChange(value + 1)}
          >
            ▲
          </button>
          <button
            type="button"
            className="num-step"
            tabIndex={-1}
            aria-label={t("panels.set.decrease")}
            onClick={() => onChange(clamp(value - 1))}
          >
            ▼
          </button>
        </span>
      </span>
    </label>
  );
}

function TextRow({
  label,
  hint,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  hint: string;
  value: string;
  placeholder?: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="set-row">
      <span className="set-label">
        {label}
        <span className="set-hint">{hint}</span>
      </span>
      <input
        className="set-input"
        type="text"
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function CheckRow({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="set-row">
      <span className="set-label">
        {label}
        <span className="set-hint">{hint}</span>
      </span>
      <input
        type="checkbox"
        className="set-check"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}

export function SettingsDialog({
  settings,
  appVersion,
  onCheckUpdates,
  onSave,
  onClose,
}: {
  settings: Settings;
  appVersion: string;
  onCheckUpdates: () => void;
  onSave: (s: Settings) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [s, setS] = useState<Settings>(settings);
  // Langue : appliquee a l'enregistrement, comme le reste des reglages.
  const [lang, setLangDraft] = useState<Lang>(getLang);
  const [tab, setTab] = useState<"affichage" | "vitesse" | "connexion" | "maj">(
    "affichage",
  );
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) =>
    setS((prev) => ({ ...prev, [k]: v }));

  // Chaque fichier en cours peut ouvrir jusqu'a `streams` canaux SFTP : au-dela
  // de la concurrence declaree, rclone attend et on perd le benefice.
  const peak = s.parallel * Math.max(s.streams, s.uploadStreams);
  const overloaded = peak > s.sftpConcurrency;

  const TABS = [
    ["affichage", t("panels.set.tab.display")],
    ["vitesse", t("panels.set.tab.speed")],
    ["connexion", t("panels.set.tab.connection")],
    ["maj", t("panels.set.tab.updates")],
  ] as const;

  // Reglages appartenant a chaque onglet : « Réinitialiser » ne touche que
  // l'onglet ouvert, on a donc besoin de la liste par onglet.
  const TAB_KEYS: Record<(typeof TABS)[number][0], (keyof Settings)[]> = {
    affichage: ["showHidden", "showNetworkDrives"],
    vitesse: ["parallel", "streams", "uploadStreams", "cutoff", "chunkSize"],
    connexion: ["sftpConcurrency", "retries", "bwlimit"],
    maj: ["checkUpdates"],
  };
  const tabLabel = TABS.find(([k]) => k === tab)![1];

  // Confirmation avant de reinitialiser (comme une suppression). "tab" = onglet
  // courant, "all" = tous les reglages.
  const [confirm, setConfirm] = useState<null | "tab" | "all">(null);
  const applyReset = () => {
    if (confirm === "all") setS(DEFAULT_SETTINGS);
    else if (confirm === "tab")
      setS((prev) => {
        const next = { ...prev };
        for (const k of TAB_KEYS[tab])
          (next as Record<string, unknown>)[k] = DEFAULT_SETTINGS[k];
        return next;
      });
    setConfirm(null);
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal modal-settings"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-title">{t("panels.set.title")}</div>

        {/* Onglets : le contenu tient sans defiler, les boutons du bas restent
            toujours visibles. */}
        <div className="set-tabs" role="tablist">
          {TABS.map(([key, label]) => (
            <button
              key={key}
              role="tab"
              aria-selected={tab === key}
              className={"set-tab" + (tab === key ? " is-active" : "")}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="set-body">
          {tab === "affichage" && (
            <>
              <div className="set-row">
                <span className="set-label">
                  {t("common.language")}
                  <span className="set-hint">{t("common.languageHint")}</span>
                </span>
                <LanguageChoice value={lang} onChange={setLangDraft} />
              </div>
              <CheckRow
                label={t("panels.set.showHidden")}
                hint={t("panels.set.showHiddenHint")}
                value={s.showHidden}
                onChange={(v) => set("showHidden", v)}
              />
              <CheckRow
                label={t("panels.set.showNetworkDrives")}
                hint={t("panels.set.showNetworkDrivesHint")}
                value={s.showNetworkDrives}
                onChange={(v) => set("showNetworkDrives", v)}
              />
            </>
          )}

          {tab === "vitesse" && (
            <>
              <NumberRow
                label={t("panels.set.parallel")}
                hint={t("panels.set.parallelHint")}
                value={s.parallel}
                onChange={(v) => set("parallel", v)}
              />
              <NumberRow
                label={t("panels.set.streams")}
                hint={t("panels.set.streamsHint")}
                value={s.streams}
                onChange={(v) => set("streams", v)}
              />
              <NumberRow
                label={t("panels.set.uploadStreams")}
                hint={t("panels.set.uploadStreamsHint")}
                value={s.uploadStreams}
                onChange={(v) => set("uploadStreams", v)}
              />
              <TextRow
                label={t("panels.set.cutoff")}
                hint={t("panels.set.cutoffHint")}
                value={s.cutoff}
                onChange={(v) => set("cutoff", v)}
              />
              <TextRow
                label={t("panels.set.chunkSize")}
                hint={t("panels.set.chunkSizeHint")}
                value={s.chunkSize}
                onChange={(v) => set("chunkSize", v)}
              />
              <div className={"set-note" + (overloaded ? " is-warn" : "")}>
                {overloaded
                  ? t("panels.set.peakOver", { peak, max: s.sftpConcurrency })
                  : t("panels.set.peak", { peak, max: s.sftpConcurrency })}
              </div>
            </>
          )}

          {tab === "connexion" && (
            <>
              <NumberRow
                label={t("panels.set.sftpConcurrency")}
                hint={t("panels.set.sftpConcurrencyHint")}
                value={s.sftpConcurrency}
                onChange={(v) => set("sftpConcurrency", v)}
              />
              <NumberRow
                label={t("panels.set.retries")}
                hint={t("panels.set.retriesHint")}
                value={s.retries}
                min={0}
                onChange={(v) => set("retries", v)}
              />
              <TextRow
                label={t("panels.set.bwlimit")}
                hint={t("panels.set.bwlimitHint")}
                value={s.bwlimit}
                placeholder={t("panels.set.unlimited")}
                onChange={(v) => set("bwlimit", v)}
              />
            </>
          )}

          {tab === "maj" && (
            <>
              <div className="set-row">
                <span className="set-label">
                  Copiteur {appVersion}
                  <span className="set-hint">{t("panels.set.signedHint")}</span>
                </span>
                <button className="btn-ghost" onClick={onCheckUpdates}>
                  {t("panels.set.checkNow")}
                </button>
              </div>
              <CheckRow
                label={t("panels.set.checkUpdates")}
                hint={t("panels.set.checkUpdatesHint")}
                value={s.checkUpdates}
                onChange={(v) => set("checkUpdates", v)}
              />
            </>
          )}
        </div>

        <div className="modal-actions modal-actions-split">
          <div className="set-reset-group">
            <button
              className="link-btn"
              onClick={() => setConfirm("tab")}
              title={t("panels.set.resetTabTitle", { tab: tabLabel })}
            >
              {t("panels.set.reset")}
            </button>
            <button
              className="link-btn"
              onClick={() => setConfirm("all")}
              title={t("panels.set.resetAllTitle")}
            >
              {t("panels.set.resetAll")}
            </button>
          </div>
          <div className="modal-actions">
            <button className="btn-ghost" onClick={onClose}>
              {t("common.cancel")}
            </button>
            <button
              className="btn-accent"
              onClick={() => {
                if (lang !== getLang()) setLang(lang);
                onSave(s);
                onClose();
              }}
            >
              {t("common.save")}
            </button>
          </div>
        </div>
      </div>

      {/* Confirmation par-dessus le menu (is-top -> passe DEVANT, pas derriere). */}
      {confirm && (
        <div
          className="modal-backdrop is-top"
          onMouseDown={(e) => {
            e.stopPropagation();
            setConfirm(null);
          }}
        >
          <div
            className="modal modal-confirm"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="modal-title">{t("panels.set.confirmTitle")}</div>
            <div className="modal-body">
              {confirm === "all"
                ? tx("panels.set.confirmAll", {
                    all: <strong>{t("panels.set.confirmAllStrong")}</strong>,
                  })
                : tx("panels.set.confirmTab", {
                    tab: <strong>{t("panels.set.quotedTab", { tab: tabLabel })}</strong>,
                  })}
            </div>
            <div className="modal-actions">
              <button className="btn-ghost" onClick={() => setConfirm(null)}>
                {t("panels.set.no")}
              </button>
              <button className="btn-accent" onClick={applyReset}>
                {t("panels.set.yesReset")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
