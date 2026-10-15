// ============================================================
//  Copiteur — icones SVG embarquees (types de fichiers + UI)
// ============================================================
import type { ReactNode } from "react";
import type { IconKind } from "./files";

// ---- Icone de type de fichier ---------------------------------------------
// Taille pilotee par le conteneur (width/height 100% => l'appelant fixe la box).
export function FileIcon({ kind }: { kind: IconKind }) {
  switch (kind) {
    // Les deux teintes viennent de variables CSS : jaune sur Windows/Linux,
    // derivees de la couleur d'accent systeme sur macOS (comme le Finder).
    case "folder":
      return (
        <svg viewBox="0 0 48 48" className="ficon" aria-hidden>
          <path
            d="M5 12h13l4 4h21a3 3 0 0 1 3 3v20a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V15a3 3 0 0 1 3-3z"
            fill="var(--cp-folder-back)"
          />
          <path
            d="M5 18h38a3 3 0 0 1 3 3v18a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V21a3 3 0 0 1 3-3z"
            fill="var(--cp-folder-front)"
          />
        </svg>
      );
    case "video":
      return (
        <FileBadge tint="#3aa0ff">
          <rect x="14" y="18" width="20" height="16" rx="2" fill="#fff" />
          <path d="M22 22.5v7l6-3.5-6-3.5z" fill="#3aa0ff" />
        </FileBadge>
      );
    case "image":
      return (
        <FileBadge tint="#39b36e">
          <rect x="14" y="19" width="20" height="14" rx="2" fill="#fff" />
          <circle cx="19" cy="24" r="2" fill="#39b36e" />
          <path d="M15 32l6-6 4 4 5-5 4 4v3H15z" fill="#39b36e" />
        </FileBadge>
      );
    case "audio":
      return (
        <FileBadge tint="#c56cf0">
          <path
            d="M27 18v9.5a4 4 0 1 1-2-3.46V20l-6 1.4V30a4 4 0 1 1-2-3.46V19l10-2.3z"
            fill="#fff"
          />
        </FileBadge>
      );
    case "archive":
      return (
        <FileBadge tint="#b0902f">
          <rect x="21" y="16" width="6" height="20" rx="1" fill="#fff" />
          <rect x="22.5" y="18" width="3" height="2" fill="#b0902f" />
          <rect x="22.5" y="22" width="3" height="2" fill="#b0902f" />
          <rect x="22.5" y="26" width="3" height="2" fill="#b0902f" />
        </FileBadge>
      );
    case "doc":
      return (
        <FileBadge tint="#e8534f">
          <rect x="17" y="18" width="14" height="2" fill="#fff" />
          <rect x="17" y="22" width="14" height="2" fill="#fff" />
          <rect x="17" y="26" width="10" height="2" fill="#fff" />
        </FileBadge>
      );
    case "premiere":
      return <AdobeBadge letters="Pr" bg="#00005b" fg="#9999ff" />;
    case "aftereffects":
      return <AdobeBadge letters="Ae" bg="#00005b" fg="#9999ff" />;
    default:
      return (
        <svg viewBox="0 0 48 48" className="ficon" aria-hidden>
          <path
            d="M12 4h16l10 10v28a2 2 0 0 1-2 2H12a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"
            fill="#cfd4dc"
          />
          <path d="M28 4l10 10H28V4z" fill="#9aa1ac" />
        </svg>
      );
  }
}

// Feuille blanche + pastille de couleur, base commune des icones de fichier.
function FileBadge({ tint, children }: { tint: string; children: ReactNode }) {
  return (
    <svg viewBox="0 0 48 48" className="ficon" aria-hidden>
      <path
        d="M12 4h16l10 10v28a2 2 0 0 1-2 2H12a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"
        fill="#f4f6f9"
      />
      <path d="M28 4l10 10H28V4z" fill="#c7ccd4" />
      <rect x="10" y="14" width="28" height="24" rx="2" fill={tint} opacity="0.14" />
      {children}
    </svg>
  );
}

// Pastille Adobe (Pr / Ae).
function AdobeBadge({ letters, bg, fg }: { letters: string; bg: string; fg: string }) {
  return (
    <svg viewBox="0 0 48 48" className="ficon" aria-hidden>
      <rect x="8" y="8" width="32" height="32" rx="6" fill={bg} />
      <rect x="8" y="8" width="32" height="32" rx="6" fill="none" stroke={fg} strokeWidth="1.5" opacity="0.5" />
      <text
        x="24"
        y="31"
        textAnchor="middle"
        fontSize="15"
        fontWeight="700"
        fontFamily="Segoe UI, system-ui, sans-serif"
        fill={fg}
      >
        {letters}
      </text>
    </svg>
  );
}

// ---- Icone de disque (volet de navigation, cote local) ---------------------
export type DriveKind = "fixed" | "network" | "removable" | "cdrom" | "cloud";

export function DriveIcon({ kind }: { kind: DriveKind }) {
  if (kind === "cloud")
    return (
      <svg viewBox="0 0 48 48" className="ficon" aria-hidden>
        <path
          d="M15 34a8 8 0 0 1-.6-16A11 11 0 0 1 36 19.5 7.5 7.5 0 0 1 34.5 34H15z"
          fill="#5b9bff"
        />
      </svg>
    );
  if (kind === "removable")
    return (
      <svg viewBox="0 0 48 48" className="ficon" aria-hidden>
        <rect x="18" y="8" width="12" height="24" rx="2" fill="#7f8896" />
        <rect x="20" y="11" width="8" height="4" fill="#c9d0da" />
        <rect x="16" y="30" width="16" height="10" rx="2" fill="#9aa2ae" />
      </svg>
    );
  if (kind === "cdrom")
    return (
      <svg viewBox="0 0 48 48" className="ficon" aria-hidden>
        <circle cx="24" cy="24" r="15" fill="#9aa2ae" />
        <circle cx="24" cy="24" r="4" fill="#f4f6f9" />
      </svg>
    );
  // fixed / network : boitier de disque, avec pastille reseau si network.
  return (
    <svg viewBox="0 0 48 48" className="ficon" aria-hidden>
      <rect x="7" y="16" width="34" height="16" rx="3" fill="#8b93a1" />
      <rect x="7" y="16" width="34" height="8" rx="3" fill="#a7aeba" />
      <circle cx="35" cy="28" r="2" fill="#39b36e" />
      {kind === "network" && (
        <circle cx="24" cy="37" r="6" fill="#5b9bff" stroke="#f4f6f9" strokeWidth="1.5" />
      )}
    </svg>
  );
}

// ---- Icones d'interface ----------------------------------------------------
export function UiIcon({
  name,
}: {
  name: "list" | "tiles" | "back" | "forward" | "up" | "chevron" | "caret" | "refresh" | "journal" | "search";
}) {
  const c = "uicon";
  switch (name) {
    case "search":
      return (
        <svg viewBox="0 0 16 16" className={c} aria-hidden>
          <circle cx="7" cy="7" r="4.3" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M10.3 10.3L14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      );
    case "journal":
      return (
        <svg viewBox="0 0 16 16" className={c} aria-hidden>
          <rect x="3" y="1.5" width="10" height="13" rx="1.3" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <rect x="5.2" y="4.3" width="5.6" height="1.2" rx="0.6" />
          <rect x="5.2" y="7.1" width="5.6" height="1.2" rx="0.6" />
          <rect x="5.2" y="9.9" width="3.6" height="1.2" rx="0.6" />
        </svg>
      );
    case "list":
      return (
        <svg viewBox="0 0 16 16" className={c} aria-hidden>
          <circle cx="2.5" cy="4" r="1" />
          <circle cx="2.5" cy="8" r="1" />
          <circle cx="2.5" cy="12" r="1" />
          <rect x="5" y="3.3" width="9" height="1.4" rx="0.7" />
          <rect x="5" y="7.3" width="9" height="1.4" rx="0.7" />
          <rect x="5" y="11.3" width="9" height="1.4" rx="0.7" />
        </svg>
      );
    case "tiles":
      return (
        <svg viewBox="0 0 16 16" className={c} aria-hidden>
          <rect x="2" y="2" width="5" height="5" rx="1" />
          <rect x="9" y="2" width="5" height="5" rx="1" />
          <rect x="2" y="9" width="5" height="5" rx="1" />
          <rect x="9" y="9" width="5" height="5" rx="1" />
        </svg>
      );
    case "back":
      return (
        <svg viewBox="0 0 16 16" className={c} aria-hidden>
          <path d="M10 3L5 8l5 5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "forward":
      return (
        <svg viewBox="0 0 16 16" className={c} aria-hidden>
          <path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "up":
      return (
        <svg viewBox="0 0 16 16" className={c} aria-hidden>
          <path d="M3 10l5-5 5 5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "refresh":
      return (
        <svg viewBox="0 0 16 16" className={c} aria-hidden>
          <path d="M13 8a5 5 0 1 1-1.5-3.5M13 2v3h-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "chevron":
      return (
        <svg viewBox="0 0 16 16" className={c} aria-hidden>
          <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "caret":
      return (
        <svg viewBox="0 0 16 16" className={c} aria-hidden>
          <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
  }
}
