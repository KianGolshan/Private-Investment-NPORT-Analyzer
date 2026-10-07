import { useLocation } from 'preact-iso';
import { qs, useApi } from '../../api/client';
import type { FirmChanges as FirmChangesT } from '../../api/types';
import { moneyDelta, num, tone } from '../../lib/format';
import { ScopeBar } from '../../scope/ScopeBar';
import { isRange, useParam, useScope } from '../../scope/scope';
import { Card, ErrorBox, Kpi, Loading } from '../../ui/bits';
import { ChangesTable } from '../../ui/ChangesTable';

// The firm's position changes across its funds' filings, paged (a large firm's
// year is thousands of events): counts and effect totals cover every matching
// event, the table one page at a time, newest first. Filter by kind of change.

const PAGE = 500;
const TYPES: { id: string; label: string }[] = [
  { id: '', label: 'All changes' },
  { id: 'new', label: 'First reported' },
  { id: 'added', label: 'Added' },
  { id: 'reduced', label: 'Reduced' },
  { id: 'exited', label: 'No longer reported' },
  { id: 'mixed', label: 'Added and reduced' },
  { id: 'unchanged', label: 'Mark moved only' },
];

export function FirmChanges({ id, name, newest }: { id: number; name: string; newest: string | null }) {
  const [scope] = useScope();
  const [type] = useParam('type');
  const loc = useLocation();
  // A new kind of change starts at the first page (one navigation, so Back undoes both).
  const setType = (v: string) => {
    const sp = new URLSearchParams(loc.url.includes('?') ? loc.url.slice(loc.url.indexOf('?') + 1) : '');
    if (v) sp.set('type', v);
    else sp.delete('type');
    sp.delete('page');
    const q = sp.toString();
    loc.route(loc.path + (q ? `?${q}` : ''));
  };
  const [pageParam, setPage] = useParam('page');
  const page = Math.max(0, Number(pageParam) || 0);
  const range = isRange(scope);
  const ch = useApi<FirmChangesT>(
    `/api/firms/${id}/changes${qs({
      since: range ? scope.from : '',
      until: range ? scope.to : '',
      types: type,
      limit: PAGE,
      offset: page * PAGE,
    })}`
  );
  const d = ch.data;
  const pages = d ? Math.ceil(d.count / PAGE) : 0;
  return (
    <div class="stack">
      <div class="row wrap">
        <ScopeBar supports={{ range: true }} newest={newest} />
        <select
          class="input"
          aria-label="Kind of change"
          value={type}
          onChange={e => {
            setType((e.target as HTMLSelectElement).value);
          }}
        >
          {TYPES.map(t => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
        {d && (
          <span class="muted small">
            Mark dates {d.since} → {d.until}
          </span>
        )}
      </div>
      <ErrorBox error={ch.error} />
      {ch.loading && !d && <Loading rows={6} />}
      {d && (
        <>
          <div class="kpis">
            <Kpi label="Changes" value={num(d.count)} sub="fund filings × companies" />
            <Kpi
              label="From positions"
              value={
                <span class={tone(d.totals.positionEffect + d.totals.otherEffect)}>
                  {moneyDelta(d.totals.positionEffect + d.totals.otherEffect)}
                </span>
              }
            />
            <Kpi
              label="From marks"
              value={<span class={tone(d.totals.markEffect)}>{moneyDelta(d.totals.markEffect)}</span>}
            />
            <Kpi
              label="First reported · added · reduced · no longer"
              value={`${num(d.byType.new ?? 0)} · ${num(d.byType.added ?? 0)} · ${num(d.byType.reduced ?? 0)} · ${num(d.byType.exited ?? 0)}`}
            />
          </div>
          <Card
            title={`Changes ${num(d.offset + 1)}–${num(Math.min(d.count, d.offset + PAGE))} of ${num(d.count)}`}
            actions={
              pages > 1 ? (
                <span class="row">
                  <button class="btn sm" type="button" disabled={page === 0} onClick={() => setPage(String(page - 1))}>
                    Newer
                  </button>
                  <span class="muted small">
                    page {page + 1} of {pages}
                  </span>
                  <button
                    class="btn sm"
                    type="button"
                    disabled={page + 1 >= pages}
                    onClick={() => setPage(String(page + 1))}
                  >
                    Older
                  </button>
                </span>
              ) : undefined
            }
            flush
          >
            <ChangesTable
              events={d.events}
              source={d}
              withCompany
              exportName={`${name}-changes-${d.since}-${d.until}-p${page + 1}`}
            />
          </Card>
        </>
      )}
    </div>
  );
}
