import { useMemo } from 'preact/hooks';
import { useRoute } from 'preact-iso';
import { qs, useApi } from '../api/client';
import type { ChangeEvent, Envelope, FirmBook, Freshness } from '../api/types';
import { companyPath, fundPath, longDate, moneyC, num, price, share } from '../lib/format';
import { ScopeBar } from '../scope/ScopeBar';
import { isRange, useParam, useScope } from '../scope/scope';
import { Badge, Card, ErrorBox, FilingRef, Kpi, Loading, Tabs } from '../ui/bits';
import { ChangesTable } from '../ui/ChangesTable';
import { DataTable } from '../ui/DataTable';

// A manager's private book: every fund it advises (N-CEN adviser), as of a
// date, by company and by fund, and its funds' position changes over a range.

type Pos = FirmBook['byCompany'][number]['positions'][number] & {
  companyId: number;
  company: string;
  tracked: boolean;
};

const TABS = [
  { id: 'companies', label: 'By company' },
  { id: 'funds', label: 'By fund' },
  { id: 'changes', label: 'Changes' },
];

export default function Firm() {
  const { params } = useRoute();
  const id = Number(params.id);
  const [scope] = useScope();
  const [tab, setTab] = useParam('tab');
  const current = TABS.some(t => t.id === tab) ? tab : 'companies';
  const fresh = useApi<Freshness>('/api/freshness');
  const book = useApi<FirmBook>(Number.isInteger(id) ? `/api/firms/${id}${qs({ date: scope.asof })}` : null);
  const b = book.data;
  const newest = fresh.data?.newestReportDate ?? null;

  const positions = useMemo(
    () =>
      (b?.byCompany ?? []).flatMap(c =>
        c.positions.map(p => ({ ...p, companyId: c.companyId, company: c.name, tracked: c.tracked }))
      ),
    [b]
  );
  const companyTotals = useMemo(() => new Map((b?.byCompany ?? []).map(c => [String(c.companyId), c])), [b]);

  return (
    <div class="stack">
      <ErrorBox error={book.error} />
      {book.loading && !b && <Loading rows={4} />}
      {b && (
        <>
          <div class="page-head">
            <div>
              <div class="eyebrow">Firm</div>
              <h1>{b.firm.name}</h1>
              <p class="muted" style={{ margin: '4px 0 0' }}>
                {num(b.firm.fundsManaged)} funds advised
                {b.firm.fundsSubadvised ? `, ${num(b.firm.fundsSubadvised)} sub-advised` : ''} (current N-CEN adviser).
                Book as of {longDate(b.date)}; each fund at its own mark date.
              </p>
            </div>
          </div>
          <div class="kpis">
            <Kpi label="Private value" value={moneyC(b.value)} />
            <Kpi label="Companies" value={num(b.companies)} />
            <Kpi label="Funds holding" value={num(b.byFund.length)} />
            <Kpi label="Largest" value={b.byCompany[0]?.name ?? '—'} sub={moneyC(b.byCompany[0]?.value)} />
          </div>
          <Tabs tabs={TABS} current={current} onSelect={t => setTab(t === 'companies' ? '' : t)} />
          {current === 'companies' && (
            <>
              <ScopeBar supports={{ asof: true }} newest={newest} />
              <Card flush>
                <DataTable<Pos>
                  columns={[
                    {
                      id: 'fund',
                      header: 'Fund',
                      value: p => p.fund,
                      render: p => <a href={fundPath(p.fundKey)}>{p.fund}</a>,
                      exportAs: [
                        { header: 'Company', value: p => p.company },
                        { header: 'Fund key', value: p => p.fundKey },
                      ],
                      wrap: true,
                    },
                    {
                      id: 'markDate',
                      header: 'Mark date',
                      value: p => p.markDate,
                      render: p => <FilingRef cik={p.cik} accession={p.accession} date={p.markDate} />,
                      exportAs: [{ header: 'Accession', value: p => p.accession }],
                    },
                    {
                      id: 'class',
                      header: 'Class',
                      value: p => p.instrument,
                      render: p => (
                        <span title={p.title}>
                          {p.instrument} {p.viaSpv && <Badge tone="info">indirect</Badge>}
                        </span>
                      ),
                    },
                    {
                      id: 'shares',
                      header: 'Shares / units',
                      value: p => p.balance,
                      num: true,
                      render: p => num(p.balance),
                    },
                    {
                      id: 'price',
                      header: 'Mark',
                      value: p => p.pricePerShare ?? p.pricePerUnit,
                      num: true,
                      render: p => price(p.pricePerShare ?? p.pricePerUnit, p.unit),
                    },
                    { id: 'value', header: 'Value', value: p => p.value, num: true, render: p => moneyC(p.value) },
                    {
                      id: 'pctNav',
                      header: '% of fund',
                      value: p => p.pctNav,
                      num: true,
                      render: p => share(p.pctNav),
                    },
                  ]}
                  rows={positions}
                  rowKey={(p, i) => `${p.companyId}:${p.fundKey}:${i}`}
                  sort={{ id: 'value', desc: true }}
                  group={{
                    key: p => String(p.companyId),
                    header: k => {
                      const c = companyTotals.get(k)!;
                      return (
                        <div class="row">
                          <a href={companyPath(c.companyId, c.name) + `?firm=${id}`}>{c.name}</a>
                          {c.tracked && <Badge tone="accent">Tracked</Badge>}
                          <span class="spacer" />
                          <span class="muted small">{num(c.funds)} funds</span>
                          <span class="num" style={{ minWidth: '90px' }}>
                            {moneyC(c.value)}
                          </span>
                        </div>
                      );
                    },
                  }}
                  exportName={`${b.firm.name}-book-${b.date}`}
                  filterPlaceholder="Filter companies, funds, classes…"
                  totals={{ fund: 'Total', value: moneyC(b.value) }}
                />
              </Card>
            </>
          )}
          {current === 'funds' && (
            <>
              <ScopeBar supports={{ asof: true }} newest={newest} />
              <Card flush>
                <DataTable
                  columns={[
                    {
                      id: 'fund',
                      header: 'Fund',
                      value: f => f.label,
                      render: f => <a href={fundPath(f.fundKey)}>{f.label}</a>,
                      exportAs: [{ header: 'Fund key', value: f => f.fundKey }],
                      wrap: true,
                    },
                    {
                      id: 'markDate',
                      header: 'Mark date',
                      value: f => f.markDate,
                      render: f => <FilingRef cik={f.cik} accession={f.accession} date={f.markDate} />,
                      exportAs: [{ header: 'Accession', value: f => f.accession }],
                    },
                    { id: 'companies', header: 'Companies', value: f => f.companies, num: true },
                    {
                      id: 'value',
                      header: 'Private value',
                      value: f => f.value,
                      num: true,
                      render: f => moneyC(f.value),
                    },
                    {
                      id: 'pct',
                      header: '% of net assets',
                      value: f => (f.netAssets ? f.value / f.netAssets : null),
                      num: true,
                      render: f => share(f.netAssets ? f.value / f.netAssets : null),
                    },
                  ]}
                  rows={b.byFund}
                  rowKey={f => f.fundKey}
                  sort={{ id: 'value', desc: true }}
                  exportName={`${b.firm.name}-funds-${b.date}`}
                  filterPlaceholder="Filter funds…"
                />
              </Card>
            </>
          )}
          {current === 'changes' && <FirmChanges id={id} name={b.firm.name} newest={newest} />}
        </>
      )}
    </div>
  );
}

function FirmChanges({ id, name, newest }: { id: number; name: string; newest: string | null }) {
  const [scope] = useScope();
  const range = isRange(scope);
  const ch = useApi<Envelope & { since: string; until: string; events: ChangeEvent[] }>(
    `/api/firms/${id}/changes${qs({ since: range ? scope.from : '', until: range ? scope.to : '' })}`
  );
  return (
    <div class="stack">
      <div class="row wrap">
        <ScopeBar supports={{ range: true }} newest={newest} />
        {ch.data && (
          <span class="muted small">
            Mark dates {ch.data.since} → {ch.data.until}
          </span>
        )}
      </div>
      <ErrorBox error={ch.error} />
      {ch.loading && !ch.data && <Loading rows={6} />}
      {ch.data && (
        <Card flush>
          <ChangesTable
            events={ch.data.events}
            withCompany
            exportName={`${name}-changes-${ch.data.since}-${ch.data.until}`}
          />
        </Card>
      )}
    </div>
  );
}
