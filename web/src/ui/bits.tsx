import type { ComponentChildren } from 'preact';
import { edgarUrl, longDate } from '../lib/format';

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
          {typeof title === 'string' ? <h3>{title}</h3> : title}
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
}: {
  cik: string | number | null | undefined;
  accession: string | null | undefined;
  date?: string | null;
  showAccession?: boolean;
}) {
  const url = edgarUrl(cik, accession);
  const label = showAccession ? accession : date || accession || '—';
  if (!url) return <span>{label}</span>;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" title={`EDGAR filing ${accession}`}>
      {label}
      <span aria-hidden="true"> ↗</span>
    </a>
  );
}

export function Loading({ rows = 4 }: { rows?: number }) {
  return (
    <div class="stack" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} class="skeleton" style={{ height: i === 0 ? '28px' : '18px', width: `${90 - i * 8}%` }} />
      ))}
    </div>
  );
}

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
export function Tabs({
  tabs,
  current,
  onSelect,
}: {
  tabs: { id: string; label: string }[];
  current: string;
  onSelect: (id: string) => void;
}) {
  return (
    <nav class="tabs" role="tablist">
      {tabs.map(t => (
        <button key={t.id} type="button" role="tab" aria-selected={t.id === current} onClick={() => onSelect(t.id)}>
          {t.label}
        </button>
      ))}
    </nav>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { id: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div class="seg" role="group" aria-label={label}>
      {options.map(o => (
        <button key={o.id} type="button" aria-pressed={o.id === value} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
