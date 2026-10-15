// ============================================================
//  Copiteur — menu deroulant des serveurs memorises (look Robloader)
// ============================================================
import { useEffect, useRef, useState } from "react";
import { UiIcon } from "./icons";
import type { Server } from "./files";

export function ServersDropdown({
  servers,
  onPick,
  onDelete,
  onRename,
}: {
  servers: Server[];
  onPick: (s: Server) => void;
  onDelete: (label: string) => void;
  onRename: (oldLabel: string, newLabel: string) => void;
}) {
  const [open, setOpen] = useState(false);
  // Label du serveur en cours de renommage (inline), + valeur saisie. On edite
  // DANS le menu plutot qu'avec une boite de dialogue native (window.prompt
  // bloquerait la webview Tauri).
  const [editing, setEditing] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  // Annuler (Echap) ou valider (Entree) demonte le champ, ce qui declenche un
  // `blur` : ce drapeau evite que ce blur re-valide dans la foulee.
  const skipCommit = useRef(false);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    // pointerdown (et non mousedown) : le lasso des volets fait preventDefault
    // sur le pointerdown, ce qui supprimerait le mousedown de compatibilite —
    // le menu ne se fermerait alors pas en cliquant dans un volet fichiers.
    document.addEventListener("pointerdown", onDoc, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDoc, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Fermer le menu remet aussi fin a toute edition en cours.
  useEffect(() => {
    if (!open) setEditing(null);
  }, [open]);

  const startEdit = (label: string) => {
    setEditing(label);
    setEditValue(label);
  };
  const commitEdit = () => {
    if (editing !== null) {
      // Champ vidé puis validé : on revient au nom PAR DEFAUT « user@host »
      // (au lieu de garder l'ancien nom sans rien changer).
      const srv = servers.find((x) => x.label === editing);
      const fallback = srv ? `${srv.user}@${srv.host}` : editing;
      const v = editValue.trim() || fallback;
      if (v !== editing) onRename(editing, v);
    }
    setEditing(null);
  };

  return (
    <div className={"select" + (open ? " is-open" : "")} ref={ref}>
      <button
        type="button"
        className="select__trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="select__value is-placeholder">Serveurs mémorisés…</span>
        <span className="select__chevron">
          <UiIcon name="caret" />
        </span>
      </button>
      {open && (
        <div className="select__menu" role="listbox">
          {servers.length === 0 ? (
            <div className="select__empty">Aucun serveur mémorisé</div>
          ) : (
            servers.map((s) =>
              editing === s.label ? (
                // Ligne en cours de renommage : champ a la place du libelle.
                <div key={s.label} className="select__option is-editing">
                  <input
                    className="select__rename"
                    autoFocus
                    value={editValue}
                    spellCheck={false}
                    onChange={(e) => setEditValue(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onPointerDown={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      // Cmd/Ctrl+A : selectionner tout le nom. On le fait
                      // explicitement, sinon le « Tout selectionner » natif de la
                      // webview (menu Edition) reprend la main et ne cible pas ce
                      // champ.
                      if ((e.metaKey || e.ctrlKey) && (e.key === "a" || e.key === "A")) {
                        e.preventDefault();
                        e.currentTarget.select();
                      } else if (e.key === "Enter") {
                        skipCommit.current = true;
                        commitEdit();
                      } else if (e.key === "Escape") {
                        skipCommit.current = true;
                        setEditing(null);
                      }
                    }}
                    onBlur={() => {
                      if (skipCommit.current) {
                        skipCommit.current = false;
                        return;
                      }
                      commitEdit();
                    }}
                  />
                </div>
              ) : (
                <button
                  type="button"
                  key={s.label}
                  role="option"
                  className="select__option"
                  onClick={() => {
                    onPick(s);
                    setOpen(false);
                  }}
                >
                  <span className="select__option-label">{s.label}</span>
                  <span
                    className="select__option-rename"
                    title="Renommer ce serveur"
                    onClick={(e) => {
                      e.stopPropagation();
                      startEdit(s.label);
                    }}
                  >
                    ✎
                  </span>
                  <span
                    className="select__option-del"
                    title="Oublier ce serveur"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(s.label);
                    }}
                  >
                    ✕
                  </span>
                </button>
              ),
            )
          )}
        </div>
      )}
    </div>
  );
}
