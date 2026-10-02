import { useCallback, useMemo } from 'preact/hooks';
import { qs, useApi } from '../../api/client';
import type { Pivot } from '../../api/types';
import { firmPath, fundPath, moneyC, moneyDelta, num, tone } from '../../lib/format';
import { FIRST_DATE, ScopeBar } from '../../scope/ScopeBar';
import { isRange, scopeParams, useParam, useScope } from '../../scope/scope';
import { Card, Empty, ErrorBox, Loading, Segmented } from '../../ui/bits';
import { Chart } from '../../ui/Chart';
import { DataTable, type Column } from '../../ui/DataTable';
import { baseOption, type ChartTheme } from '../../ui/theme';
import { FilterPickers, useFilterOptions, type ViewProps } from './shared';

// Value over time split by firm, fund or class (the pivot, levels as of each
// period end), the funds holding, and a table of each row's change over the
// range split into position and mark effects. Brushing the chart sets the range.

type By = 'firm' | 'fund' | 'class';
type Row = Pivot['results'][number];
const TOP = 7;

export default function Overview({ base, sq, subject, name, newest }: ViewProps) {
  const [scope, setScope] = useScope();
  const [byParam, setBy] = useParam('by');
  const [perParam, setPer] = useParam('per');
  const by: By = byParam === 'fund' || byParam === 'class' ? byParam : 'firm';
  const period = perParam === 'month' ? 'month' : 'quarter';
  const opts = useFilterOptions(base, sq);
  const pivot = useApi<Pivot>(
    newest
      ? `/api/analysis/pivot${qs({ ...subject, rows: by, period, from: FIRST_DATE, to: newest, limit: 200, ...scopeParams(scope) })}`
      : null
  );
  const p = pivot.data;
  const range = isRange(scope);
  const ends = useMemo(() => p?.periods.map(x => x.to) ?? [], [p]);
  // The periods inside the range (all when none): their indexes into the pivot arrays.
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
      const from = z.startValue > 0 ? p.periods[z.startValue - 1]!.to : p.from;
      const to = p.periods[z.endValue]?.to;
      if (to && (from !== scope.from || to !== scope.to)) setScope({ from, to, asof: '' }, { replace: true });
    },
    [p, scope.from, scope.to]
  );

  const build = useCallback(
    (t: ChartTheme) => {
      const b = baseOption(t);
      const top = (p?.results ?? []).slice(0, TOP);
      const total = p?.total.value ?? [];
      const other = total.map((v, i) => v - top.reduce((s, r) => s + (r.value[i] ?? 0), 0));
      const stacked = [
        ...top.map(r => ({ name: r.label, data: r.value })),
        ...(other.some(v => v > 0.5) ? [{ name: 'Other', data: other }] : []),
      ];
      return {
        ...b,
        legend: { ...b.legend, data: [...stacked.map(s => s.name), 'Funds holding'] },
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
            itemStyle: { color: s.name === 'Other' ? t.series[7] : t.series[i % 7] },
            data: s.data,
          })),
          {
            name: 'Funds holding',
            type: 'line',
            yAxisIndex: 1,
            step: 'end',
            data: p?.total.holders ?? [],
            showSymbol: false,
            itemStyle: { color: t.text2 },
            lineStyle: { width: 1.5, type: 'dashed' },
          },
        ],
      };
    },
    [p, i0, i1]
  );

  const sum = (xs: number[]) => xs.slice(i0, i1 + 1).reduce((s, v) => s + v, 0);
  const startOf = (r: { startValue: number; value: number[] }) => (i0 > 0 ? (r.value[i0 - 1] ?? 0) : r.startValue);
  const rowLink = (r: Row) =>
    by === 'firm' && r.key !== 0 ? (
      <a href={firmPath(Number(r.key))}>{r.label}</a>
    ) : by === 'fund' ? (
      <a href={fundPath(String(r.key))}>{r.label}</a>
    ) : (
      r.label
    );
  const columns: Column<Row>[] = [
    {
      id: 'label',
      header: by === 'firm' ? 'Firm' : by === 'fund' ? 'Fund' : 'Class',
      value: r => r.label,
      render: rowLink,
      wrap: true,
    },
    { id: 'start', header: 'Value at start', value: startOf, num: true, render: r => moneyC(startOf(r)) },
    { id: 'end', header: 'Value at end', value: r => r.value[i1], num: true, render: r => moneyC(r.value[i1]) },
    { id: 'holders', header: 'Funds at end', value: r => r.holders[i1], num: true },
    {
      id: 'pos',
      header: 'Position Δ',
      value: r => sum(r.positionEffect) + sum(r.started) + sum(r.stopped) + sum(r.valueOnly),
      num: true,
      render: r => {
        const v = sum(r.positionEffect) + sum(r.started) + sum(r.stopped) + sum(r.valueOnly);
        return <span class={tone(v)}>{moneyDelta(v)}</span>;
      },
      title: 'Shares added or removed at the prior mark, funds starting or stopping filing, rows with no share count',
    },
    {
      id: 'mark',
      header: 'Mark Δ',
      value: r => sum(r.markEffect),
      num: true,
      render: r => <span class={tone(sum(r.markEffect))}>{moneyDelta(sum(r.markEffect))}</span>,
      title: 'New marks on the shares held',
    },
  ];
  const periodText = p ? `${p.periods[i0]?.label ?? ''} – ${p.periods[i1]?.label ?? ''}` : '';

  return (
    <div class="stack">
      <div class="row wrap">
        <ScopeBar
          supports={{ range: true, asof: false, filters: ['firm', 'fund', 'class', 'kind'] }}
          newest={newest}
          fundName={opts.fundName}
        />
        <FilterPickers firms={opts.firms} classes={opts.classes} kinds={opts.indirect} />
        <span class="spacer" />
        <Segmented
          label="Split by"
          value={by}
          onChange={v => setBy(v === 'firm' ? '' : v, { replace: true })}
          options={[
            { id: 'firm', label: 'Firm' },
            { id: 'fund', label: 'Fund' },
            { id: 'class', label: 'Class' },
          ]}
        />
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
      <ErrorBox error={pivot.error} />
      {(pivot.loading || !newest) && !p && <Loading rows={5} />}
      {p && (
        <>
          <Card
            title={`Value by ${by} at each ${period} end`}
            actions={
              <span class="muted small">
                as of each period end (each fund at its own mark date) · drag the slider to set the range
              </span>
            }
          >
            {p.results.length ? (
              <Chart
                build={build}
                height={360}
                label={`${name}: value by ${by} and funds holding`}
                on={{ datazoom: onZoom }}
              />
            ) : (
              <Empty>No holdings in this scope.</Empty>
            )}
          </Card>
          <Card
            title={`By ${by}, ${periodText}`}
            actions={<span class="muted small">{p.label}; firms count a co-advised fund for each</span>}
            flush
          >
            <DataTable
              columns={columns}
              rows={p.results}
              rowKey={r => String(r.key)}
              sort={{ id: 'end', desc: true }}
              exportName={`${name}-by-${by}`}
              maxHeight={480}
              totals={() => ({
                label: 'All funds',
                start: moneyC(startOf(p.total)),
                end: moneyC(p.total.value[i1]),
                holders: num(p.total.holders[i1]),
                pos: moneyDelta(
                  sum(p.total.positionEffect) + sum(p.total.started) + sum(p.total.stopped) + sum(p.total.valueOnly)
                ),
                mark: moneyDelta(sum(p.total.markEffect)),
              })}
            />
          </Card>
        </>
      )}
    </div>
  );
}
