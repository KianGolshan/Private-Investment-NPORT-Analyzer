import { BASIS, BasisNote } from '../ui/Basis';
import { lazy } from 'preact-iso';
import { useCallback } from 'preact/hooks';
import { qs, useApi } from '../api/client';
import type { Freshness, TopCompanies } from '../api/types';
import { companyPath, longDate, moneyC, num } from '../lib/format';
import { ScopeBar } from '../scope/ScopeBar';
import { useParam, useScope } from '../scope/scope';
import { Card, Empty, ErrorBox, Kpi, Loading, Tabs } from '../ui/bits';
import { CategoryBadge, CategorySwitch, useCategoryFilter } from '../ui/Category';
import { Chart } from '../ui/Chart';
import { DataTable, type Column } from '../ui/DataTable';
import type { ChartTheme } from '../ui/theme';
import { baseOption } from '../ui/theme';
import { usePageTitle } from '../lib/title';
import { Term } from '../ui/Term';

type Row = TopCompanies['results'][number];

function Top() {
  const [scope] = useScope();
  const fresh = useApi<Freshness>('/api/freshness');
  const cat = useCategoryFilter();
  const top = useApi<TopCompanies>(`/api/market/top${qs({ date: scope.asof, limit: 300, category: cat.category })}`);
  const noun = cat.all ? 'private holdings' : 'private companies';
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
          <CategoryBadge category={r.category} />
        </span>
      ),
      exportAs: [
        { header: 'Company id', value: r => r.companyId },
        { header: 'Category', value: r => r.category },
      ],
    },
    { id: 'funds', header: 'Funds', value: r => r.funds, num: true },
    { id: 'value', header: 'Value', value: r => r.value, num: true, render: r => moneyC(r.value) },
    {
      id: 'indirect',
      header: 'Held indirectly',
      title: 'The part held through a named SPV (special purpose vehicle) or as an interest in another fund',
      value: r => r.indirectValue,
      num: true,
      render: r => (r.indirectValue ? moneyC(r.indirectValue) : <span class="muted">—</span>),
    },
    {
      id: 'marks',
      header: 'Fund mark dates',
      title: 'The oldest and newest mark dates among the funds counted: each fund reports on its own calendar',
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
          <Term id="asOf">As of</Term> {scope.asof ? longDate(scope.asof) : 'the newest filings'}: each fund's latest{' '}
          <Term id="nport">N-PORT</Term> report on or before that date. Funds report on staggered fiscal quarters, so{' '}
          <Term id="markDate">mark dates</Term> differ by fund.
        </p>
        <span class="spacer" />
        <CategorySwitch />
        <ScopeBar supports={{ asof: true }} newest={fresh.data?.newestReportDate ?? null} />
      </div>
      <BasisNote />
      <ErrorBox error={top.error} />
      {top.loading && !d && <Loading rows={6} />}
      {d && (
        <>
          <div class="kpis">
            <Kpi
              label={cat.all ? 'Private holdings' : 'Private companies'}
              value={num(d.companies)}
              sub={cat.all ? 'companies, fund interests, CLOs, insurance vehicles' : 'operating companies'}
            />
            <Kpi label="Value held" value={moneyC(d.totalValue)} sub="at each fund’s latest mark, incl. through SPVs" />
            <Kpi label="Largest" value={d.results[0]?.name ?? '—'} sub={moneyC(d.results[0]?.value)} />
            <Kpi
              label="Data as of"
              value={longDate(scope.asof || d.date)}
              sub={
                d.newestMark
                  ? `each fund at its own mark date; newest mark ${longDate(d.newestMark)}`
                  : 'each fund at its own mark date'
              }
            />
          </div>
          <div class="grid-2">
            <Card title="Top 15 by value">
              {d.results.length ? (
                <Chart build={build} height={420} label={`Top 15 ${noun} by value`} />
              ) : (
                <Empty>None.</Empty>
              )}
            </Card>
            <Card title={cat.all ? 'All private holdings' : 'Operating companies'} flush>
              <DataTable
                basis={BASIS}
                source={d}
                columns={columns}
                rows={d.results}
                rowKey={r => String(r.companyId)}
                sort={{ id: 'value', desc: true }}
                exportName={`private-${cat.all ? 'holdings' : 'companies'}-${scope.asof || 'latest'}`}
                filterPlaceholder="Filter by name…"
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
  usePageTitle(null);
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
          <p class="lede">
            Which mutual funds and ETFs hold stakes in private companies, what each fund says a share is worth (its{' '}
            <Term id="mark">mark</Term>), and how that changed, from the holdings reports funds file with the SEC.
          </p>
          <p class="small muted try">
            Try: <a href="/company/1-anthropic?tab=holders">who holds Anthropic</a> ·{' '}
            <a href="/company/5-stripe?tab=marks">how funds mark Stripe</a> ·{' '}
            <a href="/?view=movers">the biggest mark moves this year</a> ·{' '}
            <a href="/firm/9">Capital Group's private book</a>
          </p>
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
