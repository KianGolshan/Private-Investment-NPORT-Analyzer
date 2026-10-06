import { useCallback } from 'preact/hooks';
import { qs, useApi } from '../../api/client';
import type { Freshness, Mover, Movers as MoversAnswer } from '../../api/types';
import { companyPath, longDate, moneyC, moneyDelta, num, tone } from '../../lib/format';
import { ScopeBar } from '../../scope/ScopeBar';
import { isRange, useParam, useScope } from '../../scope/scope';
import { Card, ErrorBox, Kpi, Loading } from '../../ui/bits';
import { Chart } from '../../ui/Chart';
import { DataTable, type Column } from '../../ui/DataTable';
import { baseOption, type ChartTheme } from '../../ui/theme';

// Movers (P6b W4): every private company's bridge over a range of mark dates,
// ranked by the mark effect (the new marks on the shares held) and by the net
// position flow (first reported + added − reduced − no longer reported, at the
// prior marks). A company's numbers here are its bridge (a test holds them
// equal); its name opens the company's Changes tab for the same range.

const addYears = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + n);
  return d.toISOString().slice(0, 10);
};

export default function Movers() {
  const [scope] = useScope();
  const [tracked, setTracked] = useParam('tracked');
  const fresh = useApi<Freshness>('/api/freshness');
  const newest = fresh.data?.newestReportDate ?? null;
  const range = isRange(scope);
  const to = range ? scope.to : (newest ?? '');
  const from = range ? scope.from : newest ? addYears(newest, -1) : '';
  const m = useApi<MoversAnswer>(
    to ? `/api/market/movers${qs({ from, to, tracked: tracked === '1', limit: 25 })}` : null
  );
  const d = m.data;

  const href = (r: Mover) => `${companyPath(r.companyId, r.name)}?tab=changes&from=${d?.from}&to=${d?.to}`;
  const cols = (main: 'markEffect' | 'positionEffect'): Column<Mover>[] => [
    {
      id: 'name',
      header: 'Company',
      value: r => r.name,
      render: r => <a href={href(r)}>{r.name}</a>,
      exportAs: [{ header: 'Company id', value: r => r.companyId }],
    },
    {
      id: main,
      header: main === 'markEffect' ? 'Mark effect' : 'Net position flow',
      value: r => r[main],
      num: true,
      render: r => <strong class={tone(r[main])}>{moneyDelta(r[main])}</strong>,
    },
    {
      id: main === 'markEffect' ? 'positionEffect' : 'markEffect',
      header: main === 'markEffect' ? 'Position flow' : 'Mark effect',
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
          { type: 'bar', name: 'Mark effect', data: rows.map(r => r.markEffect), itemStyle: { color: t.series[0] } },
          {
            type: 'bar',
            name: 'Position flow',
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
          filed: a mark effect is the new marks on the shares held; a position flow is shares first reported, added,
          reduced or no longer reported, at the prior marks.
        </p>
        <span class="spacer" />
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
              label="Largest net flow in"
              value={d.flowIn[0]?.name ?? '—'}
              sub={moneyDelta(d.flowIn[0]?.positionEffect)}
            />
          </div>
          <Card title="Largest mark moves, up and down (top 8 each)">
            <Chart build={build} height={460} label="Largest mark moves with their position flows" />
          </Card>
          <div class="grid-2">
            {(
              [
                ['Mark moved up', d.markUp, 'markEffect'],
                ['Mark moved down', d.markDown, 'markEffect'],
                ['Net position flow in', d.flowIn, 'positionEffect'],
                ['Net position flow out', d.flowOut, 'positionEffect'],
              ] as const
            ).map(([title, rows, main]) => (
              <Card key={title} title={title} flush>
                <DataTable
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
