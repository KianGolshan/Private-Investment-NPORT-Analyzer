import { useCallback, useMemo } from 'preact/hooks';
import type { Bridge, Pivot } from '../api/types';
import { moneyC, moneyDelta, num, tone } from '../lib/format';
import { Card, Kpi } from './bits';
import { Chart } from './Chart';
import { DataTable } from './DataTable';
import { baseOption, type ChartTheme } from './theme';

// The bridge (lib/services/analysis.js) as KPIs, a waterfall and its table
// twin: start value, each kind of change, end value, reconciled to the cent.
// One copy for the company, firm and fund pages.

type BridgeRow = { key: string; label: string; value: number; events: number | null };

export function BridgeView({ bridge: b, name }: { bridge: Bridge; name: string }) {
  const steps: BridgeRow[] = useMemo(
    () => [
      { key: 'start', label: `Value as of ${b.from}`, value: b.start.value, events: null },
      ...b.steps.filter(s => s.value !== 0 || s.events > 0),
      { key: 'end', label: `Value as of ${b.to}`, value: b.end.value, events: null },
    ],
    [b]
  );

  const build = useCallback(
    (t: ChartTheme) => {
      const base0 = baseOption(t);
      // A waterfall: an invisible base under each step's bar.
      let level = 0;
      const invisible: (number | string)[] = [];
      const up: (number | string)[] = [];
      const down: (number | string)[] = [];
      const totals: (number | string)[] = [];
      for (const s of steps) {
        if (s.key === 'start' || s.key === 'end') {
          invisible.push(0);
          totals.push(s.value);
          up.push('-');
          down.push('-');
          level = s.value;
          continue;
        }
        totals.push('-');
        if (s.value >= 0) {
          invisible.push(level);
          up.push(s.value);
          down.push('-');
          level += s.value;
        } else {
          level += s.value;
          invisible.push(level);
          down.push(-s.value);
          up.push('-');
        }
      }
      return {
        ...base0,
        legend: { show: false },
        tooltip: {
          ...base0.tooltip,
          trigger: 'axis',
          axisPointer: { type: 'shadow' },
          formatter: (ps: { dataIndex: number }[]) => {
            const s = steps[ps[0]!.dataIndex]!;
            return `${s.label}<br/>${s.key === 'start' || s.key === 'end' ? moneyC(s.value) : moneyDelta(s.value)}${s.events != null ? ` · ${num(s.events)} ${s.key === 'stopped' ? 'funds' : 'fund filings'}` : ''}`;
          },
        },
        xAxis: {
          type: 'category',
          data: steps.map(s => (s.key === 'start' ? 'Start' : s.key === 'end' ? 'End' : s.label)),
          ...base0.xAxisDefaults,
          axisLabel: { ...base0.xAxisDefaults.axisLabel, interval: 0, width: 80, overflow: 'break' },
        },
        yAxis: {
          type: 'value',
          ...base0.yAxisDefaults,
          axisLabel: { ...base0.yAxisDefaults.axisLabel, formatter: moneyC },
        },
        series: [
          {
            type: 'bar',
            stack: 'w',
            data: invisible,
            itemStyle: { color: 'transparent' },
            emphasis: { disabled: true },
          },
          { type: 'bar', stack: 'w', name: 'Up', data: up, itemStyle: { color: t.pos } },
          { type: 'bar', stack: 'w', name: 'Down', data: down, itemStyle: { color: t.neg } },
          { type: 'bar', stack: 'w', name: 'Level', data: totals, itemStyle: { color: t.series[0] } },
        ],
      };
    },
    [steps]
  );

  return (
    <>
      <div class="kpis">
        <Kpi label={`Value as of ${b.from}`} value={moneyC(b.start.value)} sub={`${num(b.start.funds)} funds`} />
        <Kpi
          label="From positions"
          value={<span class={tone(b.positionEffect)}>{moneyDelta(b.positionEffect)}</span>}
          sub="first reported, added, reduced, no longer reported"
        />
        <Kpi
          label="From marks"
          value={<span class={tone(b.markEffect)}>{moneyDelta(b.markEffect)}</span>}
          sub="new marks on the shares held"
        />
        <Kpi label={`Value as of ${b.to}`} value={moneyC(b.end.value)} sub={`${num(b.end.funds)} funds`} />
      </div>
      <Card
        title="Bridge"
        actions={
          <span class="muted small">
            {b.label} · {b.reconciled ? 'reconciles to the cent' : `does not reconcile: ${moneyDelta(b.residual)}`}
          </span>
        }
      >
        <Chart build={build} height={300} label={`${name}: bridge from ${b.from} to ${b.to}`} />
      </Card>
      <Card title="Bridge steps" flush>
        <DataTable
          columns={[
            { id: 'label', header: 'Step', value: (s: BridgeRow) => s.label, noSort: true },
            {
              id: 'value',
              header: 'Value',
              value: (s: BridgeRow) => s.value,
              num: true,
              noSort: true,
              render: (s: BridgeRow) =>
                s.key === 'start' || s.key === 'end' ? (
                  <strong>{moneyC(s.value)}</strong>
                ) : (
                  <span class={tone(s.value)}>{moneyDelta(s.value)}</span>
                ),
            },
            {
              id: 'events',
              header: 'Fund filings',
              value: (s: BridgeRow) => s.events,
              num: true,
              noSort: true,
              title: 'Fund filings with this kind of change (stopped filing: funds)',
            },
          ]}
          rows={steps}
          rowKey={s => s.key}
          exportName={`${name}-bridge-${b.from}-${b.to}`}
        />
      </Card>
    </>
  );
}

/** Position vs mark effect per period, from a pivot's total row. */
export function PeriodEffects({ pivot: p, name }: { pivot: Pivot; name: string }) {
  const build = useCallback(
    (t: ChartTheme) => {
      const base0 = baseOption(t);
      const tot = p.total;
      const position = tot.positionEffect.map(
        (v, i) => v + (tot.started[i] ?? 0) + (tot.stopped[i] ?? 0) + (tot.valueOnly[i] ?? 0)
      );
      return {
        ...base0,
        legend: { ...base0.legend, data: ['Position effect', 'Mark effect'] },
        tooltip: { ...base0.tooltip, axisPointer: { type: 'shadow' }, valueFormatter: (v: number) => moneyDelta(v) },
        xAxis: {
          type: 'category',
          data: p.periods.map(x => x.label + (x.partial ? '*' : '')),
          ...base0.xAxisDefaults,
        },
        yAxis: {
          type: 'value',
          ...base0.yAxisDefaults,
          axisLabel: { ...base0.yAxisDefaults.axisLabel, formatter: moneyC },
        },
        series: [
          { name: 'Position effect', type: 'bar', stack: 'fx', data: position, itemStyle: { color: t.series[0] } },
          { name: 'Mark effect', type: 'bar', stack: 'fx', data: tot.markEffect, itemStyle: { color: t.series[1] } },
        ],
      };
    },
    [p]
  );
  if (p.periods.length < 2) return null;
  return (
    <Card
      title={`Position vs mark effect by ${p.period}`}
      actions={<span class="muted small">by each fund’s mark date · * part of a {p.period}</span>}
    >
      <Chart build={build} height={240} label={`${name}: position and mark effect by ${p.period}`} />
    </Card>
  );
}
