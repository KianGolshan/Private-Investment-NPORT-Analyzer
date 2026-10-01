import { qs, useApi } from '../api/client';
import type { Feed, Freshness } from '../api/types';
import { longDate, num } from '../lib/format';
import { useParam } from '../scope/scope';
import { Card, ErrorBox, Kpi, Loading } from '../ui/bits';
import { ChangesTable } from '../ui/ChangesTable';

// What's new: position changes in filings made in a window (by filing date,
// at most 92 days per request), tracked companies or every private company.

const daysBefore = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

export default function Activity() {
  const fresh = useApi<Freshness>('/api/freshness');
  const [since, setSince] = useParam('since');
  const [all, setAll] = useParam('all');
  const newest = fresh.data?.newestFilingDate ?? null;
  const from = since || (newest ? daysBefore(newest, 30) : '');
  const feed = useApi<Feed>(from ? `/api/feed${qs({ since: from, all: all === '1' })}` : null);
  const d = feed.data;
  const count = (t: string) => d?.events.filter(e => e.type === t).length ?? 0;
  return (
    <div class="stack">
      <div class="page-head">
        <div>
          <div class="eyebrow">Activity</div>
          <h1>What's new in filings</h1>
          <p class="muted" style={{ margin: '4px 0 0' }}>
            Changes reported in N-PORT filings made since {longDate(from)} ({d?.scope ?? '…'}). Each change compares a
            fund's filing with its previous one.
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
              max={newest ?? undefined}
              onChange={e => setSince((e.target as HTMLInputElement).value)}
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
      <ErrorBox error={feed.error} />
      {feed.loading && !d && <Loading rows={6} />}
      {d && (
        <>
          <div class="kpis">
            <Kpi label="Changes" value={num(d.count)} sub={`filed ${d.since} → ${d.until}`} />
            <Kpi label="First reported" value={num(count('new'))} />
            <Kpi label="Added" value={num(count('added'))} />
            <Kpi label="Reduced" value={num(count('reduced'))} />
            <Kpi label="No longer reported" value={num(count('exited'))} />
          </div>
          <Card flush>
            <ChangesTable events={d.events} withCompany exportName={`feed-${d.since}-${d.until}`} />
          </Card>
        </>
      )}
    </div>
  );
}
