import type { ComponentChildren } from 'preact';
import type { WatchKind } from '../api/types';
import { edgarUrl, longDate } from '../lib/format';
import { isWatched, toggleWatch } from '../lib/watchlist';

type Tone = '' | 'pos' | 'neg' | 'warn' | 'info' | 'accent';

export function Badge({ tone = '', children, title }: { tone?: Tone; children: ComponentChildren; title?: string }) {
  return (
    <span class={`badge ${tone}`} title={title}>
      {children}
    </span>
  );
}

export function Kpi({ label, value, sub }: { label: string; value: ComponentChildren; sub?: ComponentChildren }) {
  return (
    <div class="kpi">
      <div class="label">{label}</div>
      <div class="value">{value}</div>
      {sub != null && <div class="sub">{sub}</div>}
    </div>
  );
}

export function Card({
  title,
  actions,
  flush,
  children,
}: {
  title?: ComponentChildren;
  actions?: ComponentChildren;
  flush?: boolean;
  children: ComponentChildren;
}) {
  return (
    <section class="card">
      {(title || actions) && (
        <div class="card-head">
          {/* h2 under the page's h1: headings never skip a level (review F-15) */}
          {typeof title === 'string' ? <h2>{title}</h2> : title}
          <span class="spacer" />
          {actions}
        </div>
      )}
      <div class={`card-body${flush ? ' flush' : ''}`}>{children}</div>
    </section>
  );
}

/** A fund's mark date, linked to the filing that reported it (every number cites its source). */
export function FilingRef({
  cik,
  accession,
  date,
  showAccession,
  long,
}: {
  cik: string | number | null | undefined;
  accession: string | null | undefined;
  date?: string | null;
  showAccession?: boolean;
  /** "May 31, 2026" instead of the ISO date tables use. */
  long?: boolean;
}) {
  const url = edgarUrl(cik, accession);
  const label = showAccession ? accession : (date && long ? longDate(date) : date) || accession || '—';
  if (!url) return <span>{label}</span>;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" title={`EDGAR filing ${accession}`}>
      {label}
      <span aria-hidden="true"> ↗</span>
      {/* read out of context, the link says where it goes (review 2026-10-15 accessibility) */}
      <span class="sr-only"> (N-PORT filing on EDGAR, opens in a new tab)</span>
    </a>
  );
}

export function Loading({ rows = 4 }: { rows?: number }) {
  return (
    <div class="stack" role="status" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} class="skeleton" style={{ height: i === 0 ? '28px' : '18px', width: `${90 - i * 8}%` }} />
      ))}
    </div>
  );
}

/** True for an API answer that says the subject does not exist (the page then shows NotFound). */
export const isNotFound = (error: Error | null) => !!error && (error as { status?: number }).status === 404;

export function ErrorBox({ error }: { error: Error | null }) {
  if (!error) return null;
  return (
    <div class="notice error" role="alert">
      {error.message}
    </div>
  );
}

export function Empty({ children }: { children: ComponentChildren }) {
  return <div class="empty">{children}</div>;
}

export function DateNote({ date }: { date: string | null | undefined }) {
  return <span title={date || ''}>{longDate(date)}</span>;
}

/** Tabs that live in the URL (?tab=), so Back returns to the previous tab. */
/**
 * Tabs that follow the WAI-ARIA tab pattern (review 2026-10-15 accessibility): each
 * tab names the panel it controls (`<TabPanel>` with the same `id`), only the
 * selected tab is in the Tab order, and the arrow keys, Home and End move along.
 */
export function Tabs({
  id,
  tabs,
  current,
  onSelect,
}: {
  /** Shared with this tab set's TabPanel. */
  id: string;
  tabs: { id: string; label: string }[];
  current: string;
  onSelect: (id: string) => void;
}) {
  const move = (e: KeyboardEvent, i: number) => {
    const to =
      e.key === 'ArrowRight'
        ? (i + 1) % tabs.length
        : e.key === 'ArrowLeft'
          ? (i - 1 + tabs.length) % tabs.length
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? tabs.length - 1
              : -1;
    if (to < 0) return;
    e.preventDefault();
    onSelect(tabs[to]!.id);
    document.getElementById(`${id}-tab-${tabs[to]!.id}`)?.focus();
  };
  return (
    <div class="tabs" role="tablist">
      {tabs.map((t, i) => (
        <button
          key={t.id}
          id={`${id}-tab-${t.id}`}
          type="button"
          role="tab"
          aria-selected={t.id === current}
          aria-controls={`${id}-panel`}
          tabIndex={t.id === current ? 0 : -1}
          onClick={() => onSelect(t.id)}
          onKeyDown={e => move(e, i)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** The content of the selected tab, labelled by it. */
export function TabPanel({ id, current, children }: { id: string; current: string; children: ComponentChildren }) {
  return (
    <div class="stack" role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-tab-${current}`}>
      {children}
    </div>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { id: T; label: string; title?: string }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div class="seg" role="group" aria-label={label}>
      {options.map(o => (
        <button key={o.id} type="button" aria-pressed={o.id === value} title={o.title} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Adds a company, firm or fund to the viewer's watchlist (this browser), or removes it. */
export function WatchButton({ kind, id, label }: { kind: WatchKind; id: string | number; label: string }) {
  const on = isWatched(kind, id);
  return (
    <button
      class={`btn sm${on ? '' : ' ghost'}`}
      type="button"
      aria-pressed={on}
      title={on ? 'On your watchlist (this browser): click to remove' : 'Add to your watchlist (this browser)'}
      onClick={() => toggleWatch({ kind, key: id, label })}
    >
      {on ? '★ Watching' : '☆ Watch'}
    </button>
  );
}
