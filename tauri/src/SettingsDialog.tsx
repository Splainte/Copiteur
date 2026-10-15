// ============================================================
//  Copiteur — fenetre parametres (reglages rclone)
// ============================================================
import { useState } from "react";
import { DEFAULT_SETTINGS, type Settings } from "./files";

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
            aria-label="Augmenter"
            onClick={() => onChange(value + 1)}
          >
            ▲
          </button>
          <button
            type="button"
            className="num-step"
            tabIndex={-1}
            aria-label="Diminuer"
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
  onSave,
  onClose,
}: {
  settings: Settings;
  onSave: (s: Settings) => void;
  onClose: () => void;
}) {
  const [s, setS] = useState<Settings>(settings);
  const [tab, setTab] = useState<"affichage" | "vitesse" | "connexion">(
    "affichage",
  );
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) =>
    setS((prev) => ({ ...prev, [k]: v }));

  // Chaque fichier en cours peut ouvrir jusqu'a `streams` canaux SFTP : au-dela
  // de la concurrence declaree, rclone attend et on perd le benefice.
  const peak = s.parallel * Math.max(s.streams, s.uploadStreams);
  const overloaded = peak > s.sftpConcurrency;

  const TABS = [
    ["affichage", "Affichage"],
    ["vitesse", "Vitesse"],
    ["connexion", "Connexion"],
  ] as const;

  // Reglages appartenant a chaque onglet : « Réinitialiser » ne touche que
  // l'onglet ouvert, on a donc besoin de la liste par onglet.
  const TAB_KEYS: Record<(typeof TABS)[number][0], (keyof Settings)[]> = {
    affichage: ["showHidden", "showNetworkDrives"],
    vitesse: ["parallel", "streams", "uploadStreams", "cutoff", "chunkSize"],
    connexion: ["sftpConcurrency", "retries", "bwlimit"],
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
        <div className="modal-title">Paramètres</div>

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
              <CheckRow
                label="Afficher les fichiers et dossiers cachés"
                hint="Comme dans l'explorateur : masqués par défaut (noms commençant par un point, éléments marqués « caché » par Windows, dossiers système du NAS)."
                value={s.showHidden}
                onChange={(v) => set("showHidden", v)}
              />
              <CheckRow
                label="Afficher les lecteurs réseau / volumes distants"
                hint="Masqués par défaut dans le volet de navigation local, pour éviter de mélanger par erreur une copie SFTP vers un NAS avec ce même NAS monté en lecteur réseau (SMB…)."
                value={s.showNetworkDrives}
                onChange={(v) => set("showNetworkDrives", v)}
              />
            </>
          )}

          {tab === "vitesse" && (
            <>
              <NumberRow
                label="Transferts simultanés"
                hint="Nombre de fichiers copiés en même temps."
                value={s.parallel}
                onChange={(v) => set("parallel", v)}
              />
              <NumberRow
                label="Découpe des gros fichiers (téléchargement)"
                hint="Un gros fichier téléchargé est découpé en N flux parallèles : c'est ce qui casse le plafond de ~11 Mo/s par connexion."
                value={s.streams}
                onChange={(v) => set("streams", v)}
              />
              <NumberRow
                label="Découpe des gros fichiers (envoi)"
                hint="Idem à la montée (vers le serveur). Si le serveur refuse autant de connexions simultanées, le transfert réessaie tout seul avec moins de flux (jusqu'à une seule connexion), donc on peut viser haut."
                value={s.uploadStreams}
                onChange={(v) => set("uploadStreams", v)}
              />
              <TextRow
                label="Seuil de découpe"
                hint="Taille à partir de laquelle un fichier est découpé, ex. 256M."
                value={s.cutoff}
                onChange={(v) => set("cutoff", v)}
              />
              <TextRow
                label="Taille des morceaux"
                hint="Taille de chaque morceau, ex. 128M."
                value={s.chunkSize}
                onChange={(v) => set("chunkSize", v)}
              />
              <div className={"set-note" + (overloaded ? " is-warn" : "")}>
                {overloaded
                  ? `Jusqu'à ${peak} canaux SFTP demandés en pointe, au-delà de la limite de ${s.sftpConcurrency} : baisse les transferts simultanés ou la découpe, ou augmente les connexions SFTP.`
                  : `Jusqu'à ${peak} canaux SFTP en pointe (limite : ${s.sftpConcurrency}).`}
              </div>
            </>
          )}

          {tab === "connexion" && (
            <>
              <NumberRow
                label="Connexions SFTP"
                hint="Requêtes SFTP simultanées. Appliqué à la prochaine connexion."
                value={s.sftpConcurrency}
                onChange={(v) => set("sftpConcurrency", v)}
              />
              <NumberRow
                label="Tentatives de reprise"
                hint="Reprises automatiques après une coupure (4G, tunnel, veille). 0 = sans limite."
                value={s.retries}
                min={0}
                onChange={(v) => set("retries", v)}
              />
              <TextRow
                label="Limite de débit"
                hint="Bride la vitesse, ex. 10M. Vide = illimité."
                value={s.bwlimit}
                placeholder="illimité"
                onChange={(v) => set("bwlimit", v)}
              />
            </>
          )}
        </div>

        <div className="modal-actions modal-actions-split">
          <div className="set-reset-group">
            <button
              className="link-btn"
              onClick={() => setConfirm("tab")}
              title={`Restaurer les valeurs par défaut de l'onglet « ${tabLabel} »`}
            >
              Réinitialiser
            </button>
            <button
              className="link-btn"
              onClick={() => setConfirm("all")}
              title="Restaurer TOUS les réglages aux valeurs par défaut"
            >
              Réinitialiser tout
            </button>
          </div>
          <div className="modal-actions">
            <button className="btn-ghost" onClick={onClose}>
              Annuler
            </button>
            <button
              className="btn-accent"
              onClick={() => {
                onSave(s);
                onClose();
              }}
            >
              Enregistrer
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
            <div className="modal-title">Confirmation requise</div>
            <div className="modal-body">
              {confirm === "all" ? (
                <>
                  Réinitialiser <strong>tous les réglages</strong> à leurs
                  valeurs par défaut ?
                </>
              ) : (
                <>
                  Réinitialiser les réglages de l'onglet{" "}
                  <strong>« {tabLabel} »</strong> à leurs valeurs par défaut ?
                </>
              )}
            </div>
            <div className="modal-actions">
              <button className="btn-ghost" onClick={() => setConfirm(null)}>
                Non
              </button>
              <button className="btn-accent" onClick={applyReset}>
                Oui, réinitialiser
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
