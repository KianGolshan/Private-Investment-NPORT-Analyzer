import { useEffect, useState } from 'preact/hooks';
import { useApi } from '../api/client';
import type { Envelope, Freshness } from '../api/types';
import { longDate, num } from '../lib/format';
import { Badge, Card, ErrorBox, Kpi, Loading } from '../ui/bits';
import type { WarehouseStats } from './About';

interface Readiness {
  ready: boolean;
  fresh: boolean;
  reason: string | null;
  refreshAgeHours: number | null;
  build: string;
}
interface Config {
  public: boolean;
  build: string;
  statusUrl?: string | null;
}

const ageText = (h: number | null) =>
  h == null
    ? 'unknown'
    : h < 1
      ? 'under an hour ago'
      : h < 48
        ? `${Math.round(h)} h ago`
        : `${Math.round(h / 24)} days ago`;

/** How current the data is (P9): the published generation, the last refresh and job, and what is stored. */
export default function Status() {
  const fresh = useApi<Freshness>('/api/freshness');
  const stats = useApi<Envelope & { stats: WarehouseStats }>('/api/stats').data?.stats;
  const config = useApi<Config>('/api/config').data;
  const [ready, setReady] = useState<Readiness | null>(null);
  useEffect(() => {
    let live = true;
    fetch('/readyz?fresh=1', { cache: 'no-store', headers: { Accept: 'application/json' } })
      .then(r => r.json())
      .then(b => live && setReady(b as Readiness))
      .catch(() => live && setReady(null));
    return () => {
      live = false;
    };
  }, [fresh.data?.refreshId]);
  const f = fresh.data;
  return (
    <div class="stack">
      <div class="page-head">
        <div>
          <div class="eyebrow">Status</div>
          <h1>Data status</h1>
          <p class="muted" style={{ margin: '4px 0 0' }}>
            New SEC filings load every night as a new, validated version of the data. See{' '}
            <a href="/about">about the data</a> for how it is checked.
          </p>
        </div>
        <span class="spacer" />
        {ready && (
          <Badge tone={ready.fresh ? 'pos' : 'warn'} title={ready.reason ?? undefined}>
            {ready.fresh ? 'Up to date' : `Attention: ${ready.reason ?? 'not current'}`}
          </Badge>
        )}
      </div>
      <ErrorBox error={fresh.error} />
      {fresh.loading && !f && <Loading rows={4} />}
      {f && (
        <div class="kpis">
          <Kpi label="Filings through" value={longDate(f.newestFilingDate)} sub="newest filing date loaded" />
          <Kpi label="Marks through" value={longDate(f.newestReportDate)} sub="newest report date with marks" />
          <Kpi
            label="Last refresh"
            value={ageText(ready?.refreshAgeHours ?? null)}
            sub={f.refreshedAt ? new Date(f.refreshedAt).toUTCString() : 'no refresh recorded'}
          />
          <Kpi
            label="Data version"
            value={`#${f.refreshId}`}
            sub={f.generation ? `published ${new Date(f.generation.publishedAt).toUTCString()}` : 'generation'}
          />
        </div>
      )}
      {f && (
        <Card title="Details">
          <table class="data status-details">
            <tbody>
              <tr>
                <th scope="row">Bulk data sets</th>
                <td>2019Q4 through {f.latestBulkQuarter ?? '—'}, then daily EDGAR catch-up</td>
              </tr>
              {stats && (
                <>
                  <tr>
                    <th scope="row">N-PORT filings</th>
                    <td>
                      {num(stats.filings)} from {num(stats.funds)} funds, filed {longDate(stats.firstFilingDate)} to{' '}
                      {longDate(stats.newestFilingDate)}
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">Companies</th>
                    <td>
                      {num(stats.privateCompanies)} private, {num(stats.trackedCompanies)} tracked
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">Firms</th>
                    <td>{num(stats.firms)}</td>
                  </tr>
                </>
              )}
              <tr>
                <th scope="row">Last job</th>
                <td>
                  {f.job
                    ? `${f.job.kind}: ${f.job.status}${f.job.finishedAt ? `, ${new Date(f.job.finishedAt).toUTCString()}` : ''}`
                    : '—'}
                </td>
              </tr>
              {f.generation?.curationDigest && (
                <tr>
                  <th scope="row">Reviewed lists</th>
                  <td>
                    <code>{f.generation.curationDigest.slice(0, 12)}</code> (sha256 of the reviewed company and firm
                    files)
                  </td>
                </tr>
              )}
              {config && (
                <tr>
                  <th scope="row">App version</th>
                  <td>
                    <code>{config.build}</code>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Card>
      )}
      {config?.statusUrl && (
        <p class="muted">
          Uptime history: <a href={config.statusUrl}>status page</a>.
        </p>
      )}
    </div>
  );
}
