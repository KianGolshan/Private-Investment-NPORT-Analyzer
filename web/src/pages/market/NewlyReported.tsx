import { qs, useApi } from '../../api/client';
import type { Freshness, NewlyReported as Answer } from '../../api/types';
import { companyPath, fundPath, longDate, moneyC, num } from '../../lib/format';
import { ScopeBar } from '../../scope/ScopeBar';
import { isRange, useScope } from '../../scope/scope';
import { Badge, Card, ErrorBox, FilingRef, Kpi, Loading } from '../../ui/bits';
import { DataTable, type Column } from '../../ui/DataTable';

// Newly reported (P6b W4): companies whose first stored holding (any fund,
// any value) has a mark date in the range, with the funds that first reported
// it and where it stands at the end. The data starts in 2019Q4, so a company
// first seen then is never "new".

type Row = Answer['results'][number];
const addYears = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + n);
  return d.toISOString().slice(0, 10);
};

export default function NewlyReported() {
  const [scope] = useScope();
  const fresh = useApi<Freshness>('/api/freshness');
  const newest = fresh.data?.newestReportDate ?? null;
  const range = isRange(scope);
  const to = range ? scope.to : (newest ?? '');
  const from = range ? scope.from : newest ? addYears(newest, -1) : '';
  const n = useApi<Answer>(to ? `/api/market/new${qs({ from, to })}` : null);
  const d = n.data;

  const columns: Column<Row>[] = [
    {
      id: 'name',
      header: 'Company',
      value: r => r.name,
      render: r => (
        <span>
          <a href={companyPath(r.companyId, r.name)}>{r.name}</a> {r.tracked && <Badge tone="accent">Tracked</Badge>}
        </span>
      ),
      exportAs: [{ header: 'Company id', value: r => r.companyId }],
      wrap: true,
    },
    {
      id: 'first',
      header: 'First mark date',
      value: r => r.firstMarkDate,
      render: r => <FilingRef cik={r.cik} accession={r.firstAccession} date={r.firstMarkDate} />,
      exportAs: [{ header: 'First accession', value: r => r.firstAccession }],
    },
    {
      id: 'by',
      header: 'First reported by',
      value: r => r.firstFundLabel ?? r.firstFund,
      render: r => (
        <span>
          <a href={fundPath(r.firstFund)}>{r.firstFundLabel ?? r.firstFund}</a>
          {r.firstFunds > 1 && <span class="muted"> and {r.firstFunds - 1} more</span>}
        </span>
      ),
      exportAs: [
        { header: 'First fund key', value: r => r.firstFund },
        { header: 'Funds that day', value: r => r.firstFunds },
      ],
      wrap: true,
    },
    { id: 'how', header: 'As filed', value: r => r.how.join('; '), wrap: true },
    {
      id: 'firstValue',
      header: 'Value then',
      value: r => r.firstValue,
      num: true,
      render: r => moneyC(r.firstValue),
    },
    { id: 'funds', header: 'Funds at end', value: r => r.funds, num: true },
    { id: 'value', header: 'Value at end', value: r => r.value, num: true, render: r => moneyC(r.value) },
  ];

  return (
    <div class="stack">
      <div class="row wrap">
        <p class="muted" style={{ margin: 0 }}>
          {d
            ? `${d.label[0]!.toUpperCase()}${d.label.slice(1)}.`
            : 'Companies first reported by any fund in the range.'}{' '}
          Reviewed private companies only.
        </p>
        <span class="spacer" />
        <ScopeBar supports={{ range: true }} newest={newest} />
      </div>
      <ErrorBox error={n.error} />
      {n.loading && !d && <Loading rows={6} />}
      {d && (
        <>
          <div class="kpis">
            <Kpi label="Newly reported" value={num(d.count)} sub={`${longDate(d.from)} → ${longDate(d.to)}`} />
            <Kpi
              label="Value at end"
              value={moneyC(d.results.reduce((t, r) => t + r.value, 0))}
              sub={`as of ${longDate(d.to)}`}
            />
            <Kpi
              label="Largest first report"
              value={[...d.results].sort((a, b) => b.firstValue - a.firstValue)[0]?.name ?? '—'}
              sub={moneyC([...d.results].sort((a, b) => b.firstValue - a.firstValue)[0]?.firstValue)}
            />
          </div>
          <Card flush>
            <DataTable
              columns={columns}
              rows={d.results}
              rowKey={r => String(r.companyId)}
              sort={{ id: 'first', desc: true }}
              exportName={`newly-reported-${d.from}-${d.to}`}
              filterPlaceholder="Filter companies…"
              maxHeight={640}
              empty="No company was first reported in this range."
            />
          </Card>
        </>
      )}
    </div>
  );
}
