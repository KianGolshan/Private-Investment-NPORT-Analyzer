import { useCallback, useMemo } from 'preact/hooks';
import { qs, useApi } from '../api/client';
import type { Freshness, MarkIndex, Pivot, SectorLevel, SectorTotals } from '../api/types';
import { companyPath, longDate, moneyC, moneyDelta, num, sectorPath, share } from '../lib/format';
import { PAGE_TITLES, usePageTitle } from '../lib/title';
import { ScopeBar } from '../scope/ScopeBar';
import { isRange, useParam, useScope, useSetParams, windowOf } from '../scope/scope';
import { BASIS, BasisNote } from '../ui/Basis';
import { Card, ErrorBox, Loading, Segmented, TabPanel, Tabs } from '../ui/bits';
import { Chart } from '../ui/Chart';
import { DataTable } from '../ui/DataTable';
import { KnownSwitch, knownNote, useKnown } from '../ui/Known';
import { Term } from '../ui/Term';
import { baseOption, type ChartTheme } from '../ui/theme';
import { asLevel, IndexChart, IndexTable, type IndexView, LEVEL_LABEL, LEVEL_PLURAL } from './sectors/shared';

const TABS = [
  { id: 'holdings', label: 'Holdings' },
  { id: 'trends', label: 'Over time' },
  { id: 'marks', label: 'Per-share marks' },
];
const TOP = 7;

// Private operating companies by sector, industry or theme (P14, ADR 0010):
// holdings as of a date (adding up to Market's operating-company total), how
// they changed by quarter (from positions vs from marks, the bridge's split),
// and the per-share mark index.
export default function Sectors() {
  usePageTitle(PAGE_TITLES.sectors);
  const [scope] = useScope();
  const setParams = useSetParams();
  const [levelP] = useParam('level');
  const [tabP] = useParam('tab');
  const [viewP] = useParam('view');
  const level = asLevel(levelP);
  const tab = TABS.some(t => t.id === tabP) ? tabP : 'holdings';
  const view: IndexView = viewP === 'value' ? 'value' : 'typical';
  const fresh = useApi<Freshness>('/api/freshness');
  const newest = fresh.data?.newestReportDate ?? null;
  const known = useKnown(scope.asof);
  const totals = useApi<SectorTotals>(`/api/sectors${qs({ level, date: scope.asof, known: known.on })}`);
  const range = isRange(scope);
  const { from, to } = windowOf(scope, newest, 2);
  const pivot = useApi<Pivot>(
    tab === 'trends' && to
      ? `/api/analysis/pivot${qs({ rows: level, period: 'quarter', from, to, limit: 100, category: 'company' })}`
      : null
  );
  const idx = useApi<MarkIndex>(
    tab === 'marks'
      ? `/api/sectors/index${qs({ level, from: range ? scope.from : undefined, to: range ? scope.to : undefined })}`
      : null
  );
  const t = totals.data;
  const additive = level !== 'theme';

  return (
    <div class="stack">
      <div class="page-head">
        <div>
          <div class="eyebrow">Sectors</div>
          <h1>Private companies by {LEVEL_LABEL[level].toLowerCase()}</h1>
          <p class="muted" style={{ margin: '4px 0 0', maxWidth: '72ch' }}>
            Every private operating company carries one <Term id="sector">sector and industry</Term>, and any number of
            themes. These are Vantage’s reviewed labels: N-PORT has no industry field.{' '}
            {t && (
              <>
                As of {longDate(t.date)}, {num(t.companies)} companies hold {moneyC(t.totalValue)} in funds
                {additive ? ', the same total as Market' : '; a company can carry several themes, so themes overlap'}
                .{' '}
              </>
            )}
            {knownNote(scope.asof, known.on)}
          </p>
          <BasisNote />
        </div>
        <span class="spacer" />
        {tab === 'holdings' && <KnownSwitch asof={scope.asof} />}
        <ScopeBar supports={tab === 'holdings' ? { asof: true } : { range: true }} newest={newest} />
      </div>
      <div class="row wrap">
        <Segmented
          label="Group by"
          value={level}
          onChange={v => setParams({ level: v === 'sector' ? '' : v })}
          options={[
            { id: 'sector', label: 'Sectors' },
            { id: 'industry', label: 'Industries' },
            { id: 'theme', label: 'Themes', title: 'Themes overlap: a company can carry several' },
          ]}
        />
        {tab === 'marks' && (
          <Segmented
            label="Index"
            value={view}
            onChange={v => setParams({ view: v === 'typical' ? '' : v })}
            options={[
              {
                id: 'typical',
                label: 'Average company',
                title: 'Each company counts the same; the most extreme 5% at each end are capped',
              },
              { id: 'value', label: 'Value-weighted', title: 'Each company weighted by its value at the start' },
            ]}
          />
        )}
      </div>
      <Tabs id="sectors" tabs={TABS} current={tab} onSelect={id => setParams({ tab: id === 'holdings' ? '' : id })} />
      <TabPanel id="sectors" current={tab}>
        {tab === 'holdings' && <Holdings totals={totals} level={level} known={known.on} asof={scope.asof} />}
        {tab === 'trends' && <Trends pivot={pivot} level={level} />}
        {tab === 'marks' && (
          <>
            <ErrorBox error={idx.error} />
            {idx.loading && !idx.data && <Loading rows={6} />}
            {idx.data && (
              <>
                <p class="muted small" style={{ margin: 0 }}>
                  <Term id="markIndex">Per-share marks</Term> from {longDate(idx.data.from)} to {longDate(idx.data.to)}{' '}
                  (newest mark {longDate(idx.data.newestMark)}). Start = 100. A period after the newest mark, or cut by
                  the window, is partial: funds that report later may still move it.
                </p>
                <Card flush>
                  <div style={{ padding: '12px 12px 0' }}>
                    <IndexChart
                      idx={idx.data}
                      view={view}
                      label={`Per-share mark index by ${LEVEL_LABEL[level].toLowerCase()}, ${view === 'value' ? 'value-weighted' : 'average company'}`}
                    />
                  </div>
                  {idx.data.groups.length > 8 && (
                    <p class="muted small" style={{ margin: '4px 12px 0' }}>
                      The chart draws the 8 {LEVEL_PLURAL[level].toLowerCase()} with the most companies measured; the
                      table has all {num(idx.data.groups.length)}.
                    </p>
                  )}
                  <IndexTable
                    idx={idx.data}
                    level={level}
                    exportName={`mark-index-${level}-${idx.data.from}-${idx.data.to}`}
                  />
                </Card>
              </>
            )}
          </>
        )}
      </TabPanel>
    </div>
  );
}

function Holdings({
  totals,
  level,
  known,
  asof,
}: {
  totals: { data: SectorTotals | null; error: Error | null; loading: boolean };
  level: SectorLevel;
  known: boolean;
  asof: string;
}) {
  const t = totals.data;
  const groups = useMemo(() => t?.groups ?? [], [t]);
  const build = useCallback(
    (th: ChartTheme) => {
      const b = baseOption(th);
      const shown = groups.slice(0, 16).reverse();
      return {
        ...b,
        grid: { ...b.grid, left: 8, right: 24 },
        legend: { show: false },
        tooltip: { ...b.tooltip, trigger: 'item', valueFormatter: (v: number) => moneyC(v) },
        xAxis: { type: 'value', ...b.xAxisDefaults, axisLabel: { ...b.xAxisDefaults.axisLabel, formatter: moneyC } },
        yAxis: { type: 'category', data: shown.map(g => g.label), ...b.yAxisDefaults },
        series: [
          {
            type: 'bar',
            data: shown.map(g => ({
              value: g.value,
              itemStyle: { color: g.key === 'unclassified' ? th.text3 : th.series[0] },
            })),
            barMaxWidth: 18,
          },
        ],
      };
    },
    [groups]
  );
  return (
    <>
      <ErrorBox error={totals.error} />
      {totals.loading && !t && <Loading rows={8} />}
      {t && (
        <Card flush>
          <div style={{ padding: '12px 12px 0' }}>
            <Chart
              build={build}
              height={Math.max(220, Math.min(16, groups.length) * 26 + 40)}
              label={`Private holdings by ${LEVEL_LABEL[level].toLowerCase()} as of ${longDate(t.date)}`}
            />
          </div>
          <DataTable
            basis={`${BASIS}. Operating companies. ${knownNote(asof, known)} Labels: Vantage taxonomy ${t.taxonomyVersion}${t.additive ? '' : '; themes overlap and do not add up'}.`}
            source={t}
            columns={[
              {
                id: 'label',
                header: LEVEL_LABEL[level],
                value: g => g.label,
                render: g => <a href={sectorPath(level, g.key) + qs({ asof: asof || undefined })}>{g.label}</a>,
                exportAs: [{ header: 'Code', value: g => g.key }],
                wrap: true,
              },
              { id: 'value', header: 'Held by funds', value: g => g.value, num: true, render: g => moneyC(g.value) },
              ...(t.additive
                ? [
                    {
                      id: 'share',
                      header: 'Share of total',
                      value: (g: SectorTotals['groups'][number]) => g.share,
                      num: true,
                      render: (g: SectorTotals['groups'][number]) => share(g.share, 1),
                    },
                  ]
                : []),
              { id: 'companies', header: 'Companies', value: g => g.companies, num: true },
              {
                id: 'top',
                header: 'Largest',
                value: g => g.top.map(c => c.name).join(', '),
                render: g => (
                  <span>
                    {g.top.map((c, i) => (
                      <span key={c.companyId}>
                        {i > 0 && ', '}
                        <a href={companyPath(c.companyId, c.name)}>{c.name}</a>
                      </span>
                    ))}
                  </span>
                ),
                wrap: true,
                noSort: true,
              },
            ]}
            rows={groups}
            rowKey={g => g.key}
            sort={{ id: 'value', desc: true }}
            exportName={`holdings-by-${level}-${t.date}${t.knownAsOf ? '-known' : ''}`}
            totals={rs =>
              t.additive
                ? {
                    label: `${num(rs.length)} ${LEVEL_PLURAL[level].toLowerCase()}`,
                    value: moneyC(rs.reduce((s, g) => s + g.value, 0)),
                  }
                : { label: `${num(rs.length)} themes (overlapping)` }
            }
          />
        </Card>
      )}
    </>
  );
}

function Trends({
  pivot,
  level,
}: {
  pivot: { data: Pivot | null; error: Error | null; loading: boolean };
  level: SectorLevel;
}) {
  const p = pivot.data;
  const rows = useMemo(() => p?.results ?? [], [p]);
  const build = useCallback(
    (th: ChartTheme) => {
      const b = baseOption(th);
      const top = rows.slice(0, TOP);
      const total = p?.total.value ?? [];
      const additive = p?.additive !== false;
      const other = total.map((v, i) => v - top.reduce((s, r) => s + (r.value[i] ?? 0), 0));
      const series = [
        ...top.map(r => ({ name: r.label, data: r.value })),
        ...(additive && other.some(v => v > 0.5) ? [{ name: 'Other', data: other }] : []),
      ];
      return {
        ...b,
        legend: { ...b.legend, data: series.map(s => s.name) },
        tooltip: { ...b.tooltip, valueFormatter: (v: number) => moneyC(v) },
        xAxis: { type: 'category', data: p?.periods.map(x => x.label) ?? [], boundaryGap: false, ...b.xAxisDefaults },
        yAxis: { type: 'value', ...b.yAxisDefaults, axisLabel: { ...b.yAxisDefaults.axisLabel, formatter: moneyC } },
        series: series.map((s, i) => ({
          name: s.name,
          type: 'line',
          ...(additive ? { stack: 'value', areaStyle: { opacity: 0.55 } } : {}),
          showSymbol: false,
          lineStyle: { width: additive ? 1 : 2 },
          itemStyle: { color: s.name === 'Other' ? th.series[7] : th.series[i % 7] },
          data: s.data,
        })),
      };
    },
    [p, rows]
  );
  type Row = Pivot['results'][number];
  const sum = (xs: number[]) => xs.reduce((s, v) => s + v, 0);
  const endOf = (r: Row) => r.value[r.value.length - 1] ?? 0;
  // funds that started or stopped filing, rows with no share count: the rest of the change
  const otherOf = (r: Row) => endOf(r) - r.startValue - sum(r.positionEffect) - sum(r.markEffect);
  return (
    <>
      <ErrorBox error={pivot.error} />
      {pivot.loading && !p && <Loading rows={8} />}
      {p && (
        <>
          <p class="muted small" style={{ margin: 0 }}>
            Value held at each quarter end, and what changed it: <Term id="fromPositions" /> (funds’ shares first
            reported, added, reduced or no longer reported, at the prior mark) and <Term id="fromMarks" /> (new marks on
            the shares held). {longDate(p.from)} to {longDate(p.to)}.
            {p.additive === false && ' Themes overlap, so they are drawn as lines and do not add up.'}
          </p>
          <Card flush>
            <div style={{ padding: '12px 12px 0' }}>
              <Chart build={build} label={`Private holdings by ${LEVEL_LABEL[level].toLowerCase()} by quarter`} />
            </div>
            <DataTable<Row>
              basis={`${BASIS}. Operating companies. Levels as of each quarter end; changes in filings with mark dates in each quarter.`}
              source={p}
              columns={[
                {
                  id: 'label',
                  header: LEVEL_LABEL[level],
                  value: r => r.label,
                  render: r => <a href={sectorPath(level, String(r.key))}>{r.label}</a>,
                  exportAs: [{ header: 'Code', value: r => r.key }],
                  wrap: true,
                },
                {
                  id: 'start',
                  header: `Held ${p.from}`,
                  value: r => r.startValue,
                  num: true,
                  render: r => moneyC(r.startValue),
                },
                {
                  id: 'end',
                  header: `Held ${p.to}`,
                  value: endOf,
                  num: true,
                  render: r => moneyC(endOf(r)),
                },
                {
                  id: 'positions',
                  header: 'From positions',
                  value: r => sum(r.positionEffect),
                  num: true,
                  render: r => moneyDelta(sum(r.positionEffect)),
                },
                {
                  id: 'marks',
                  header: 'From marks',
                  value: r => sum(r.markEffect),
                  num: true,
                  render: r => moneyDelta(sum(r.markEffect)),
                },
                {
                  id: 'other',
                  header: 'Other changes',
                  title: 'Funds that started or stopped filing, and rows with no share count',
                  value: otherOf,
                  num: true,
                  render: r => moneyDelta(otherOf(r)),
                },
              ]}
              rows={rows}
              rowKey={r => String(r.key)}
              sort={{ id: 'end', desc: true }}
              exportName={`holdings-by-${level}-by-quarter-${p.from}-${p.to}`}
            />
          </Card>
          <p class="muted small" style={{ margin: 0 }}>
            Each quarter’s detail, and the filings behind any cell, are in{' '}
            <a href={`/explore${qs({ rows: level, from: p.from, to: p.to })}`}>Explore</a>.
          </p>
        </>
      )}
    </>
  );
}
