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
  REMOTE,
  type Xfer,
  type EditItem,
  type Settings,
} from "./files";
import { t, tn, useT, type Key } from "./i18n";

export type Tab = "queue" | "done" | "failed" | "cancelled" | "edition";

// Hauteur FIXE d'une ligne de la file, en pixels. Le fenetrage (cf. VirtualRows)
// calcule quelles lignes sont visibles a partir de cette constante : elle DOIT
// rester synchronisee avec la regle CSS `.transfers-list.is-virtual .xfer-row`
// (height + box-sizing), sinon le placement derive. La ligne la plus haute est
// portee par les boutons d'action (20 px) + 2×3 px de padding vertical = 26 px.
const ROW_H = 26;
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
  rowH = ROW_H,
}: {
  items: T[];
  renderRow: (item: T) => ReactNode;
  // BETA DESIGN : les habillages Îlots ont des lignes plus hautes (fiches).
  rowH?: number;
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
  const first = Math.max(0, Math.floor(scrollTop / rowH) - OVERSCAN);
  // `viewH || 600` : avant la premiere mesure (rendu initial), on suppose une
  // hauteur plausible pour rendre assez de lignes tout de suite, plutot qu'une
  // liste vide corrigee au tick suivant.
  const count = Math.ceil((viewH || 600) / rowH) + OVERSCAN * 2;
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
      <div style={{ height: total * rowH, position: "relative" }}>
        <div style={{ transform: `translateY(${first * rowH}px)` }}>
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
  const dir = t(x.dstFs.startsWith(REMOTE) ? "panels.xfer.upload" : "panels.xfer.download");
  if (fallback) return tn("panels.xfer.tipFallback", n, { dir });
  if (n === 1) return t("panels.xfer.tipSingle", { dir, cutoff: s.cutoff });
  return t("panels.xfer.tipSplit", { dir, n });
}

// BETA DESIGN : sens du transfert (envoi vers le serveur / reception).
function DirGlyph({ up }: { up: boolean }) {
  return (
    <svg viewBox="0 0 16 16" className="xfer-dir-glyph" aria-hidden>
      {up ? (
        <path d="M8 13V3.5M4.2 7.2 8 3.4l3.8 3.8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      ) : (
        <path d="M8 3v9.5M4.2 8.8 8 12.6l3.8-3.8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      )}
    </svg>
  );
}

function RowAction({
  x,
  final,
  onCancel,
  onRetry,
}: {
  x: Xfer;
  final: boolean;
  onCancel: (x: Xfer) => void;
  onRetry: (x: Xfer) => void;
}) {
  if (x.status === "error" || x.status === "cancelled")
    return (
      <button
        className="xfer-act"
        onClick={() => onRetry(x)}
        title={x.error || t("panels.xfer.retryTitle")}
        aria-label={t("panels.xfer.retry")}
      >
        ↻
      </button>
    );
  if (final) return <span className="xfer-act-spacer" />;
  return (
    <button
      className="xfer-act xfer-cancel"
      onClick={() => onCancel(x)}
      title={t("panels.xfer.cancelTitle")}
      aria-label={t("common.cancel")}
    >
      ✕
    </button>
  );
}

function Row({
  x,
  now,
  bar,
  settings,
  onCancel,
  onRetry,
  variant = "line",
}: {
  x: Xfer;
  now: number;
  bar: boolean; // barre de progression (file) ou taille du fichier (termines)
  settings: Settings;
  onCancel: (x: Xfer) => void;
  onRetry: (x: Xfer) => void;
  // BETA DESIGN : « line » = la ligne d'origine ; « card » = fiche sur deux
  // lignes (colonne de B2) ; « table » = ligne de tableau large (vue de B3).
  variant?: "line" | "card" | "table";
}) {
  const final = isFinal(x);
  const up = x.dstFs.startsWith(REMOTE);
  const tone =
    x.status === "error" ? " is-err" : x.status === "retry" || isStalled(x, now) ? " is-retry" : "";
  if (variant === "card")
    return (
      <div className={"xfer-card" + (final ? " is-done" : "") + tone}>
        <span className={"xfer-dir" + (up ? " is-up" : "")} title={t(up ? "panels.xfer.upload" : "panels.xfer.download")}>
          <DirGlyph up={up} />
        </span>
        <div className="xfer-card-main">
          <div className="xfer-card-name" title={x.rel ? `${x.rel}/${x.name}` : x.name}>
            {x.name}
          </div>
          <div className="xfer-card-sub">
            <span className={"xfer-stat" + tone} title={x.error || undefined}>
              {statusText(x, now)}
            </span>
            {x.size > 0 && (
              <span className="xfer-card-size">
                {bar && x.status === "running" ? `${pct(x)} % · ` : ""}
                {humanSize(x.size)}
              </span>
            )}
          </div>
          {bar && (
            <div className="xfer-card-bar">
              <span className={tone} style={{ width: `${pct(x)}%` }} />
            </div>
          )}
        </div>
        <RowAction x={x} final={final} onCancel={onCancel} onRetry={onRetry} />
      </div>
    );
  if (variant === "table") {
    const streams =
      bar && x.status === "running" && !isStalled(x, now) ? xferStreams(x, settings) : null;
    return (
      <div className={"xfer-trow" + (final ? " is-done" : "") + tone}>
        <span className={"xfer-dir" + (up ? " is-up" : "")} title={t(up ? "panels.xfer.upload" : "panels.xfer.download")}>
          <DirGlyph up={up} />
        </span>
        <span className="xfer-tname" title={x.rel ? `${x.rel}/${x.name}` : x.name}>
          {x.name}
          {x.rel && <span className="xfer-trel">{x.rel}</span>}
        </span>
        <span className="xfer-tsize">{x.size ? humanSize(x.size) : ""}</span>
        <span className="xfer-tprog">
          {bar ? (
            <>
              <span className="xfer-tbar">
                <span className={tone} style={{ width: `${pct(x)}%` }} />
              </span>
              <span className="xfer-tpct">{pct(x)} %</span>
            </>
          ) : null}
        </span>
        <span className={"xfer-stat" + tone} title={x.error || undefined}>
          {statusText(x, now)}
        </span>
        <span
          className={"xfer-streams" + (streams?.fallback ? " is-retry" : "")}
          title={streams ? streamsTitle(x, streams.n, streams.fallback, settings) : undefined}
        >
          {streams ? tn("panels.xfer.streams", streams.n) : ""}
        </span>
        <RowAction x={x} final={final} onCancel={onCancel} onRetry={onRetry} />
      </div>
    );
  }
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
      {!bar && (
        // Onglet « Terminés » : une barre pleine a 100 % n'apprend rien — la
        // taille du fichier, si.
        <span className="xfer-size">{x.size ? humanSize(x.size) : ""}</span>
      )}
      {streams && (
        <span
          className={"xfer-streams" + (streams.fallback ? " is-retry" : "")}
          title={streamsTitle(x, streams.n, streams.fallback, settings)}
        >
          {tn("panels.xfer.streams", streams.n)}
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
  onHide,
  variant = "classic",
  summary,
  collapsed,
  onToggleCollapse,
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
  // BETA DESIGN : habillages A et B, la liste se replie (bouton « Masquer »).
  onHide?: () => void;
  // BETA DESIGN (Îlots) : « island » = îlot sous les panneaux (B1), « column »
  // = colonne a droite (B2), « page » = vue Transferts plein cadre (B3).
  variant?: "classic" | "island" | "column" | "page";
  summary?: XferSummary;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
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

  const Tabs = ({ id, label, n }: { id: Tab; label: string; n: number }) => (
    <button
      className={"tab-btn" + (tab === id ? " is-active" : "")}
      onClick={() => onTab(id)}
    >
      {label}
      {n ? ` (${n})` : ""}
    </button>
  );

  // ---- BETA DESIGN : morceaux partages par les variantes Îlots ----------------
  const tabList: { id: Tab; label: string; n: number }[] = [
    { id: "queue", label: t("design.tab.queue"), n: queue.length },
    { id: "done", label: t("design.tab.done"), n: done.length },
    { id: "failed", label: t("design.tab.failed"), n: failed.length },
    { id: "cancelled", label: t("design.tab.cancelled"), n: cancelled.length },
    ...(edits.length > 0 ? [{ id: "edition" as Tab, label: t("design.tab.edition"), n: edits.length }] : []),
  ];
  const pills = (extra = "") => (
    <div className={"xfer-seg" + extra} role="tablist">
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
  );
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
  const rowVariant = variant === "column" ? "card" : variant === "page" ? "table" : "line";
  const rowH = variant === "column" ? 58 : variant === "page" ? 40 : variant === "island" ? 30 : ROW_H;
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
        rowH={rowH}
        renderRow={(x) => (
          <Row
            key={x.id}
            x={x}
            now={now}
            bar={tab === "queue"}
            settings={settings}
            onCancel={onCancel}
            onRetry={onRetry}
            variant={rowVariant}
          />
        )}
      />
    );
  const sum = summary;
  const chevron = (down: boolean) => (
    <svg viewBox="0 0 16 16" aria-hidden>
      <path d={down ? "M4 6l4 4 4-4" : "M4 10l4-4 4 4"} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );

  // B1 · îlot sous les panneaux : en-tete = onglets + resume + actions ;
  // replie, il ne reste que cet en-tete (le resume reste lisible).
  if (variant === "island")
    return (
      <div className={"transfers-panel xfer-island" + (collapsed ? " is-collapsed" : "")}>
        <div className="xfer-island-head">
          <span className="xfer-island-title">{t("design.xfer.title")}</span>
          {pills()}
          <span className="xfer-flex" />
          {sum && sum.active > 0 && (
            <span className={"xfer-island-sum" + (sum.state !== "run" ? " is-retry" : "")}>
              <span className="xfer-minibar">
                <span style={{ width: `${sum.pct ?? 0}%` }} />
              </span>
              <span className="xfer-island-pct">{sum.pct ?? 0} %</span>
              <span className="xfer-island-meta">{sum.line}</span>
            </span>
          )}
          <span className="xfer-island-tools">{tools}</span>
          {onToggleCollapse && (
            <button
              className="xfer-icon-btn"
              onClick={onToggleCollapse}
              title={t(collapsed ? "design.xfer.expand" : "design.xfer.collapse")}
            >
              {chevron(!collapsed)}
            </button>
          )}
        </div>
        {!collapsed && list}
      </div>
    );

  // B2 · colonne a droite ; repliee, elle devient un rail etroit.
  if (variant === "column") {
    if (collapsed)
      return (
        <button className="xfer-rail" onClick={onToggleCollapse} title={t("design.xfer.expand")}>
          <XferRing pct={sum?.pct ?? null} size={34} state={sum?.state ?? "idle"} />
          {sum && sum.active > 0 && <span className="xfer-rail-n">{sum.active}</span>}
          <span className="xfer-rail-label">{t("design.xfer.title")}</span>
          {failed.length > 0 && <span className="xfer-rail-alert">{failed.length}</span>}
        </button>
      );
    return (
      <div className="transfers-panel xfer-column">
        <div className="xfer-col-head">
          <XferRing pct={sum?.pct ?? null} size={44} state={sum?.state ?? "idle"} />
          <div className="xfer-col-sum">
            <div className="xfer-col-title">
              {sum && sum.active > 0 ? tn("design.xfer.count", sum.active) : t("design.xfer.title")}
            </div>
            <div className={"xfer-col-sub" + (sum && sum.state !== "run" && sum.active > 0 ? " is-retry" : "")}>
              {sum && sum.active > 0 ? sum.line : t("design.xfer.idle")}
            </div>
          </div>
          {onToggleCollapse && (
            <button className="xfer-icon-btn" onClick={onToggleCollapse} title={t("design.xfer.collapse")}>
              <svg viewBox="0 0 16 16" aria-hidden>
                <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
        </div>
        {pills(" is-wrap")}
        <div className="xfer-col-tools">{tools}</div>
        {list}
      </div>
    );
  }

  // B3 · vue Transferts : un îlot de synthese a gauche, la liste a droite.
  if (variant === "page")
    return (
      <div className="xfer-page">
        <aside className="xfer-page-side">
          <XferRing pct={sum?.pct ?? null} size={128} state={sum?.state ?? "idle"} big />
          <div className="xfer-page-title">
            {sum && sum.active > 0 ? tn("design.xfer.count", sum.active) : t("design.xfer.idle")}
          </div>
          {sum && sum.active > 0 && (
            <dl className="xfer-page-stats">
              <dt>{t("design.xfer.speed")}</dt>
              <dd>{sum.speed}</dd>
              <dt>{t("design.xfer.left")}</dt>
              <dd>{sum.remaining}</dd>
              {sum.endAt && (
                <>
                  <dt>{t("design.xfer.end")}</dt>
                  <dd>{sum.endAt}</dd>
                </>
              )}
            </dl>
          )}
          <nav className="xfer-page-nav">
            {tabList.map((x) => (
              <button
                key={x.id}
                className={"xfer-nav" + (tab === x.id ? " is-on" : "") + (x.id === "failed" && x.n > 0 ? " is-alert" : "")}
                onClick={() => onTab(x.id)}
              >
                <span>{x.label}</span>
                <span className="xfer-nav-n">{x.n || ""}</span>
              </button>
            ))}
          </nav>
          <div className="xfer-page-tools">{tools}</div>
        </aside>
        <section className="xfer-page-list">
          <div className="xfer-thead">
            <span />
            <span>{t("pane.col.name")}</span>
            <span>{t("pane.col.size")}</span>
            <span>{t("design.xfer.progress")}</span>
            <span>{t("design.xfer.state")}</span>
            <span />
            <span />
          </div>
          {list}
        </section>
      </div>
    );

  return (
    <div className="transfers-panel">
      <div className="transfers-actions">
        <div className="transfers-tabs">
          <Tabs id="queue" label={t("panels.tab.queue")} n={queue.length} />
          <Tabs id="done" label={t("panels.tab.done")} n={done.length} />
          <Tabs id="failed" label={t("panels.tab.failed")} n={failed.length} />
          <Tabs id="cancelled" label={t("panels.tab.cancelled")} n={cancelled.length} />
          {/* N'apparait qu'une fois qu'on edite au moins un fichier. */}
          {edits.length > 0 && (
            <Tabs id="edition" label={t("panels.tab.edition")} n={edits.length} />
          )}
        </div>
        <div className="transfers-tools">
          {preparing > 0 && (
            <span className="xfer-prep">
              {tn("panels.xfer.preparing", preparing)}
            </span>
          )}
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
          {/* Annulés : relance en lot (choix explicite — éviter de cliquer une
              à une sur des centaines de ↻). */}
          {tab === "cancelled" && cancelled.length > 0 && (
            <button className="link-btn" onClick={onRetryCancelled}>
              {t("panels.xfer.retryAll", { n: cancelled.length })}
            </button>
          )}
          {(tab === "done" || tab === "failed" || tab === "cancelled") &&
            rows.length > 0 && (
              <button className="link-btn" onClick={() => onClear(tab)}>
                {t("panels.xfer.clear")}
              </button>
            )}
          {onHide && (
            <button className="link-btn xfer-hide" onClick={onHide} title={t("design.xfer.hide")}>
              <svg viewBox="0 0 16 16" aria-hidden>
                <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Onglet Édition et listes vides : peu d'elements, rendu direct (pas de
          virtualisation a gagner). Les onglets de transferts, eux, passent par
          VirtualRows — ce sont eux qui peuvent compter des dizaines de milliers
          de lignes. */}
      {tab === "edition" ? (
        <div className="transfers-list">
          {edits.length === 0 ? (
            <div className="xfer-empty">{t(EMPTY.edition)}</div>
          ) : (
            edits.map((e) => (
              <EditRow
                key={e.id}
                e={e}
                onResend={onEditResend}
                onStop={onEditStop}
              />
            ))
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
      )}
    </div>
  );
}

// ============================================================
//  BETA DESIGN : resume des transferts + anneau + bande de suivi (B3)
// ============================================================
export type XferSummary = {
  active: number; // en cours + en attente + dossiers en cours d'analyse
  pct: number | null; // progression du lot (null : rien en cours)
  remaining: string; // « 16,0 Go »
  speed: string; // « 94 Mo/s »
  endAt: string; // heure de fin estimee (« 15:42 ») ou ""
  line: string; // « 94 Mo/s · reste 16,0 Go · 2 min »
  state: "run" | "retry" | "idle";
  failed: number;
};

export function XferRing({
  pct,
  size,
  state,
  big,
}: {
  pct: number | null;
  size: number;
  state: XferSummary["state"];
  big?: boolean;
}) {
  const r = 16;
  return (
    <span className={"xfer-ring" + (big ? " is-big" : "") + (state === "retry" ? " is-retry" : "")} style={{ width: size, height: size }}>
      <svg viewBox="0 0 40 40" aria-hidden>
        <circle cx="20" cy="20" r={r} className="xfer-ring-track" />
        {pct !== null && (
          <circle cx="20" cy="20" r={r} className="xfer-ring-fill" pathLength={100} strokeDasharray={`${Math.max(0.5, pct)} 100`} />
        )}
      </svg>
      {big ? (
        <span className="xfer-ring-pct">{pct === null ? "—" : `${pct} %`}</span>
      ) : (
        <svg viewBox="0 0 16 16" className="xfer-ring-glyph" aria-hidden>
          <path d="M5.5 2.8v9.6M3 9.9l2.5 2.5L8 9.9M10.5 13.2V3.6M8 6.1l2.5-2.5L13 6.1" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </span>
  );
}

export function XferStrip({ summary, onOpen }: { summary: XferSummary; onOpen: () => void }) {
  useT();
  const s = summary;
  return (
    <button className={"xfer-strip" + (s.state === "retry" ? " is-retry" : "")} onClick={onOpen}>
      <XferRing pct={s.pct} size={24} state={s.state} />
      <span className="xfer-strip-title">
        {s.active > 0 ? tn("design.xfer.count", s.active) : tn("design.xfer.failedN", s.failed)}
      </span>
      {s.active > 0 && (
        <>
          <span className="xfer-strip-bar">
            <span style={{ width: `${s.pct ?? 0}%` }} />
          </span>
          <span className="xfer-strip-meta">
            {s.pct ?? 0} % · {s.line}
          </span>
        </>
      )}
      <span className="xfer-strip-link">{t("design.xfer.see")} →</span>
    </button>
  );
}
