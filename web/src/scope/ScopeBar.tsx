import { useApi } from '../api/client';
import type { Envelope, Firm } from '../api/types';
import { Segmented } from '../ui/bits';
import { isRange, useScope, type Scope } from './scope';

// The scope bar: as of one date or over a range, and the active filters as
// removable chips. Pages say which parts apply to them (`supports`); a filter
// a page can't honor is never shown as if it applied.

export type FilterKind = 'firm' | 'fund' | 'class' | 'kind';

export interface ScopeSupport {
  range?: boolean;
  asof?: boolean;
  /** The filters this view applies; only these show as chips. */
  filters?: FilterKind[];
}

const addYears = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + n);
  return d.toISOString().slice(0, 10);
};

export const FIRST_DATE = '2019-09-30';

export function ScopeBar({
  supports,
  newest,
  fundName,
}: {
  supports: ScopeSupport;
  newest: string | null;
  /** Label for a fund key chip (the page knows its funds' names). */
  fundName?: (key: string) => string | undefined;
}) {
  const [scope, setScope] = useScope();
  const range = isRange(scope);
  const firms = useApi<Envelope & { results: Firm[] }>(scope.firms.length ? '/api/firms' : null);
  const firmName = (id: number) => firms.data?.results.find(f => f.id === id)?.name ?? `Firm ${id}`;
  const end = newest || new Date().toISOString().slice(0, 10);

  const mode = range ? 'range' : 'asof';
  const setMode = (m: 'asof' | 'range') => {
    if (m === 'range') setScope({ from: scope.from || addYears(end, -1), to: scope.to || end, asof: '' });
    else setScope({ from: '', to: '', asof: scope.to || '' });
  };
  const preset = (years: number | 'all') =>
    setScope({ from: years === 'all' ? FIRST_DATE : addYears(end, -years), to: end, asof: '' });

  const on = new Set(supports.filters ?? []);
  const chips: { label: string; clear: Partial<Scope> }[] = [
    ...(on.has('firm')
      ? scope.firms.map(id => ({ label: `Firm: ${firmName(id)}`, clear: { firms: scope.firms.filter(f => f !== id) } }))
      : []),
    ...(on.has('fund')
      ? scope.funds.map(k => ({
          label: `Fund: ${fundName?.(k) ?? k}`,
          clear: { funds: scope.funds.filter(f => f !== k) },
        }))
      : []),
    ...(on.has('class')
      ? scope.classes.map(c => ({ label: `Class: ${c}`, clear: { classes: scope.classes.filter(x => x !== c) } }))
      : []),
    ...(on.has('kind') && scope.kind
      ? [{ label: scope.kind === 'direct' ? 'Direct only' : 'Through an SPV only', clear: { kind: '' as const } }]
      : []),
  ];

  return (
    <div class="scope" aria-label="Scope">
      {supports.range && supports.asof && (
        <Segmented
          label="Date mode"
          value={mode}
          onChange={setMode}
          options={[
            { id: 'asof', label: 'As of' },
            { id: 'range', label: 'Range' },
          ]}
        />
      )}
      {(mode === 'asof' || !supports.range) && supports.asof && (
        <>
          <input
            class="input"
            type="date"
            aria-label="As of date"
            min={FIRST_DATE}
            max={end}
            value={scope.asof}
            onChange={e => setScope({ asof: (e.target as HTMLInputElement).value })}
          />
          {scope.asof ? (
            <button class="btn sm ghost" type="button" onClick={() => setScope({ asof: '' })}>
              Latest
            </button>
          ) : (
            <span class="muted small">latest marks</span>
          )}
        </>
      )}
      {supports.range && (range || !supports.asof) && (
        <>
          <input
            class="input"
            type="date"
            aria-label="From (mark date)"
            min={FIRST_DATE}
            max={scope.to || end}
            value={scope.from}
            onChange={e => setScope({ from: (e.target as HTMLInputElement).value })}
          />
          <span class="muted">→</span>
          <input
            class="input"
            type="date"
            aria-label="To (mark date)"
            min={scope.from || FIRST_DATE}
            max={end}
            value={scope.to}
            onChange={e => setScope({ to: (e.target as HTMLInputElement).value })}
          />
          <div class="seg" role="group" aria-label="Range presets">
            <button type="button" onClick={() => preset(1)}>
              1Y
            </button>
            <button type="button" onClick={() => preset(3)}>
              3Y
            </button>
            <button type="button" onClick={() => preset('all')}>
              All
            </button>
          </div>
        </>
      )}
      {chips.map(c => (
        <span class="chip" key={c.label}>
          {c.label}
          <button type="button" aria-label={`Remove ${c.label}`} onClick={() => setScope(c.clear)}>
            ×
          </button>
        </span>
      ))}
    </div>
  );
}
