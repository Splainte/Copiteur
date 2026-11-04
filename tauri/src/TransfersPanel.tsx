// ============================================================
//  Copiteur — file d'attente des transferts (facon FileZilla)
//
//  Deux onglets : « File d'attente » (en cours EN HAUT, puis reprises, puis en
//  attente) et « Terminés » (reussis, echoues, annules — le plus recent en
//  premier, avec un bouton Réessayer sur les echecs).
// ============================================================
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  humanSize,
  isFinal,
  xferStreams,
  isUploadXfer,
  type Xfer,
  type EditItem,
  type Settings,
} from "./files";
import { t, tn, useT, type Key } from "./i18n";

export type Tab = "queue" | "done" | "failed" | "cancelled" | "edition";

// Hauteur FIXE d'une ligne de la file, en pixels. Le fenetrage (cf. VirtualRows)
// calcule quelles lignes sont visibles a partir de cette constante : elle DOIT
// rester synchronisee avec la regle CSS `.transfers-list.is-virtual .xfer-row`
// de chrome.css (height + box-sizing), sinon le placement derive.
const ROW_H = 30;
// Lignes rendues en plus au-dessus et au-dessous de la zone visible : le
// defilement rapide ne laisse pas apparaitre de vide le temps d'un rendu.
const OVERSCAN = 6;

// Rendu FENETRE (« liste virtuelle », comme le volet de file de FileZilla) :
// seules les lignes reellement visibles (plus une marge) existent dans le DOM.
// Une file de 20 000 transferts n'y pose donc qu'une trentaine de lignes,
// recyclees au fil du defilement — au lieu de 20 000 elements que le navigateur
// devrait creer, disposer et redessiner a chaque battement (ce qui figeait tout
// sur les gros dossiers). La donnee des 20 000 fichiers, elle, reste en memoire :
// c'est leger, seul l'affichage etait le gouffre.
function VirtualRows<T extends { id: number }>({
  items,
  renderRow,
}: {
  items: T[];
  renderRow: (item: T) => ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  // Hauteur visible du conteneur. Suivie par un ResizeObserver : la barre de
  // transferts peut etre redimensionnee (poignee de separation, fenetre), et la
  // fenetre de rendu doit s'ajuster sans quoi on rendrait trop peu (bandes
  // vides) ou trop de lignes.
  const [viewH, setViewH] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setViewH(el.clientHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const total = items.length;
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  // `viewH || 600` : avant la premiere mesure (rendu initial), on suppose une
  // hauteur plausible pour rendre assez de lignes tout de suite, plutot qu'une
  // liste vide corrigee au tick suivant.
  const count = Math.ceil((viewH || 600) / ROW_H) + OVERSCAN * 2;
  const last = Math.min(total, first + count);
  const slice = items.slice(first, last);

  return (
    <div
      className="transfers-list is-virtual"
      ref={ref}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
    >
      {/* Cale-hauteur : occupe la hauteur de TOUTE la file (total × ROW_H) pour
          que la barre de defilement reflete la vraie longueur. Les lignes
          rendues sont decalees par `translateY` a leur position reelle. */}
      <div style={{ height: total * ROW_H, position: "relative" }}>
        <div style={{ transform: `translateY(${first * ROW_H}px)` }}>
          {slice.map(renderRow)}
        </div>
      </div>
    </div>
  );
}

function pct(x: Xfer): number {
  if (x.size > 0) return Math.min(100, Math.round((x.bytes / x.size) * 100));
  return x.status === "done" ? 100 : 0;
}

// Au-dela de ce silence, on annonce le transfert comme FIGE. Purement visuel :
// on ne coupe rien, on ne relance rien. Les vrais delais reseau sont bien plus
// longs, et ils doivent le rester — un lien SFTP charge peut ne rien
// transmettre pendant 15-20 s sans etre mort, et abandonner a tort couterait
// une recopie depuis le debut (ecriture directe : pas de reprise partielle).
const STALL_MS = 10_000;

export const isStalled = (x: Xfer, now: number): boolean =>
  x.status === "running" && !!x.movedAt && now - x.movedAt > STALL_MS;

// Libelle d'etat, cote droit de chaque ligne.
function statusText(x: Xfer, now: number): string {
  switch (x.status) {
    case "queued":
      return t("panels.xfer.queued");
    case "starting":
      return t("panels.xfer.starting");
    case "running":
      // Le debit affiche est une moyenne glissante : il decroit doucement au
      // lieu de tomber a zero, donc il ne revele pas un lien tombe. On le dit.
      // Libelle COURT : la colonne d'etat est etroite, « Figé depuis 12 s… »
      // passait a la ligne et coupait le « s » des secondes.
      if (isStalled(x, now)) {
        const s = Math.round((now - (x.movedAt ?? now)) / 1000);
        return t("panels.xfer.stalled", { s });
      }
      return t("common.perSecond", { size: humanSize(x.speed) });
    case "retry": {
      const s = Math.max(0, Math.ceil((x.nextTry - now) / 1000));
      return t("panels.xfer.retryIn", { s });
    }
    case "done":
      return t("panels.xfer.done");
    case "error":
      return t("panels.xfer.error");
    case "cancelled":
      return t("panels.xfer.cancelled");
  }
}

// Bulle d'aide de la colonne « flux » : l'explication longue tient dans le
// `title` natif (aucune place a l'ecran, visible au survol seulement).
function streamsTitle(x: Xfer, n: number, fallback: boolean, s: Settings): string {
  const dir = t(isUploadXfer(x) ? "panels.xfer.upload" : "panels.xfer.download");
  if (fallback) return tn("panels.xfer.tipFallback", n, { dir });
  if (n === 1) return t("panels.xfer.tipSingle", { dir, cutoff: s.cutoff });
  return t("panels.xfer.tipSplit", { dir, n });
}

function Row({
  x,
  now,
  bar,
  settings,
  onCancel,
  onRetry,
}: {
  x: Xfer;
  now: number;
  bar: boolean; // barre de progression (file) ou taille du fichier (termines)
  settings: Settings;
  onCancel: (x: Xfer) => void;
  onRetry: (x: Xfer) => void;
}) {
  const final = isFinal(x);
  // Colonne « flux » : seulement quand la ligne affiche un debit (transfert qui
  // AVANCE), pas quand elle est figee/en attente/terminee — la un compte de flux
  // n'apprend rien. Le nombre passe en couleur d'alerte si l'envoi a du se
  // rabattre sur moins de connexions.
  const streams =
    bar && x.status === "running" && !isStalled(x, now)
      ? xferStreams(x, settings)
      : null;
  return (
    <div className={"xfer-row" + (final ? " is-done" : "")}>
      {/* La progression TEINTE LE FOND de la ligne au lieu d'occuper une colonne :
          le nom recupere toute la place, et l'avancement se lit de loin. La
          teinte prend toute la hauteur et ne porte aucun arrondi, pour que deux
          lignes voisines forment une colonne continue sans coûter un pixel de
          hauteur. Posee AVANT le contenu : elle est en fond, le reste passe
          au-dessus (cf. `.xfer-row > :not(.xfer-wash)`). */}
      {bar && (
        <span
          className={
            "xfer-wash" +
            (x.status === "error" ? " is-err" : "") +
            (x.status === "retry" || isStalled(x, now) ? " is-retry" : "")
          }
          style={{ width: `${pct(x)}%` }}
        />
      )}
      <span className="xfer-name" title={x.rel ? `${x.rel}/${x.name}` : x.name}>
        {x.rel && <span className="xfer-rel">{x.rel}/</span>}
        {x.name}
      </span>
      {/* Trajet : « Pixel 9 Pro → NAS Neufsept · RUSHS ». Les deux panneaux
          pouvant afficher n'importe quelle source, le sens seul ne suffit plus
          a dire d'ou vient et ou va un fichier. */}
      {x.srcLabel && x.dstLabel && (
        <span className="xfer-route" title={`${x.srcLabel} → ${x.dstLabel}`}>
          {x.srcLabel} → {x.dstLabel}
        </span>
      )}
      {!bar && (
        // Onglet « Terminés » : une barre pleine a 100 % n'apprend rien — la
        // taille du fichier, si.
        <span className="xfer-size">{x.size ? humanSize(x.size) : ""}</span>
      )}
      {/* Toujours presente dans la file (vide sans debit) : largeur fixe, les
          colonnes restent alignees d'une ligne a l'autre. */}
      {bar && (
        <span
          className={"xfer-streams" + (streams?.fallback ? " is-retry" : "")}
          title={streams ? streamsTitle(x, streams.n, streams.fallback, settings) : undefined}
        >
          {streams ? tn("panels.xfer.streams", streams.n) : ""}
        </span>
      )}
      <span
        className={
          "xfer-stat" +
          (x.status === "retry" || isStalled(x, now) ? " is-retry" : "") +
          (x.status === "error" ? " is-err" : "")
        }
        title={x.error || undefined}
      >
        {statusText(x, now)}
      </span>
      {/* Un annulé se relance aussi à la main (mais jamais par « Tout relancer »). */}
      {x.status === "error" || x.status === "cancelled" ? (
        <button
          className="xfer-act"
          onClick={() => onRetry(x)}
          title={x.error || t("panels.xfer.retryTitle")}
          aria-label={t("panels.xfer.retry")}
        >
          ↻
        </button>
      ) : final ? (
        <span className="xfer-act-spacer" />
      ) : (
        <button
          className="xfer-act xfer-cancel"
          onClick={() => onCancel(x)}
          title={t("panels.xfer.cancelTitle")}
          aria-label={t("common.cancel")}
        >
          ✕
        </button>
      )}
    </div>
  );
}

const EMPTY: Record<Tab, Key> = {
  queue: "panels.xfer.empty.queue",
  done: "panels.xfer.empty.done",
  failed: "panels.xfer.empty.failed",
  cancelled: "panels.xfer.empty.cancelled",
  edition: "panels.xfer.empty.edition",
};

const EDIT_STATE: Record<EditItem["state"], Key> = {
  watching: "panels.edit.watching",
  changed: "panels.edit.changed",
  uploading: "panels.edit.uploading",
};

// Une ligne de l'onglet « En cours d'édition » : nom, état, et actions
// (Renvoyer si modifié, Arrêter la surveillance).
function EditRow({
  e,
  onResend,
  onStop,
}: {
  e: EditItem;
  onResend: (e: EditItem) => void;
  onStop: (id: number) => void;
}) {
  return (
    <div className="xfer-row">
      <span className="xfer-name" title={e.label}>
        {e.label}
      </span>
      <span
        className={
          "xfer-stat" + (e.state === "changed" ? " is-retry" : "")
        }
      >
        {t(EDIT_STATE[e.state])}
      </span>
      {e.state === "changed" ? (
        <button
          className="link-btn"
          onClick={() => onResend(e)}
          title={t("panels.edit.resendTitle")}
        >
          {t("panels.edit.resend")}
        </button>
      ) : (
        <span className="xfer-act-spacer" />
      )}
      {/* Bouton EXPLICITE plutot qu'une croix : arreter la surveillance est
          l'action normale quand on a fini de consulter un fichier, et une croix
          muette ne le disait pas. Reste sur une seule ligne fine pour ne pas
          etirer la liste quand plusieurs fichiers sont ouverts. */}
      <button
        className="btn-stop-watch"
        onClick={() => onStop(e.id)}
        title={t("panels.edit.stopTitle")}
      >
        {t("panels.edit.stop")}
      </button>
    </div>
  );
}

export function TransfersPanel({
  queue,
  done,
  failed,
  cancelled,
  edits,
  tab,
  onTab,
  preparing,
  now,
  settings,
  onCancel,
  onCancelAll,
  onRetry,
  onRetryFailed,
  onRetryCancelled,
  onClear,
  onEditResend,
  onEditStop,
  summary,
  onHide,
}: {
  queue: Xfer[];
  done: Xfer[];
  failed: Xfer[];
  cancelled: Xfer[];
  edits: EditItem[];
  tab: Tab;
  onTab: (t: Tab) => void;
  preparing: number;
  now: number;
  settings: Settings;
  onCancel: (x: Xfer) => void;
  onCancelAll: () => void;
  onRetry: (x: Xfer) => void;
  onRetryFailed: () => void;
  onRetryCancelled: () => void;
  onClear: (tab: Tab) => void;
  onEditResend: (e: EditItem) => void;
  onEditStop: (id: number) => void;
  // Resume affiche dans l'en-tete.
  summary: XferSummary;
  // Chevron : cache la zone EN ENTIER, exactement comme le bouton Transferts
  // de la barre du haut (qui s'etire alors en pilule de progression). Plus
  // d'etat « replie sur une ligne » : il ne servait a rien (demande de Robin).
  onHide: () => void;
}) {
  useT();
  const rows =
    tab === "queue"
      ? queue
      : tab === "done"
        ? done
        : tab === "cancelled"
          ? cancelled
          : failed;
  // Les transferts annules sont dans l'onglet Échoués, mais une relance en lot
  // ne doit PAS ressusciter ce que l'utilisateur a arrete volontairement.
  const retryable = failed.filter((x) => x.status === "error").length;

  // Onglets en pastilles ; « Édition » n'apparait qu'une fois qu'on edite au
  // moins un fichier.
  const tabList: { id: Tab; label: string; n: number }[] = [
    { id: "queue", label: t("chrome.tab.queue"), n: queue.length },
    { id: "done", label: t("chrome.tab.done"), n: done.length },
    { id: "failed", label: t("chrome.tab.failed"), n: failed.length },
    { id: "cancelled", label: t("chrome.tab.cancelled"), n: cancelled.length },
    ...(edits.length > 0 ? [{ id: "edition" as Tab, label: t("chrome.tab.edition"), n: edits.length }] : []),
  ];
  const tools = (
    <>
      {preparing > 0 && <span className="xfer-prep">{tn("panels.xfer.preparing", preparing)}</span>}
      {tab === "queue" && queue.length > 0 && (
        <button className="link-btn" onClick={onCancelAll}>
          {t("panels.xfer.cancelAll")}
        </button>
      )}
      {tab === "failed" && retryable > 0 && (
        <button className="link-btn" onClick={onRetryFailed}>
          {t("panels.xfer.retryAll", { n: retryable })}
        </button>
      )}
      {tab === "cancelled" && cancelled.length > 0 && (
        <button className="link-btn" onClick={onRetryCancelled}>
          {t("panels.xfer.retryAll", { n: cancelled.length })}
        </button>
      )}
      {(tab === "done" || tab === "failed" || tab === "cancelled") && rows.length > 0 && (
        <button className="link-btn" onClick={() => onClear(tab)}>
          {t("panels.xfer.clear")}
        </button>
      )}
    </>
  );
  const list =
    tab === "edition" ? (
      <div className="transfers-list">
        {edits.length === 0 ? (
          <div className="xfer-empty">{t(EMPTY.edition)}</div>
        ) : (
          edits.map((e) => <EditRow key={e.id} e={e} onResend={onEditResend} onStop={onEditStop} />)
        )}
      </div>
    ) : rows.length === 0 ? (
      <div className="transfers-list">
        <div className="xfer-empty">{t(EMPTY[tab])}</div>
      </div>
    ) : (
      <VirtualRows
        items={rows}
        renderRow={(x) => (
          <Row
            key={x.id}
            x={x}
            now={now}
            bar={tab === "queue"}
            settings={settings}
            onCancel={onCancel}
            onRetry={onRetry}
          />
        )}
      />
    );
  const sum = summary;

  // Îlot sous les panneaux : en-tete = onglets + resume + actions.
  return (
    <div className="transfers-panel xfer-island">
      <div className="xfer-island-head">
        <span className="xfer-island-title">{t("chrome.xfer.title")}</span>
        <div className="xfer-seg" role="tablist">
          {tabList.map((x) => (
            <button
              key={x.id}
              role="tab"
              aria-selected={tab === x.id}
              className={"xfer-seg-btn" + (tab === x.id ? " is-on" : "") + (x.id === "failed" && x.n > 0 ? " is-alert" : "")}
              onClick={() => onTab(x.id)}
            >
              <span>{x.label}</span>
              {x.n > 0 && <span className="xfer-seg-n">{x.n}</span>}
            </button>
          ))}
        </div>
        <span className="xfer-flex" />
        {sum.active > 0 && (
          <span className={"xfer-island-sum" + (sum.state !== "run" ? " is-retry" : "")}>
            <span className="xfer-minibar">
              <span style={{ width: `${sum.pct ?? 0}%` }} />
            </span>
            <span className="xfer-island-pct">{sum.pct ?? 0} %</span>
            <span className="xfer-island-meta">{sum.line}</span>
          </span>
        )}
        <span className="xfer-island-tools">{tools}</span>
        <button
          className="xfer-icon-btn"
          onClick={onHide}
          title={t("chrome.xfer.hideAll")}
        >
          <svg viewBox="0 0 16 16" aria-hidden>
            <path
              d="M4 6l4 4 4-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
      {list}
    </div>
  );
}

// ============================================================
//  Resume des transferts (en-tete de l'îlot, bouton-pilule de la barre) et
//  anneau de progression.
// ============================================================
export type XferSummary = {
  active: number; // en cours + en attente + dossiers en cours d'analyse
  pct: number | null; // progression du lot (null : rien en cours)
  line: string; // « 94 Mo/s · reste 16,0 Go · 2 min »
  state: "run" | "retry" | "idle";
};

export function XferRing({ pct, size, state }: { pct: number | null; size: number; state: XferSummary["state"] }) {
  const r = 16;
  return (
    <span className={"xfer-ring" + (state === "retry" ? " is-retry" : "")} style={{ width: size, height: size }}>
      <svg viewBox="0 0 40 40" aria-hidden>
        <circle cx="20" cy="20" r={r} className="xfer-ring-track" />
        {pct !== null && (
          <circle cx="20" cy="20" r={r} className="xfer-ring-fill" pathLength={100} strokeDasharray={`${Math.max(0.5, pct)} 100`} />
        )}
      </svg>
      <svg viewBox="0 0 16 16" className="xfer-ring-glyph" aria-hidden>
        <path d="M5.5 2.8v9.6M3 9.9l2.5 2.5L8 9.9M10.5 13.2V3.6M8 6.1l2.5-2.5L13 6.1" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}
