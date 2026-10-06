import { useEffect, useRef } from 'preact/hooks';
import { qs, useApi } from '../api/client';
import type { Feed, Freshness } from '../api/types';
import { longDate, num } from '../lib/format';
import { FirmPicker } from '../scope/FirmPicker';
import { ScopeBar } from '../scope/ScopeBar';
import { scopeParams, useParam, useScope } from '../scope/scope';
import { Card, ErrorBox, Kpi, Loading } from '../ui/bits';
import { ChangesTable } from '../ui/ChangesTable';

// What's new: position changes in filings made in a window (by filing date,
// at most 92 days per request), tracked companies or every private company,
// narrowed by the scope's firm and fund filters (the server filters; P6b W4).
// The server pages the list (F16): the KPIs count every match (its
// breakdown), the table and its export are one labeled page.

const PAGE = 500;

const daysBefore = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

export default function Activity() {
  const fresh = useApi<Freshness>('/api/freshness');
  const [scope] = useScope();
  const [since, setSince] = useParam('since');
  const [until, setUntil] = useParam('until');
  const [all, setAll] = useParam('all');
  const [pageParam, setPage] = useParam('page');
  const page = Math.max(Number(pageParam) || 1, 1);
  const newest = fresh.data?.newestFilingDate ?? null;
  const to = until || newest || '';
  const from = since || (to ? daysBefore(to, 30) : '');
  const feed = useApi<Feed>(
    from
      ? `/api/feed${qs({
          since: from,
          until: until || undefined,
          all: all === '1',
          ...scopeParams(scope, ['firm', 'fund']),
          limit: PAGE,
          offset: page > 1 ? (page - 1) * PAGE : undefined,
        })}`
      : null
  );
  // a new window or scope starts at page 1
  const query = `${from}|${until}|${all}|${scope.firms.join(',')}|${scope.funds.join(',')}`;
  const lastQuery = useRef(query);
  useEffect(() => {
    if (lastQuery.current !== query && page > 1) setPage('', { replace: true });
    lastQuery.current = query;
  }, [query]);
  const d = feed.data;
  const count = (t: keyof Feed['breakdown']) => d?.breakdown?.[t] ?? 0;
  const pages = d ? Math.max(Math.ceil(d.total / PAGE), 1) : 1;
  const first = d ? d.offset + 1 : 0;
  const last = d ? d.offset + d.events.length : 0;
  return (
    <div class="stack">
      <div class="page-head">
        <div>
          <div class="eyebrow">Activity</div>
          <h1>What's new in filings</h1>
          <p class="muted" style={{ margin: '4px 0 0' }}>
            Changes reported in N-PORT filings made from {longDate(from)} to {longDate(d?.until ?? to)}, in{' '}
            {d?.scope ?? '…'}. Each change compares a fund's filing with its previous one; at most 92 days at a time.
          </p>
        </div>
        <span class="spacer" />
        <div class="row">
          <label class="row small">
            Filed since
            <input
              class="input"
              type="date"
              value={from}
              max={to || undefined}
              onChange={e => setSince((e.target as HTMLInputElement).value)}
            />
          </label>
          <label class="row small">
            to
            <input
              class="input"
              type="date"
              value={to}
              min={from || undefined}
              max={newest ?? undefined}
              onChange={e => setUntil((e.target as HTMLInputElement).value)}
            />
          </label>
          <label class="row small">
            <input
              type="checkbox"
              checked={all === '1'}
              onChange={e => setAll((e.target as HTMLInputElement).checked ? '1' : '')}
            />
            All private companies
          </label>
        </div>
      </div>
      <div class="row wrap">
        <ScopeBar supports={{ filters: ['firm', 'fund'] }} newest={newest} />
        <FirmPicker />
      </div>
      <ErrorBox error={feed.error} />
      {feed.loading && !d && <Loading rows={6} />}
      {d && (
        <>
          <div class="kpis">
            <Kpi label="Changes" value={num(d.total)} sub={`filed ${d.since} → ${d.until}`} />
            <Kpi label="First reported" value={num(count('new'))} />
            <Kpi label="Added" value={num(count('added'))} />
            <Kpi label="Reduced" value={num(count('reduced'))} />
            <Kpi label="No longer reported" value={num(count('exited'))} />
            <Kpi label="Mark moved only" value={num(count('markMoved'))} />
          </div>
          {d.truncated && (
            <div class="row small" role="navigation" aria-label="Pages of changes">
              <span class="muted">
                Changes {num(first)}–{num(last)} of {num(d.total)} (the table and its export are this page; the counts
                above are every change)
              </span>
              <span class="spacer" />
              <button class="btn sm" type="button" disabled={page <= 1} onClick={() => setPage(String(page - 1))}>
                Previous
              </button>
              <span class="muted">
                Page {page} of {pages}
              </span>
              <button class="btn sm" type="button" disabled={page >= pages} onClick={() => setPage(String(page + 1))}>
                Next
              </button>
            </div>
          )}
          <Card flush>
            <ChangesTable
              events={d.events}
              withCompany
              exportName={`feed-${d.since}-${d.until}${d.truncated ? `-rows-${first}-${last}-of-${d.total}` : ''}`}
            />
          </Card>
        </>
      )}
    </div>
  );
}
