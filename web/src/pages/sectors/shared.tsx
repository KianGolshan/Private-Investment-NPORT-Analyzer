import type { MarkIndex, SectorLevel } from '../../api/types';
import { longDate, num, pct, sectorPath, share } from '../../lib/format';
import { Chart } from '../../ui/Chart';
import { DataTable } from '../../ui/DataTable';
import { baseOption, type ChartTheme } from '../../ui/theme';

export const LEVEL_LABEL: Record<SectorLevel, string> = { sector: 'Sector', industry: 'Industry', theme: 'Theme' };
export const LEVEL_PLURAL: Record<SectorLevel, string> = { sector: 'Sectors', industry: 'Industries', theme: 'Themes' };
export const asLevel = (v: string): SectorLevel => (v === 'industry' || v === 'theme' ? v : 'sector');

/** A signed percent from an index ratio (110 -> +10.0%). */
export const indexPct = (v: number | null | undefined) => (v == null ? '—' : pct(v - 100, 1));
const signedPct = (v: number | null | undefined) => (v == null ? '—' : pct(v * 100, 1));

export type IndexView = 'typical' | 'value';

/** Index lines for several groups, typical company (median) or value-weighted. */
export function IndexChart({
  idx,
  view,
  keys,
  label,
  band = false,
}: {
  idx: MarkIndex;
  view: IndexView;
  keys?: string[];
  label: string;
  /** One group: show its 25th-75th percentile band. */
  band?: boolean;
}) {
  const groups = idx.groups.filter(g => !keys || keys.includes(g.key)).slice(0, 8);
  const dates = groups[0]?.points.map(p => p.label) ?? [];
  const build = (t: ChartTheme) => {
    const b = baseOption(t);
    const pick = (p: MarkIndex['groups'][number]['points'][number]) => (view === 'value' ? p.valueIndex : p.index);
    const g0 = groups[0];
    const bandSeries =
      band && g0 && view === 'typical'
        ? [
            {
              name: '25th percentile',
              type: 'line',
              data: g0.points.map(p => p.p25),
              lineStyle: { opacity: 0 },
              stack: 'band',
              symbol: 'none',
              itemStyle: { color: t.series[0] },
            },
            {
              name: '25th–75th percentile',
              type: 'line',
              data: g0.points.map(p => (p.p75 != null && p.p25 != null ? p.p75 - p.p25 : null)),
              lineStyle: { opacity: 0 },
              areaStyle: { opacity: 0.15, color: t.series[0] },
              stack: 'band',
              symbol: 'none',
              tooltip: { show: false },
            },
          ]
        : [];
    return {
      ...b,
      legend: { ...b.legend, data: groups.map(g => g.label) },
      tooltip: { ...b.tooltip, valueFormatter: (v: number) => (v == null ? '—' : v.toFixed(1)) },
      xAxis: { type: 'category', data: dates, boundaryGap: false, ...b.xAxisDefaults },
      yAxis: { type: 'value', scale: true, ...b.yAxisDefaults, name: 'start = 100' },
      series: [
        ...bandSeries,
        ...groups.map((g, i) => ({
          name: g.label,
          type: 'line',
          data: g.points.map(pick),
          connectNulls: false,
          showSymbol: true,
          symbolSize: 5,
          itemStyle: { color: t.series[i % 8] },
          lineStyle: { width: 2 },
        })),
      ],
    };
  };
  return <Chart build={build} label={label} height={300} />;
}

/** The index's numbers, one row per group and date (the chart's table twin). */
export function IndexTable({ idx, level, exportName }: { idx: MarkIndex; level: SectorLevel; exportName: string }) {
  type Row = { groupKey: string; groupLabel: string; cohort: number } & MarkIndex['groups'][number]['points'][number];
  const rows: Row[] = idx.groups.flatMap(g =>
    g.points.slice(1).map(p => ({ ...p, groupKey: g.key, groupLabel: g.label, cohort: g.cohort }))
  );
  return (
    <DataTable<Row>
      basis={`Per-share mark index: ${idx.method.chains}; company: ${idx.method.company}; ${idx.method.group}; ${idx.method.minimum}. Taxonomy ${idx.taxonomyVersion}.`}
      source={idx}
      columns={[
        {
          id: 'label',
          header: LEVEL_LABEL[level],
          value: r => r.groupLabel,
          render: r => <a href={sectorPath(level, r.groupKey)}>{r.groupLabel}</a>,
          exportAs: [{ header: 'Code', value: r => r.groupKey }],
          wrap: true,
        },
        {
          id: 'period',
          header: 'Period',
          value: r => r.label,
          render: r => periodCell(r),
          exportAs: [
            { header: 'Period end', value: r => r.date },
            { header: 'Partial', value: r => (r.partial ? 'yes' : 'no') },
          ],
        },
        { id: 'companies', header: 'Companies marked', value: r => r.companies, num: true },
        {
          id: 'index',
          header: 'Typical company (start = 100)',
          value: r => r.index,
          num: true,
          render: r => fmtIdx(r.index),
        },
        { id: 'change', header: 'Change in period', value: r => r.change, num: true, render: r => signedPct(r.change) },
        {
          id: 'valueIndex',
          header: 'Value-weighted (start = 100)',
          value: r => r.valueIndex,
          num: true,
          render: r => fmtIdx(r.valueIndex),
        },
        { id: 'up', header: 'Marked up', value: r => r.up, num: true },
        { id: 'down', header: 'Marked down', value: r => r.down, num: true },
        {
          id: 'unchanged',
          header: 'Marks unchanged',
          value: r => r.unchanged,
          num: true,
          render: r => share(r.unchanged, 0),
        },
      ]}
      rows={rows}
      rowKey={r => `${r.groupKey}-${r.date}`}
      exportName={exportName}
      maxHeight={480}
    />
  );
}
const fmtIdx = (v: number | null) =>
  v == null ? (
    <span class="muted" title="Fewer than 5 companies marked">
      —
    </span>
  ) : (
    v.toFixed(1)
  );
function periodCell(p: { date: string; partial: boolean; label: string }) {
  return (
    <span title={`To ${longDate(p.date)}`}>
      {p.label}
      {p.partial && (
        <span class="muted small" title="Part of the period: later reports may still move it">
          {' '}
          (partial)
        </span>
      )}
    </span>
  );
}

/** "12 companies · 340 chains" under a chart. */
export const coverage = (idx: MarkIndex, key: string) => {
  const g = idx.groups.find(x => x.key === key);
  return g ? `${num(g.cohort)} companies measured` : '';
};
