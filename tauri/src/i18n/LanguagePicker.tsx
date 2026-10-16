// ============================================================
//  Copiteur — choix de la langue
// ============================================================
import { useState } from "react";
import { LANGS, languagePickNeeded, languagePicked, setLang, useLang, useT, type Lang } from ".";

// Les langues cote a cote (boutons segmentes). Reglages + premier lancement.
export function LanguageChoice({ value, onChange }: { value: Lang; onChange: (l: Lang) => void }) {
  return (
    <span className="lang-choice" role="radiogroup">
      {LANGS.map((l) => (
        <button
          key={l.id}
          type="button"
          role="radio"
          aria-checked={value === l.id}
          className={"lang-opt" + (value === l.id ? " is-active" : "")}
          onClick={() => onChange(l.id)}
        >
          {l.label}
        </button>
      ))}
    </span>
  );
}

// Premier lancement sans installeur (macOS, ou Windows installe sans choix de
// langue) : on propose la langue, pre-selectionnee sur celle du systeme. Le
// clic l'applique tout de suite, le texte de la fenetre change avec.
export function FirstRunLanguage() {
  const t = useT();
  const lang = useLang();
  const [open, setOpen] = useState(languagePickNeeded);
  if (!open) return null;
  return (
    <div className="modal-backdrop is-top">
      <div className="modal">
        <div className="modal-title">{t("common.welcome.title")}</div>
        <div className="modal-body">{t("common.welcome.body")}</div>
        <div className="lang-welcome">
          <LanguageChoice value={lang} onChange={setLang} />
        </div>
        <div className="modal-actions">
          <button
            className="btn-accent"
            autoFocus
            onClick={() => {
              setLang(lang); // enregistre le choix (meme inchange)
              languagePicked();
              setOpen(false);
            }}
          >
            {t("common.continue")}
          </button>
        </div>
      </div>
    </div>
  );
}
