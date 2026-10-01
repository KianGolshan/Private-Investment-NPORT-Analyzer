import { useRoute } from 'preact-iso';
import { useApi } from '../api/client';
import type { ChangeEvent, Envelope, FundFilings, FundInfo } from '../api/types';
import { longDate, moneyC, num } from '../lib/format';
import { useParam } from '../scope/scope';
import { Badge, Card, ErrorBox, FilingRef, Kpi, Loading, Tabs } from '../ui/bits';
import { ChangesTable } from '../ui/ChangesTable';
import { DataTable } from '../ui/DataTable';

// One fund: its canonical N-PORT filings and its private-company changes,
// filing by filing. (The full X-Ray moves here in W3; until then it is on the
// legacy page.)

const TABS = [
  { id: 'changes', label: 'Private-company changes' },
  { id: 'filings', label: 'Filings' },
];

export default function Fund() {
  const { params } = useRoute();
  const key = String(params.key ?? '');
  const [tab, setTab] = useParam('tab');
  const current = TABS.some(t => t.id === tab) ? tab : 'changes';
  const f = useApi<FundFilings>(`/api/funds/${encodeURIComponent(key)}`);
  const ch = useApi<Envelope & { fund: FundInfo; events: ChangeEvent[] }>(
    current === 'changes' ? `/api/funds/${encodeURIComponent(key)}/changes` : null
  );
  const d = f.data;
  return (
    <div class="stack">
      <ErrorBox error={f.error} />
      {f.loading && !d && <Loading rows={4} />}
      {d && (
        <>
          <div class="page-head">
            <div>
              <div class="eyebrow">Fund</div>
              <h1>{d.fund.seriesName || d.fund.registrant}</h1>
              <div class="row wrap" style={{ marginTop: '6px' }}>
                {d.fund.registrant !== d.fund.seriesName && <span class="muted">{d.fund.registrant}</span>}
                <span class="muted small mono">{d.fund.fundKey}</span>
                {d.fund.inactive && <Badge tone="warn">Stopped filing</Badge>}
              </div>
            </div>
            <span class="spacer" />
            <a
              class="btn sm"
              href={`/legacy?tab=xray`}
              target="_top"
              title="The full X-Ray is on the legacy page until W3"
            >
              X-Ray (legacy)
            </a>
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
          <Tabs tabs={TABS} current={current} onSelect={t => setTab(t === 'changes' ? '' : t)} />
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
