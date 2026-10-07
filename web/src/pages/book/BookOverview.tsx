import { BASIS } from '../../ui/Basis';
import { useCallback, useMemo } from 'preact/hooks';
import { qs, useApi } from '../../api/client';
import type { Bridge, Pivot } from '../../api/types';
import { companyPath, moneyC, moneyDelta, num, tone } from '../../lib/format';
import { FIRST_DATE, ScopeBar } from '../../scope/ScopeBar';
import { isRange, useParam, useScope } from '../../scope/scope';
import { Card, Empty, ErrorBox, Loading, Segmented } from '../../ui/bits';
import { BridgeView, PeriodEffects } from '../../ui/BridgeView';
import { Chart } from '../../ui/Chart';
import { DataTable, type Column } from '../../ui/DataTable';
import { baseOption, type ChartTheme } from '../../ui/theme';

// A firm's or fund's private book over time (P6b W3): value by company at each
// quarter or month end (levels as of each period end), how many companies and
// funds, then the bridge for the range (default: the year to the newest mark
// date) and position vs mark effect by period. Brushing the chart sets the range.

export type Who = { firm: number } | { fund: string };

type Row = Pivot['results'][number];
const TOP = 7;
const addYears = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + n);
  return d.toISOString().slice(0, 10);
};

export function BookOverview({ who, name, newest }: { who: Who; name: string; newest: string | null }) {
  const [scope, setScope] = useScope();
  const [perParam, setPer] = useParam('per');
  const period = perParam === 'month' ? 'month' : 'quarter';
  const range = isRange(scope);
  const pivot = useApi<Pivot>(
    newest
      ? `/api/analysis/pivot${qs({ ...who, rows: 'company', period, from: FIRST_DATE, to: newest, limit: 1000 })}`
      : null
  );
  const to = range ? scope.to : (newest ?? '');
  const from = range ? scope.from : newest ? addYears(newest, -1) : '';
  const bridge = useApi<Bridge>(to ? `/api/analysis/bridge${qs({ ...who, from, to })}` : null);
  const effects = useApi<Pivot>(
    to ? `/api/analysis/pivot${qs({ ...who, rows: 'company', period: 'quarter', from, to, limit: 1 })}` : null
  );
  const p = pivot.data;
  const ends = useMemo(() => p?.periods.map(x => x.to) ?? [], [p]);
  const [i0, i1] = useMemo(() => {
    if (!ends.length) return [0, -1];
    if (!range) return [0, ends.length - 1];
    const a = ends.findIndex(d => d > scope.from);
    let b = ends.findIndex(d => d > scope.to) - 1;
    if (b < 0) b = ends.length - 1;
    return [Math.max(0, a), b];
  }, [ends, range, scope.from, scope.to]);

  const onZoom = useCallback(
    (_p: unknown, chart: { getOption: () => unknown }) => {
      const opt = chart.getOption() as { dataZoom?: { startValue?: number; endValue?: number }[] };
      const z = opt.dataZoom?.[0];
      if (!z || z.startValue == null || z.endValue == null || !p) return;
      const f = z.startValue > 0 ? p.periods[z.startValue - 1]!.to : p.from;
      const t = p.periods[z.endValue]?.to;
      if (t && (f !== scope.from || t !== scope.to)) setScope({ from: f, to: t, asof: '' }, { replace: true });
    },
    [p, scope.from, scope.to]
  );

  // Companies held at each period end (any value).
  const companies = useMemo(
    () => (p ? p.periods.map((_, i) => p.results.filter(r => (r.value[i] ?? 0) > 0).length) : []),
    [p]
  );

  const build = useCallback(
    (t: ChartTheme) => {
      const b = baseOption(t);
      const top = (p?.results ?? []).slice(0, TOP);
      const total = p?.total.value ?? [];
      const other = total.map((v, i) => v - top.reduce((s, r) => s + (r.value[i] ?? 0), 0));
      const stacked = [
        ...top.map(r => ({ name: r.label, data: r.value })),
        ...(other.some(v => v > 0.5) ? [{ name: 'Other companies', data: other }] : []),
      ];
      return {
        ...b,
        legend: { ...b.legend, data: [...stacked.map(s => s.name), 'Companies held', 'Funds holding'] },
        grid: { ...b.grid, bottom: 48 },
        tooltip: { ...b.tooltip, valueFormatter: (v: number) => (Math.abs(v) > 10000 ? moneyC(v) : num(v)) },
        xAxis: { type: 'category', data: p?.periods.map(x => x.label) ?? [], boundaryGap: false, ...b.xAxisDefaults },
        yAxis: [
          { type: 'value', ...b.yAxisDefaults, axisLabel: { ...b.yAxisDefaults.axisLabel, formatter: moneyC } },
          { type: 'value', ...b.yAxisDefaults, splitLine: { show: false }, minInterval: 1 },
        ],
        dataZoom: [
          { type: 'slider', startValue: i0, endValue: i1, height: 22, bottom: 6 },
          { type: 'inside', startValue: i0, endValue: i1 },
        ],
        series: [
          ...stacked.map((s, i) => ({
            name: s.name,
            type: 'line',
            stack: 'value',
            areaStyle: { opacity: 0.55 },
            showSymbol: false,
            lineStyle: { width: 1 },
            itemStyle: { color: s.name === 'Other companies' ? t.series[7] : t.series[i % 7] },
            data: s.data,
          })),
          {
            name: 'Companies held',
            type: 'line',
            yAxisIndex: 1,
            step: 'end',
            data: companies,
            showSymbol: false,
            itemStyle: { color: t.text2 },
            lineStyle: { width: 1.5, type: 'dashed' },
          },
          {
            name: 'Funds holding',
            type: 'line',
            yAxisIndex: 1,
            step: 'end',
            data: p?.total.holders ?? [],
            showSymbol: false,
            itemStyle: { color: t.text3 },
            lineStyle: { width: 1, type: 'dotted' },
          },
        ],
      };
    },
    [p, i0, i1, companies]
  );

  const sum = (xs: number[]) => xs.slice(i0, i1 + 1).reduce((s, v) => s + v, 0);
  const startOf = (r: { startValue: number; value: number[] }) => (i0 > 0 ? (r.value[i0 - 1] ?? 0) : r.startValue);
  const posOf = (r: Row | Pivot['total']) => sum(r.positionEffect) + sum(r.started) + sum(r.stopped) + sum(r.valueOnly);
  const firmQ = 'firm' in who ? `?firm=${who.firm}` : `?fund=${encodeURIComponent(who.fund)}`;
  const columns: Column<Row>[] = [
    {
      id: 'label',
      header: 'Company',
      value: r => r.label,
      render: r => <a href={companyPath(Number(r.key), r.label) + firmQ}>{r.label}</a>,
      wrap: true,
    },
    { id: 'start', header: 'Value at start', value: startOf, num: true, render: r => moneyC(startOf(r)) },
    { id: 'end', header: 'Value at end', value: r => r.value[i1], num: true, render: r => moneyC(r.value[i1]) },
    { id: 'holders', header: 'Funds at end', value: r => r.holders[i1], num: true },
    {
      id: 'pos',
      header: 'Position Δ',
      value: posOf,
      num: true,
      render: r => <span class={tone(posOf(r))}>{moneyDelta(posOf(r))}</span>,
      title: 'First reported, added, reduced, no longer reported, funds starting or stopping filing',
    },
    {
      id: 'mark',
      header: 'Mark Δ',
      value: r => sum(r.markEffect),
      num: true,
      render: r => <span class={tone(sum(r.markEffect))}>{moneyDelta(sum(r.markEffect))}</span>,
    },
  ];
  const rows = useMemo(
    () => (p?.results ?? []).filter(r => startOf(r) || r.value[i1] || posOf(r) || sum(r.markEffect)),
    [p, i0, i1]
  );

  return (
    <div class="stack">
      <div class="row wrap">
        <ScopeBar supports={{ range: true, asof: false }} newest={newest} />
        <span class="spacer" />
        <Segmented
          label="Period"
          value={period}
          onChange={v => setPer(v === 'quarter' ? '' : v, { replace: true })}
          options={[
            { id: 'quarter', label: 'Quarter' },
            { id: 'month', label: 'Month' },
          ]}
        />
      </div>
      <ErrorBox error={pivot.error || bridge.error} />
      {(pivot.loading || !newest) && !p && <Loading rows={5} />}
      {p && (
        <Card
          title={`Private book by company at each ${period} end`}
          actions={
            <span class="muted small">
              as of each period end, each fund at its own mark date · drag to set the range
            </span>
          }
        >
          {p.results.length ? (
            <Chart build={build} height={360} label={`${name}: private book by company`} on={{ datazoom: onZoom }} />
          ) : (
            <Empty>No private-company holdings.</Empty>
          )}
        </Card>
      )}
      {!range && (
        <span class="muted small">
          The bridge covers the year to the newest mark date; drag the chart or pick a range.
        </span>
      )}
      {bridge.data && <BridgeView bridge={bridge.data} name={name} />}
      {effects.data && <PeriodEffects pivot={effects.data} name={name} />}
      {p && (
        <Card title={`By company, ${p.periods[i0]?.label ?? ''} – ${p.periods[i1]?.label ?? ''}`} flush>
          <DataTable
            basis={BASIS}
            source={p}
            columns={columns}
            rows={rows}
            rowKey={r => String(r.key)}
            sort={{ id: 'end', desc: true }}
            exportName={`${name}-book-by-company`}
            maxHeight={520}
            totals={() => ({
              label: 'All companies',
              start: moneyC(startOf(p.total)),
              end: moneyC(p.total.value[i1]),
              holders: num(p.total.holders[i1]),
              pos: moneyDelta(posOf(p.total)),
              mark: moneyDelta(sum(p.total.markEffect)),
            })}
          />
        </Card>
      )}
    </div>
  );
}
