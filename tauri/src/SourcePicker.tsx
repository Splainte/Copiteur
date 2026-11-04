// ============================================================
//  Copiteur — selecteur de source d'un panneau
//
//  Le titre de chaque panneau est un bouton : il ouvre un menu qui liste ce
//  que le panneau peut afficher (l'ordinateur, les telephones branches, les
//  serveurs memorises) et, pour un serveur, ses actions (modifier, renommer,
//  oublier, se deconnecter). Meme composant sous macOS et Windows ; seul le
//  style change (cf. chrome.css).
//
//  Le menu est rendu DANS le panneau (position fixe) : un clic dedans reste
//  donc un clic « dans le panneau » pour la deselection globale d'App.
// ============================================================
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { UiIcon } from "./icons";
import { t, useLang } from "./i18n";

type IconName = "computer" | "server" | "phone" | "plus";

export type SourceMenuItem =
  | { type: "header"; text: string }
  | { type: "note"; text: string }
  | { type: "sep" }
  | {
      type: "item";
      id: string;
      text: string;
      icon?: IconName;
      // Precision discrete a droite (« connecté », « USB », « verrouillé »).
      detail?: string;
      checked?: boolean;
      disabled?: boolean;
    };

export function SourcePicker({
  icon,
  label,
  busy,
  items,
  onPick,
}: {
  icon: IconName | null;
  label: string;
  // Connexion en cours : petit rouleau a la place de l'icone.
  busy: boolean;
  items: SourceMenuItem[];
  onPick: (id: string) => void;
}) {
  useLang();
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // Point d'ancrage du menu (sous le bouton), puis position recadree pour
  // tenir dans la fenetre une fois sa taille connue.
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number } | null>(null);

  const close = (refocus = false) => {
    setAnchor(null);
    setPos(null);
    if (refocus) btnRef.current?.focus();
  };
  const toggle = () => {
    if (anchor) return close();
    const r = btnRef.current!.getBoundingClientRect();
    setAnchor({ x: r.left, y: r.bottom + 4 });
  };

  useLayoutEffect(() => {
    if (!anchor) return;
    const el = menuRef.current;
    if (!el) return;
    const pad = 8;
    const r = el.getBoundingClientRect();
    const maxHeight = window.innerHeight - anchor.y - pad;
    // Trop haut pour tenir sous le bouton : on le remonte (sans passer sous le
    // haut de la fenetre) et il defile s'il le faut.
    const top = r.height > maxHeight ? Math.max(pad, window.innerHeight - r.height - pad) : anchor.y;
    const left = Math.max(pad, Math.min(anchor.x, window.innerWidth - r.width - pad));
    setPos({ left, top, maxHeight: window.innerHeight - top - pad });
    // Focus sur l'entree cochee (ou la premiere) : le clavier marche aussitot.
    const first =
      el.querySelector<HTMLButtonElement>(".src-item.is-checked:not(:disabled)") ??
      el.querySelector<HTMLButtonElement>(".src-item:not(:disabled)");
    first?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor]);

  // Fermeture : clic ailleurs (y compris l'autre panneau), fenetre qui perd le
  // focus, redimensionnement, defilement hors du menu.
  useEffect(() => {
    if (!anchor) return;
    const onDown = (e: Event) => {
      const el = e.target as Node;
      if (menuRef.current?.contains(el) || btnRef.current?.contains(el)) return;
      close();
    };
    const onScroll = (e: Event) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      close();
    };
    const onBlur = () => close();
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onBlur);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onBlur);
      window.removeEventListener("blur", onBlur);
    };
  }, [anchor]);

  // Clavier : fleches pour parcourir, Echap pour fermer. Rien ne doit remonter
  // au panneau, dont les raccourcis (Entree = ouvrir, Retour arriere =
  // remonter, fleches = selection) agiraient sinon sur les fichiers.
  const onMenuKey = (e: ReactKeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      close(true);
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const list = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(".src-item:not(:disabled)") ?? [],
    );
    if (!list.length) return;
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? list.length - 1
          : e.key === "ArrowDown"
            ? (i + 1) % list.length
            : (i - 1 + list.length) % list.length;
    list[next].focus();
  };

  return (
    <span className="src-picker" onKeyDown={(e) => e.stopPropagation()}>
      <button
        ref={btnRef}
        type="button"
        className={"src-btn" + (anchor ? " is-open" : "") + (icon ? "" : " is-empty")}
        title={t("app.src.menuTitle")}
        aria-haspopup="menu"
        aria-expanded={!!anchor}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !anchor) {
            e.preventDefault();
            toggle();
          }
        }}
      >
        <span className="src-btn-icon">
          {busy ? <span className="ctx-spinner" /> : icon ? <UiIcon name={icon} /> : <UiIcon name="plus" />}
        </span>
        <span className="src-btn-label">{label}</span>
        <span className="src-btn-caret">
          <UiIcon name="caret" />
        </span>
      </button>
      {anchor && (
        <div
          ref={menuRef}
          className="ctx-menu src-menu"
          role="menu"
          style={{
            left: pos?.left ?? anchor.x,
            top: pos?.top ?? anchor.y,
            maxHeight: pos?.maxHeight,
            visibility: pos ? "visible" : "hidden",
          }}
          onKeyDown={onMenuKey}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          {items.map((it, i) => {
            if (it.type === "sep") return <div key={i} className="ctx-sep" />;
            if (it.type === "header")
              return (
                <div key={i} className="src-head">
                  {it.text}
                </div>
              );
            if (it.type === "note")
              return (
                <div key={i} className="src-note">
                  {it.text}
                </div>
              );
            return (
              <button
                key={it.id}
                type="button"
                role="menuitemradio"
                aria-checked={!!it.checked}
                className={"ctx-item src-item" + (it.checked ? " is-checked" : "")}
                disabled={it.disabled}
                onClick={() => {
                  close();
                  onPick(it.id);
                }}
              >
                <span className="src-check" aria-hidden>
                  {it.checked ? "✓" : ""}
                </span>
                <span className="src-icon" aria-hidden>
                  {it.icon && <UiIcon name={it.icon} />}
                </span>
                <span className="src-text">{it.text}</span>
                {it.detail && <span className="src-detail">{it.detail}</span>}
              </button>
            );
          })}
        </div>
      )}
    </span>
  );
}
