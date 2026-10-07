import { useRoute } from 'preact-iso';
import { useApi } from '../../api/client';
import type { ChangeEvent, Envelope, Freshness, FundFilings, FundInfo } from '../../api/types';
import { longDate, moneyC, num } from '../../lib/format';
import { useParam } from '../../scope/scope';
import { Badge, Card, ErrorBox, FilingRef, Kpi, Loading, Tabs, WatchButton } from '../../ui/bits';
import { ChangesTable } from '../../ui/ChangesTable';
import { DataTable } from '../../ui/DataTable';
import { BookOverview } from '../book/BookOverview';
import { MarksVsOthers } from '../book/MarksVsOthers';
import { Timeline } from '../book/Timeline';
import { Compare, Returns, XRay } from './XRay';

// One fund (P6b W3): the same layout as a firm at fund scope (its private book
// over time and the bridge, the investment timeline, marks against other
// funds), plus Fund X-Ray ported from v1 (the private book at any filing, the
// comparison with the prior quarter or year, mark-implied returns), its
// private-company changes filing by filing, and its N-PORT filings.

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'xray', label: 'X-Ray' },
  { id: 'compare', label: 'Compare' },
  { id: 'returns', label: 'Returns' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'marks', label: 'Marks vs others' },
  { id: 'changes', label: 'Changes' },
  { id: 'filings', label: 'Filings' },
];

export default function Fund() {
  const { params } = useRoute();
  const key = String(params.key ?? '');
  const [tab, setTab] = useParam('tab');
  const current = TABS.some(t => t.id === tab) ? tab : 'overview';
  const fresh = useApi<Freshness>('/api/freshness');
  const f = useApi<FundFilings>(`/api/funds/${encodeURIComponent(key)}`);
  const ch = useApi<Envelope & { fund: FundInfo; events: ChangeEvent[] }>(
    current === 'changes' ? `/api/funds/${encodeURIComponent(key)}/changes` : null
  );
  const d = f.data;
  const name = d ? d.fund.seriesName || d.fund.registrant : key;
  const newest = fresh.data?.newestReportDate ?? null;
  return (
    <div class="stack">
      <ErrorBox error={f.error} />
      {f.loading && !d && <Loading rows={4} />}
      {d && (
        <>
          <div class="page-head">
            <div>
              <div class="eyebrow">Fund</div>
              <h1>{name}</h1>
              <div class="row wrap" style={{ marginTop: '6px' }}>
                {d.fund.registrant !== d.fund.seriesName && <span class="muted">{d.fund.registrant}</span>}
                <span class="muted small mono">{d.fund.fundKey}</span>
                {d.fund.inactive && <Badge tone="warn">Stopped filing</Badge>}
              </div>
            </div>
            <span class="spacer" />
            <WatchButton kind="fund" id={d.fund.fundKey} label={name} />
          </div>
          <div class="kpis">
            <Kpi
              label="Net assets"
              value={moneyC(d.fund.lastNetAssets)}
              sub={`at ${longDate(d.fund.lastReportDate)}`}
            />
            <Kpi label="N-PORT filings" value={num(d.fund.filings)} />
            <Kpi label="First report" value={longDate(d.fund.firstReportDate)} />
            <Kpi
              label="Latest report"
              value={<FilingRef cik={d.fund.cik} accession={d.fund.lastAccession} date={d.fund.lastReportDate} />}
            />
          </div>
          <Tabs tabs={TABS} current={current} onSelect={t => setTab(t === 'overview' ? '' : t)} />
          {current === 'overview' && <BookOverview who={{ fund: d.fund.fundKey }} name={name} newest={newest} />}
          {current === 'xray' && <XRay fund={d} name={name} />}
          {current === 'compare' && <Compare fund={d} name={name} />}
          {current === 'returns' && <Returns fund={d} name={name} />}
          {current === 'timeline' && <Timeline who={{ fund: d.fund.fundKey }} name={name} />}
          {current === 'marks' && <MarksVsOthers who={{ fund: d.fund.fundKey }} name={name} newest={newest} />}
          {current === 'changes' && (
            <>
              <ErrorBox error={ch.error} />
              {ch.loading && !ch.data && <Loading rows={6} />}
              {ch.data && (
                <Card flush>
                  <ChangesTable events={ch.data.events} withCompany withFund={false} exportName={`${key}-changes`} />
                </Card>
              )}
            </>
          )}
          {current === 'filings' && (
            <Card flush>
              <DataTable
                columns={[
                  {
                    id: 'reportDate',
                    header: 'Report (mark) date',
                    value: r => r.reportDate,
                    render: r => <FilingRef cik={d.fund.cik} accession={r.accession} date={r.reportDate} />,
                    exportAs: [{ header: 'Accession', value: r => r.accession }],
                  },
                  { id: 'filingDate', header: 'Filed', value: r => r.filingDate },
                  { id: 'form', header: 'Form', value: r => r.form },
                  {
                    id: 'versions',
                    header: 'Versions',
                    value: r => r.versions,
                    num: true,
                    title: 'Filings for this report date; the latest is used',
                  },
                  {
                    id: 'netAssets',
                    header: 'Net assets',
                    value: r => r.netAssets,
                    num: true,
                    render: r => moneyC(r.netAssets),
                  },
                  { id: 'source', header: 'Source', value: r => r.source },
                ]}
                rows={d.filings}
                rowKey={r => r.accession}
                sort={{ id: 'reportDate', desc: true }}
                exportName={`${key}-filings`}
              />
            </Card>
          )}
        </>
      )}
    </div>
  );
}
