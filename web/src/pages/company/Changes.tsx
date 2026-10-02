import { useCallback, useMemo } from 'preact/hooks';
import { qs, useApi } from '../../api/client';
import type { Activity, Bridge, Pivot } from '../../api/types';
import { moneyC, moneyDelta, num, tone } from '../../lib/format';
import { ScopeBar } from '../../scope/ScopeBar';
import { isRange, scopeParams, useScope } from '../../scope/scope';
import { Card, ErrorBox, Kpi, Loading } from '../../ui/bits';
import { ChangesTable } from '../../ui/ChangesTable';
import { Chart } from '../../ui/Chart';
import { DataTable } from '../../ui/DataTable';
import { baseOption, type ChartTheme } from '../../ui/theme';
import { FilterPickers, addDays, addYears, useFilterOptions, type ViewProps } from './shared';

// Changes over a range (default: the year to the newest mark date):
//   the bridge (start value, each kind of change, end value; reconciled to the
//   cent, its start and end the as-of rule), position vs mark effect by quarter,
//   and the ledger of every fund filing's change, split into position and mark.
// Changes are dated by each fund's own mark date ("changes in filings with mark
// dates in …"); levels are as of the range's ends.

type BridgeRow = { key: string; label: string; value: number; events: number | null };

export default function Changes({ base, sq, subject, name, newest, openPosition }: ViewProps) {
  const [scope] = useScope();
  const opts = useFilterOptions(base, sq);
  const range = isRange(scope);
  const to = range ? scope.to : (newest ?? '');
  const from = range ? scope.from : newest ? addYears(newest, -1) : '';
  const filters = scopeParams(scope);
  const bridge = useApi<Bridge>(to ? `${base}/bridge${qs({ from, to, ...sq, ...filters })}` : null);
  const pivot = useApi<Pivot>(
    to
      ? `/api/analysis/pivot${qs({ ...subject, rows: 'firm', period: 'quarter', from, to, limit: 1, ...filters })}`
      : null
  );
  // The ledger covers the bridge's window: mark dates after `from` through `to`.
  const act = useApi<Activity>(
    to ? `${base}/activity${qs({ since: addDays(from, 1), until: to, ...sq, ...filters })}` : null
  );
  const b = bridge.data;
  const events = act.data?.events ?? [];

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const e of events) c[e.type] = (c[e.type] ?? 0) + 1;
    return c;
  }, [events]);

  const steps: BridgeRow[] = useMemo(
    () =>
      b
        ? [
            { key: 'start', label: `Value as of ${b.from}`, value: b.start.value, events: null },
            ...b.steps.filter(s => s.value !== 0 || s.events > 0),
            { key: 'end', label: `Value as of ${b.to}`, value: b.end.value, events: null },
          ]
        : [],
    [b]
  );

  const buildBridge = useCallback(
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

  const p = pivot.data;
  const buildPeriods = useCallback(
    (t: ChartTheme) => {
      const base0 = baseOption(t);
      const tot = p?.total;
      const position = (tot?.positionEffect ?? []).map(
        (v, i) => v + (tot?.started[i] ?? 0) + (tot?.stopped[i] ?? 0) + (tot?.valueOnly[i] ?? 0)
      );
      return {
        ...base0,
        legend: { ...base0.legend, data: ['Position effect', 'Mark effect'] },
        tooltip: { ...base0.tooltip, axisPointer: { type: 'shadow' }, valueFormatter: (v: number) => moneyDelta(v) },
        xAxis: {
          type: 'category',
          data: p?.periods.map(x => x.label + (x.partial ? '*' : '')) ?? [],
          ...base0.xAxisDefaults,
        },
        yAxis: {
          type: 'value',
          ...base0.yAxisDefaults,
          axisLabel: { ...base0.yAxisDefaults.axisLabel, formatter: moneyC },
        },
        series: [
          { name: 'Position effect', type: 'bar', stack: 'fx', data: position, itemStyle: { color: t.series[0] } },
          {
            name: 'Mark effect',
            type: 'bar',
            stack: 'fx',
            data: tot?.markEffect ?? [],
            itemStyle: { color: t.series[1] },
          },
        ],
      };
    },
    [p]
  );

  return (
    <div class="stack">
      <div class="row wrap">
        <ScopeBar
          supports={{ range: true, asof: false, filters: ['firm', 'fund', 'class', 'kind'] }}
          newest={newest}
          fundName={opts.fundName}
        />
        <FilterPickers firms={opts.firms} classes={opts.classes} kinds={opts.indirect} />
        {!range && <span class="muted small">The year to the newest mark date. Pick a range to change it.</span>}
      </div>
      <ErrorBox error={bridge.error || act.error || pivot.error} />
      {bridge.loading && !b && <Loading rows={6} />}
      {b && (
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
            <Chart build={buildBridge} height={300} label={`${name}: bridge from ${b.from} to ${b.to}`} />
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
      )}
      {p && p.periods.length > 1 && (
        <Card
          title="Position vs mark effect by quarter"
          actions={<span class="muted small">by each fund’s mark date · * part of a quarter</span>}
        >
          <Chart build={buildPeriods} height={240} label={`${name}: position and mark effect by quarter`} />
        </Card>
      )}
      {act.data && (
        <>
          <div class="kpis">
            <Kpi label="First reported" value={num(counts.new ?? 0)} sub="funds’ first filing with it" />
            <Kpi label="Added" value={num(counts.added ?? 0)} sub="more shares or a new class" />
            <Kpi label="Reduced" value={num(counts.reduced ?? 0)} />
            <Kpi label="No longer reported" value={num(counts.exited ?? 0)} />
            <Kpi label="Mark moved only" value={num(counts.unchanged ?? 0)} sub="same shares, new mark" />
            {(counts.mixed ?? 0) + (counts.zeroed ?? 0) > 0 && (
              <Kpi
                label="Other"
                value={num((counts.mixed ?? 0) + (counts.zeroed ?? 0))}
                sub="added and reduced, or $0"
              />
            )}
          </div>
          <Card title="Position changes, filing by filing" flush>
            <ChangesTable events={events} exportName={`${name}-changes`} onFund={openPosition} />
          </Card>
        </>
      )}
    </div>
  );
}
