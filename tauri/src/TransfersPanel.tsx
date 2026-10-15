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
      return "En attente";
    case "starting":
      return "Démarrage…";
    case "running":
      // Le debit affiche est une moyenne glissante : il decroit doucement au
      // lieu de tomber a zero, donc il ne revele pas un lien tombe. On le dit.
      // Libelle COURT : la colonne d'etat est etroite, « Figé depuis 12 s… »
      // passait a la ligne et coupait le « s » des secondes.
      if (isStalled(x, now)) {
        const s = Math.round((now - (x.movedAt ?? now)) / 1000);
        return `Figé ${s}s`;
      }
      return `${humanSize(x.speed)}/s`;
    case "retry": {
      const s = Math.max(0, Math.ceil((x.nextTry - now) / 1000));
      return `Reprise dans ${s} s`;
    }
    case "done":
      return "Terminé";
    case "error":
      return "Échec";
    case "cancelled":
      return "Annulé";
  }
}

// Bulle d'aide de la colonne « flux » : l'explication longue tient dans le
// `title` natif (aucune place a l'ecran, visible au survol seulement).
function streamsTitle(x: Xfer, n: number, fallback: boolean, s: Settings): string {
  const dir = x.dstFs.startsWith(REMOTE) ? "Envoi" : "Téléchargement";
  if (fallback)
    return `${dir} rabaissé à ${n} flux après un refus de connexions du serveur (repli automatique).`;
  if (n === 1)
    return `${dir} en flux unique : fichier sous le seuil de découpe (${s.cutoff}).`;
  return `${dir} découpé en ${n} flux parallèles.`;
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
          {streams.n} flux
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
          title={x.error || "Relancer ce transfert"}
          aria-label="Relancer"
        >
          ↻
        </button>
      ) : final ? (
        <span className="xfer-act-spacer" />
      ) : (
        <button
          className="xfer-act xfer-cancel"
          onClick={() => onCancel(x)}
          title="Annuler ce transfert"
          aria-label="Annuler"
        >
          ✕
        </button>
      )}
    </div>
  );
}

const EMPTY: Record<Tab, string> = {
  queue: "Aucun transfert en attente.",
  done: "Aucun transfert terminé.",
  failed: "Aucun échec.",
  cancelled: "Aucun transfert annulé.",
  edition: "Aucun fichier en cours d'édition.",
};

const EDIT_STATE: Record<EditItem["state"], string> = {
  watching: "Surveillé",
  changed: "Modifié",
  uploading: "Renvoi…",
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
        {EDIT_STATE[e.state]}
      </span>
      {e.state === "changed" ? (
        <button
          className="link-btn"
          onClick={() => onResend(e)}
          title="Renvoyer sur le serveur"
        >
          Renvoyer
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
        title="Ne plus surveiller ce fichier"
      >
        Arrêter de surveiller
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
}) {
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

  return (
    <div className="transfers-panel">
      <div className="transfers-actions">
        <div className="transfers-tabs">
          <Tabs id="queue" label="File d'attente" n={queue.length} />
          <Tabs id="done" label="Terminés" n={done.length} />
          <Tabs id="failed" label="Échoués" n={failed.length} />
          <Tabs id="cancelled" label="Annulés" n={cancelled.length} />
          {/* N'apparait qu'une fois qu'on edite au moins un fichier. */}
          {edits.length > 0 && (
            <Tabs id="edition" label="En cours d'édition" n={edits.length} />
          )}
        </div>
        <div className="transfers-tools">
          {preparing > 0 && (
            <span className="xfer-prep">
              Analyse de {preparing} élément{preparing > 1 ? "s" : ""}…
            </span>
          )}
          {tab === "queue" && queue.length > 0 && (
            <button className="link-btn" onClick={onCancelAll}>
              Tout annuler
            </button>
          )}
          {tab === "failed" && retryable > 0 && (
            <button className="link-btn" onClick={onRetryFailed}>
              Tout relancer ({retryable})
            </button>
          )}
          {/* Annulés : relance en lot (choix explicite — éviter de cliquer une
              à une sur des centaines de ↻). */}
          {tab === "cancelled" && cancelled.length > 0 && (
            <button className="link-btn" onClick={onRetryCancelled}>
              Tout relancer ({cancelled.length})
            </button>
          )}
          {(tab === "done" || tab === "failed" || tab === "cancelled") &&
            rows.length > 0 && (
              <button className="link-btn" onClick={() => onClear(tab)}>
                Nettoyer
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
            <div className="xfer-empty">{EMPTY.edition}</div>
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
          <div className="xfer-empty">{EMPTY[tab]}</div>
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
