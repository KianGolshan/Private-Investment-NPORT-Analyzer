import { useMemo } from 'preact/hooks';
import { qs, useApi } from '../../api/client';
import type { Activity, Bridge, Pivot } from '../../api/types';
import { num } from '../../lib/format';
import { ScopeBar } from '../../scope/ScopeBar';
import { isRange, scopeParams, useScope } from '../../scope/scope';
import { Card, ErrorBox, Kpi, Loading } from '../../ui/bits';
import { ChangesTable } from '../../ui/ChangesTable';
import { BridgeView, PeriodEffects } from '../../ui/BridgeView';
import { FilterPickers, addDays, addYears, useFilterOptions, type ViewProps } from './shared';

// Changes over a range (default: the year to the newest mark date):
//   the bridge (start value, each kind of change, end value; reconciled to the
//   cent, its start and end the as-of rule), position vs mark effect by quarter,
//   and the ledger of every fund filing's change, split into position and mark.
// Changes are dated by each fund's own mark date ("changes in filings with mark
// dates in …"); levels are as of the range's ends.

export default function Changes({ base, sq, subject, name, newest, openPosition }: ViewProps) {
  const [scope] = useScope();
  const opts = useFilterOptions(base, sq);
  const range = isRange(scope);
  const to = range ? scope.to : (newest ?? '');
  const from = range ? scope.from : newest ? addYears(newest, -1) : '';
  const filters = scopeParams(scope);
  const bridge = useApi<Bridge>(to ? `${base}/bridge${qs({ from, to, ...sq, ...filters })}` : null);
  const pivot = useApi<Pivot>(
    to
      ? `/api/analysis/pivot${qs({ ...subject, rows: 'firm', period: 'quarter', from, to, limit: 1, ...filters })}`
      : null
  );
  // The ledger covers the bridge's window: mark dates after `from` through `to`.
  const act = useApi<Activity>(
    to ? `${base}/activity${qs({ since: addDays(from, 1), until: to, ...sq, ...filters })}` : null
  );
  const b = bridge.data;
  const events = act.data?.events ?? [];

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const e of events) c[e.type] = (c[e.type] ?? 0) + 1;
    return c;
  }, [events]);

  const p = pivot.data;

  return (
    <div class="stack">
      <div class="row wrap">
        <ScopeBar
          supports={{ range: true, asof: false, filters: ['firm', 'fund', 'class', 'kind'] }}
          newest={newest}
          fundName={opts.fundName}
        />
        <FilterPickers firms={opts.firms} classes={opts.classes} kinds={opts.indirect} />
        {!range && <span class="muted small">The year to the newest mark date. Pick a range to change it.</span>}
      </div>
      <ErrorBox error={bridge.error || act.error || pivot.error} />
      {bridge.loading && !b && <Loading rows={6} />}
      {b && <BridgeView bridge={b} name={name} />}
      {p && <PeriodEffects pivot={p} name={name} />}
      {act.data && (
        <>
          <div class="kpis">
            <Kpi label="First reported" value={num(counts.new ?? 0)} sub="funds’ first filing with it" />
            <Kpi label="Added" value={num(counts.added ?? 0)} sub="more shares or a new class" />
            <Kpi label="Reduced" value={num(counts.reduced ?? 0)} />
            <Kpi label="No longer reported" value={num(counts.exited ?? 0)} />
            <Kpi label="Mark moved only" value={num(counts.unchanged ?? 0)} sub="same shares, new mark" />
            {(counts.mixed ?? 0) + (counts.zeroed ?? 0) > 0 && (
              <Kpi
                label="Other"
                value={num((counts.mixed ?? 0) + (counts.zeroed ?? 0))}
                sub="added and reduced, or $0"
              />
            )}
          </div>
          <Card title="Position changes, filing by filing" flush>
            <ChangesTable events={events} exportName={`${name}-changes`} onFund={openPosition} />
          </Card>
        </>
      )}
    </div>
  );
}
