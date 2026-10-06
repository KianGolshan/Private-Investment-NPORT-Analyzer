import { lazy } from 'preact-iso';
import { useCallback } from 'preact/hooks';
import { qs, useApi } from '../api/client';
import type { Freshness, TopCompanies } from '../api/types';
import { companyPath, longDate, moneyC, num } from '../lib/format';
import { ScopeBar } from '../scope/ScopeBar';
import { useParam, useScope } from '../scope/scope';
import { Badge, Card, Empty, ErrorBox, Kpi, Loading, Tabs } from '../ui/bits';
import { Chart } from '../ui/Chart';
import { DataTable, type Column } from '../ui/DataTable';
import type { ChartTheme } from '../ui/theme';
import { baseOption } from '../ui/theme';

type Row = TopCompanies['results'][number];

function Top() {
  const [scope] = useScope();
  const fresh = useApi<Freshness>('/api/freshness');
  const top = useApi<TopCompanies>(`/api/market/top${qs({ date: scope.asof, limit: 300 })}`);
  const d = top.data;

  const build = useCallback(
    (t: ChartTheme) => {
      const rows = (d?.results ?? []).slice(0, 15).reverse();
      const b = baseOption(t);
      return {
        ...b,
        tooltip: { ...b.tooltip, trigger: 'item', valueFormatter: (v: number) => moneyC(v) },
        grid: { ...b.grid, left: 8, right: 24, top: 8 },
        xAxis: { type: 'value', ...b.xAxisDefaults, axisLabel: { ...b.xAxisDefaults.axisLabel, formatter: moneyC } },
        yAxis: { type: 'category', data: rows.map(r => r.name), ...b.yAxisDefaults, axisLabel: { color: t.text2 } },
        series: [
          {
            type: 'bar',
            name: 'Direct',
            stack: 'v',
            data: rows.map(r => r.value - r.indirectValue),
            itemStyle: { color: t.series[0] },
          },
          {
            type: 'bar',
            name: 'Indirect (SPV)',
            stack: 'v',
            data: rows.map(r => r.indirectValue),
            itemStyle: { color: t.series[1] },
          },
        ],
        legend: { ...b.legend, show: true, top: 'bottom' },
      };
    },
    [d]
  );

  const columns: Column<Row>[] = [
    { id: 'rank', header: '#', value: r => r.rank, num: true, width: '48px' },
    {
      id: 'name',
      header: 'Company',
      value: r => r.name,
      render: r => (
        <span>
          <a href={companyPath(r.companyId, r.name) + (scope.asof ? `?asof=${scope.asof}` : '')}>{r.name}</a>{' '}
          {r.tracked && <Badge tone="accent">Tracked</Badge>}
        </span>
      ),
      exportAs: [{ header: 'Company id', value: r => r.companyId }],
    },
    { id: 'funds', header: 'Funds', value: r => r.funds, num: true },
    { id: 'value', header: 'Value', value: r => r.value, num: true, render: r => moneyC(r.value) },
    {
      id: 'indirect',
      header: 'Of which indirect',
      title: 'Held through a named SPV or as a fund interest',
      value: r => r.indirectValue,
      num: true,
      render: r => (r.indirectValue ? moneyC(r.indirectValue) : <span class="muted">—</span>),
    },
    {
      id: 'marks',
      header: 'Mark dates',
      value: r => r.newestMark,
      render: r => (
        <span class="small">{r.oldestMark === r.newestMark ? r.newestMark : `${r.oldestMark} … ${r.newestMark}`}</span>
      ),
      exportAs: [{ header: 'Oldest mark', value: r => r.oldestMark }],
    },
  ];

  return (
    <div class="stack">
      <div class="row wrap">
        <p class="muted" style={{ margin: 0 }}>
          As of {scope.asof ? longDate(scope.asof) : 'the newest filings'}: each fund's latest N-PORT on or before that
          date. Funds report on staggered fiscal quarters, so mark dates differ by fund.
        </p>
        <span class="spacer" />
        <ScopeBar supports={{ asof: true }} newest={fresh.data?.newestReportDate ?? null} />
      </div>
      <ErrorBox error={top.error} />
      {top.loading && !d && <Loading rows={6} />}
      {d && (
        <>
          <div class="kpis">
            <Kpi label="Private companies" value={num(d.companies)} />
            <Kpi label="Value held" value={moneyC(d.totalValue)} sub="direct and through SPVs" />
            <Kpi label="Largest" value={d.results[0]?.name ?? '—'} sub={moneyC(d.results[0]?.value)} />
            <Kpi label="As of" value={scope.asof ? longDate(scope.asof) : 'Latest'} />
          </div>
          <div class="grid-2">
            <Card title="Top 15 by value">
              {d.results.length ? (
                <Chart build={build} height={420} label="Top 15 private companies by value" />
              ) : (
                <Empty>None.</Empty>
              )}
            </Card>
            <Card title="All private companies" flush>
              <DataTable
                columns={columns}
                rows={d.results}
                rowKey={r => String(r.companyId)}
                sort={{ id: 'value', desc: true }}
                exportName={`private-companies-${scope.asof || 'latest'}`}
                filterPlaceholder="Filter companies…"
                maxHeight={420}
              />
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

const lazyMovers = lazy(() => import('./market/Movers'));
const lazyNew = lazy(() => import('./market/NewlyReported'));

// Market (P6b W4): the top private companies as of a date, the movers over a
// range (largest mark moves and net position flows) and the companies first
// reported in a range.
export default function Market() {
  const [view, setView] = useParam('view');
  const current = view === 'movers' || view === 'new' ? view : 'top';
  const Movers = lazyMovers;
  const New = lazyNew;
  return (
    <div class="stack">
      <div class="page-head">
        <div>
          <div class="eyebrow">Market</div>
          <h1>Private companies held by registered funds</h1>
        </div>
      </div>
      <Tabs
        tabs={[
          { id: 'top', label: 'Top companies' },
          { id: 'movers', label: 'Movers' },
          { id: 'new', label: 'Newly reported' },
        ]}
        current={current}
        onSelect={id => setView(id === 'top' ? '' : id)}
      />
      {current === 'top' && <Top />}
      {current === 'movers' && <Movers />}
      {current === 'new' && <New />}
    </div>
  );
}
