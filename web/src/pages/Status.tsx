import { useEffect, useState } from 'preact/hooks';
import { useApi } from '../api/client';
import type { Envelope, Freshness } from '../api/types';
import { longDate, num } from '../lib/format';
import { Badge, Card, ErrorBox, Kpi, Loading } from '../ui/bits';
import type { WarehouseStats } from './About';
import { PAGE_TITLES, usePageTitle } from '../lib/title';

interface Readiness {
  ready: boolean;
  fresh: boolean;
  reason: string | null;
  refreshAgeHours: number | null;
  build: string;
  /** The last scheduled runs (null before the first one). */
  checks?: Record<'nightly' | 'monthly', RunCheck | null>;
}
interface RunCheck {
  status: 'ok' | 'warn' | 'fail';
  finishedAt: string;
  smoke: string | null;
  reconcile: string | null;
}

// "ok, Wed, 14 Oct 2026 04:36:52 GMT (golden numbers checked: passed)"
const runText = (r: RunCheck | null | undefined, step: 'smoke' | 'reconcile', what: string, none: string) =>
  !r
    ? none
    : `${r.status === 'ok' ? 'passed' : r.status === 'warn' ? 'passed with notes' : 'failed'}, ${new Date(r.finishedAt).toUTCString()}` +
      (r[step] ? ` (${what}: ${r[step] === 'ok' ? 'passed' : r[step]})` : '');
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
  usePageTitle(PAGE_TITLES.status);
  const fresh = useApi<Freshness>('/api/freshness');
  const stats = useApi<Envelope & { stats: WarehouseStats }>('/api/stats').data?.stats;
  const config = useApi<Config>('/api/config').data;
  const [ready, setReady] = useState<Readiness | null>(null);
  useEffect(() => {
    let live = true;
    fetch('/readyz?report=1', { cache: 'no-store', headers: { Accept: 'application/json' } })
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
            <a href="/about">About Vantage</a> for how it is checked.
          </p>
        </div>
        <span class="spacer" />
        {ready && (
          <Badge tone={ready.fresh ? 'pos' : 'warn'}>{ready.fresh ? 'Up to date' : attentionText(ready, f)}</Badge>
        )}
      </div>
      <ErrorBox error={fresh.error} />
      {fresh.loading && !f && <Loading rows={4} />}
      {f && (
        <div class="kpis">
          <Kpi label="Filings through" value={longDate(f.newestFilingDate)} sub="newest filing date loaded" />
          <Kpi
            label="Newest mark"
            value={longDate(f.newestPrivateMark ?? null)}
            sub="the latest mark date of any private holding"
          />
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
                <td>2019Q4 through {f.latestBulkQuarter ?? '—'}, then a nightly EDGAR catch-up</td>
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
                      {num(stats.privateCompanies)} private companies, {num(stats.trackedCompanies)} tracked; plus{' '}
                      {num(stats.privateByCategory?.fund ?? 0)} fund interests, {num(stats.privateByCategory?.clo ?? 0)}{' '}
                      CLOs and {num(stats.privateByCategory?.insurance ?? 0)} insurance vehicles
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">Firms</th>
                    <td>{num(stats.firms)}</td>
                  </tr>
                </>
              )}
              {ready?.checks && (
                <>
                  <tr>
                    <th scope="row">Nightly run</th>
                    <td>
                      {runText(
                        ready.checks.nightly,
                        'smoke',
                        'hand-verified numbers checked on this site',
                        'not run yet'
                      )}
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">Monthly EDGAR check</th>
                    <td>
                      {runText(
                        ready.checks.monthly,
                        'reconcile',
                        'stored filings against EDGAR',
                        'not run yet; it runs on the 3rd of each month'
                      )}
                    </td>
                  </tr>
                </>
              )}
            </tbody>
          </table>
          {/* for whoever runs the site; a visitor does not need these (review 2026-10-15 T9) */}
          <details class="small" style={{ marginTop: 'var(--sp-3)' }}>
            <summary>Technical details</summary>
            <table class="data status-details">
              <tbody>
                {ready?.reason && (
                  <tr>
                    <th scope="row">Health check</th>
                    <td>{ready.reason}</td>
                  </tr>
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
          </details>
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

// The badge in plain words; the raw health reason stays under Technical details.
function attentionText(r: { refreshAgeHours?: number | null }, f: Freshness | null | undefined): string {
  if (f?.job && ['failed', 'interrupted'].includes(f.job.status))
    return 'The last update did not finish; showing the last good version';
  if (r.refreshAgeHours != null && r.refreshAgeHours > 48)
    return `Data is older than expected: last refresh ${ageText(r.refreshAgeHours)}`;
  return 'Not fully current';
}
