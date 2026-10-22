import { BASIS } from '../../ui/Basis';
import { useCallback } from 'preact/hooks';
import { qs, useApi } from '../../api/client';
import type { Freshness, Mover, Movers as MoversAnswer } from '../../api/types';
import { companyPath, longDate, moneyC, moneyDelta, num, tone } from '../../lib/format';
import { ScopeBar } from '../../scope/ScopeBar';
import { useParam, useScope, windowOf } from '../../scope/scope';
import { Card, Empty, ErrorBox, Kpi, Loading } from '../../ui/bits';
import { CategoryBadge, CategorySwitch, useCategoryFilter } from '../../ui/Category';
import { industryColumn, SectorFilter, useSectorFilter } from '../../ui/SectorFilter';
import { Chart } from '../../ui/Chart';
import { DataTable, type Column } from '../../ui/DataTable';
import { baseOption, type ChartTheme } from '../../ui/theme';

// Movers (P6b W4): every private company's bridge over a range of mark dates,
// ranked by the mark effect (the new marks on the shares held) and by the net
// position flow (first reported + added − reduced − no longer reported, at the
// prior marks). A company's numbers here are its bridge (a test holds them
// equal); its name opens the company's Changes tab for the same range.

export default function Movers() {
  const [scope] = useScope();
  const [tracked, setTracked] = useParam('tracked');
  const cat = useCategoryFilter();
  const group = useSectorFilter();
  const fresh = useApi<Freshness>('/api/freshness');
  const newest = fresh.data?.newestReportDate ?? null;
  const { from, to } = windowOf(scope, newest, 1);
  const m = useApi<MoversAnswer>(
    to
      ? `/api/market/movers${qs({ from, to, tracked: tracked === '1', limit: 25, category: cat.category, ...group.params })}`
      : null
  );
  const d = m.data;

  const href = (r: Mover) => `${companyPath(r.companyId, r.name)}?tab=changes&from=${d?.from}&to=${d?.to}`;
  const cols = (main: 'markEffect' | 'positionEffect'): Column<Mover>[] => [
    {
      id: 'name',
      header: 'Company',
      value: r => r.name,
      render: r => (
        <span>
          <a href={href(r)}>{r.name}</a> <CategoryBadge category={r.category} />
        </span>
      ),
      exportAs: [
        { header: 'Company id', value: r => r.companyId },
        { header: 'Category', value: r => r.category },
      ],
    },
    industryColumn<Mover>(),
    {
      id: main,
      header: main === 'markEffect' ? 'From marks' : 'From positions (net)',
      value: r => r[main],
      num: true,
      render: r => <strong class={tone(r[main])}>{moneyDelta(r[main])}</strong>,
    },
    {
      id: main === 'markEffect' ? 'positionEffect' : 'markEffect',
      header: main === 'markEffect' ? 'From positions' : 'From marks',
      value: r => (main === 'markEffect' ? r.positionEffect : r.markEffect),
      num: true,
      render: r => {
        const v = main === 'markEffect' ? r.positionEffect : r.markEffect;
        return <span class={tone(v)}>{moneyDelta(v)}</span>;
      },
    },
    { id: 'start', header: 'Start', value: r => r.startValue, num: true, render: r => moneyC(r.startValue) },
    { id: 'end', header: 'End', value: r => r.endValue, num: true, render: r => moneyC(r.endValue) },
    {
      id: 'funds',
      header: 'Funds',
      title: 'Funds holding at the start → at the end',
      value: r => r.endFunds,
      num: true,
      render: r => `${num(r.startFunds)} → ${num(r.endFunds)}`,
      exportAs: [{ header: 'Funds at start', value: r => r.startFunds }],
    },
  ];

  const build = useCallback(
    (t: ChartTheme) => {
      const rows = [...(d?.markUp ?? []).slice(0, 8), ...(d?.markDown ?? []).slice(0, 8).reverse()].reverse();
      const b = baseOption(t);
      return {
        ...b,
        tooltip: { ...b.tooltip, valueFormatter: (v: number) => moneyDelta(v) },
        legend: { ...b.legend, show: true },
        grid: { ...b.grid, left: 8, right: 24 },
        xAxis: { type: 'value', ...b.xAxisDefaults, axisLabel: { ...b.xAxisDefaults.axisLabel, formatter: moneyC } },
        yAxis: { type: 'category', data: rows.map(r => r.name), ...b.yAxisDefaults, axisLabel: { color: t.text2 } },
        series: [
          { type: 'bar', name: 'From marks', data: rows.map(r => r.markEffect), itemStyle: { color: t.series[0] } },
          {
            type: 'bar',
            name: 'From positions',
            data: rows.map(r => r.positionEffect),
            itemStyle: { color: t.series[1] },
          },
        ],
      };
    },
    [d]
  );

  return (
    <div class="stack">
      <div class="row wrap">
        <p class="muted" style={{ margin: 0 }}>
          {d ? `${d.label[0]!.toUpperCase()}${d.label.slice(1)}.` : 'Changes over a range of mark dates.'} Worded as
          filed: “from marks” is the new marks on the shares held; “from positions” is shares first reported, added,
          reduced or no longer reported, at the prior marks.
        </p>
        <span class="spacer" />
        <CategorySwitch />
        <SectorFilter />
        <ScopeBar supports={{ range: true }} newest={newest} />
        <label class="row small">
          <input
            type="checkbox"
            checked={tracked === '1'}
            onChange={e => setTracked((e.target as HTMLInputElement).checked ? '1' : '')}
          />
          Tracked only
        </label>
      </div>
      <ErrorBox error={m.error} />
      {m.loading && !d && <Loading rows={6} />}
      {d && (
        <>
          <div class="kpis">
            <Kpi label="Companies with a change" value={num(d.companies)} />
            <Kpi label="Window" value={`${longDate(d.from)} → ${longDate(d.to)}`} sub="by each fund's mark date" />
            <Kpi label="Largest mark move" value={d.markUp[0]?.name ?? '—'} sub={moneyDelta(d.markUp[0]?.markEffect)} />
            <Kpi
              label="Most added (from positions)"
              value={d.flowIn[0]?.name ?? '—'}
              sub={moneyDelta(d.flowIn[0]?.positionEffect)}
            />
          </div>
          <Card title="Largest mark moves, up and down (top 8 each)">
            {d.markUp.length || d.markDown.length ? (
              <Chart
                build={build}
                height={460}
                label="Largest mark moves, with the change from positions beside them"
              />
            ) : (
              <Empty>No mark moved in this window{Object.keys(group.params).length ? ' for this group' : ''}.</Empty>
            )}
          </Card>
          <div class="grid-2">
            {(
              [
                ['Mark moved up', d.markUp, 'markEffect'],
                ['Mark moved down', d.markDown, 'markEffect'],
                ['Most added (from positions)', d.flowIn, 'positionEffect'],
                ['Most reduced (from positions)', d.flowOut, 'positionEffect'],
              ] as const
            ).map(([title, rows, main]) => (
              <Card key={title} title={title} flush>
                <DataTable
                  basis={BASIS}
                  source={d}
                  columns={cols(main)}
                  rows={[...rows]}
                  rowKey={r => String(r.companyId)}
                  exportName={`movers-${title.toLowerCase().replace(/ /g, '-')}-${d.from}-${d.to}`}
                  empty="None in this window."
                />
              </Card>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
