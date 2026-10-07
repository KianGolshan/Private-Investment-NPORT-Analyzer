import { useCallback, useMemo } from 'preact/hooks';
import { qs, useApi } from '../../api/client';
import type { CompanyHistory } from '../../api/types';
import { escapeHtml, fundPath, money, moneyC, moneyDelta, num } from '../../lib/format';
import { ScopeBar } from '../../scope/ScopeBar';
import { isRange, scopeParams, useParam, useScope } from '../../scope/scope';
import { Card, Empty, ErrorBox, Loading, Segmented } from '../../ui/bits';
import { Chart } from '../../ui/Chart';
import { DataTable, type Column } from '../../ui/DataTable';
import type { ChartTheme } from '../../ui/theme';
import { FilterPickers, useFilterOptions, type ViewProps } from './shared';

// Every fund's position at every filing as a grid: one row per fund, one
// column per month of mark date (a fund's filing sits in its own month; mark
// dates are never moved to a quarter end). The metric is the value, the share
// count, the per-share mark (share rows only, trap 40) or the value change
// since the fund's previous filing. A cell opens the fund's position history.

type Metric = 'value' | 'shares' | 'price' | 'delta';

interface Cell {
  markDate: string;
  accession: string;
  value: number;
  shares: number | null;
  price: number | null;
  delta: number | null;
}
interface FundRow {
  fundKey: string;
  label: string;
  cik: string;
  cells: Map<string, Cell>;
  latest: number;
  first: string;
  last: string;
  filings: number;
}

const ROWS_SHOWN = 40;

export default function Positions({ base, sq, name, newest, openPosition }: ViewProps) {
  const [scope] = useScope();
  const [metricParam, setMetric] = useParam('metric');
  const [allParam, setAll] = useParam('all');
  const metric: Metric = (['shares', 'price', 'delta'] as const).find(m => m === metricParam) ?? 'value';
  const opts = useFilterOptions(base, sq);
  const hist = useApi<CompanyHistory>(`${base}/history${qs({ ...sq, ...scopeParams(scope) })}`);
  const range = isRange(scope);

  const funds = useMemo<FundRow[]>(() => {
    const out: FundRow[] = [];
    for (const f of hist.data?.funds ?? []) {
      const byDate = new Map<string, Cell & { sharesNs: number; valueNs: number }>();
      for (const s of f.series)
        for (const p of s.points) {
          const c =
            byDate.get(p.markDate) ??
            byDate
              .set(p.markDate, {
                markDate: p.markDate,
                accession: p.accession,
                value: 0,
                shares: null,
                price: null,
                delta: null,
                sharesNs: 0,
                valueNs: 0,
              })
              .get(p.markDate)!;
          c.value += p.valueUsd;
          if (p.unit === 'NS' && p.balance != null && p.balance > 0) {
            c.sharesNs += p.balance;
            c.valueNs += p.valueUsd;
          }
        }
      const dates = [...byDate.keys()].sort();
      const cells = new Map<string, Cell>();
      let prev: number | null = null;
      for (const d of dates) {
        const c = byDate.get(d)!;
        const cell: Cell = {
          markDate: d,
          accession: c.accession,
          value: c.value,
          shares: c.sharesNs || null,
          price: c.sharesNs ? c.valueNs / c.sharesNs : null,
          delta: prev == null ? null : c.value - prev,
        };
        prev = c.value;
        if (!range || (d > scope.from && d <= scope.to)) cells.set(d.slice(0, 7), cell);
      }
      if (!cells.size) continue;
      const shown = [...cells.values()];
      out.push({
        fundKey: f.fundKey,
        label: f.label,
        cik: f.cik,
        cells,
        latest: shown[shown.length - 1]!.value,
        first: shown[0]!.markDate,
        last: shown[shown.length - 1]!.markDate,
        filings: shown.length,
      });
    }
    return out.sort((a, b) => b.last.localeCompare(a.last) || b.latest - a.latest);
  }, [hist.data, range, scope.from, scope.to]);

  const shown = allParam ? funds : funds.slice(0, ROWS_SHOWN);
  const months = useMemo(() => {
    const all = new Set<string>();
    for (const f of shown) for (const m of f.cells.keys()) all.add(m);
    const sorted = [...all].sort();
    if (!sorted.length) return [];
    // every month from the first to the last, so gaps show as gaps
    const out: string[] = [];
    let [y, m] = sorted[0]!.split('-').map(Number) as [number, number];
    const end = sorted[sorted.length - 1]!;
    for (;;) {
      const k = `${y}-${String(m).padStart(2, '0')}`;
      out.push(k);
      if (k >= end) break;
      if (++m > 12) {
        m = 1;
        y++;
      }
    }
    return out;
  }, [shown]);

  const valueOf = (c: Cell) =>
    metric === 'value' ? c.value : metric === 'shares' ? c.shares : metric === 'price' ? c.price : c.delta;
  const fmt = (v: number | null) =>
    v == null
      ? '—'
      : metric === 'value'
        ? moneyC(v)
        : metric === 'shares'
          ? num(v)
          : metric === 'price'
            ? money(v)
            : moneyDelta(v);

  const build = useCallback(
    (t: ChartTheme) => {
      const rows = [...shown].reverse(); // the first fund at the top
      const data: [number, number, number][] = [];
      let lo = Infinity;
      let hi = -Infinity;
      rows.forEach((f, y) =>
        months.forEach((m, x) => {
          const c = f.cells.get(m);
          const v = c ? valueOf(c) : null;
          if (v == null) return;
          data.push([x, y, v]);
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
        })
      );
      const diverging = metric === 'delta';
      const bound = Math.max(Math.abs(lo), Math.abs(hi)) || 1;
      return {
        textStyle: { fontFamily: t.font, color: t.text2 },
        aria: { enabled: true },
        grid: { left: 8, right: 16, top: 8, bottom: 56, containLabel: true },
        tooltip: {
          backgroundColor: t.surface,
          borderColor: t.border,
          textStyle: { color: t.text, fontSize: 12 },
          formatter: (p: { value: [number, number, number] }) => {
            const f = rows[p.value[1]]!;
            const c = f.cells.get(months[p.value[0]]!)!;
            return `${escapeHtml(f.label)}<br/>mark date ${c.markDate}<br/>value ${moneyC(c.value)} · ${c.shares != null ? `${num(c.shares)} sh at ${money(c.price)}` : 'no share count'}${c.delta != null ? `<br/>since prior filing ${moneyDelta(c.delta)}` : ''}<br/><span style="opacity:.7">${escapeHtml(c.accession)} · click for the position history</span>`;
          },
        },
        xAxis: {
          type: 'category',
          data: months,
          axisLabel: { color: t.text3, fontSize: 10 },
          axisLine: { lineStyle: { color: t.border } },
          splitArea: { show: false },
        },
        yAxis: {
          type: 'category',
          data: rows.map(f => f.label),
          axisLabel: { color: t.text2, fontSize: 11, width: 220, overflow: 'truncate' },
          axisLine: { lineStyle: { color: t.border } },
        },
        visualMap: {
          type: 'continuous',
          min: diverging ? -bound : lo === Infinity ? 0 : lo,
          max: diverging ? bound : hi === -Infinity ? 1 : hi,
          calculable: false,
          orient: 'horizontal',
          left: 'center',
          bottom: 4,
          itemHeight: 160,
          textStyle: { color: t.text3, fontSize: 10 },
          formatter: (v: number) => fmt(v),
          inRange: { color: diverging ? [t.neg, t.surface, t.pos] : [t.heat[0], t.heat[1]] },
        },
        series: [
          {
            type: 'heatmap',
            data,
            itemStyle: { borderColor: t.surface, borderWidth: 1 },
            emphasis: { itemStyle: { borderColor: t.text, borderWidth: 1 } },
          },
        ],
      };
    },
    [shown, months, metric]
  );

  const onClick = useCallback(
    (params: unknown) => {
      const p = params as { value?: [number, number, number] };
      if (!p.value) return;
      const rows = [...shown].reverse();
      const f = rows[p.value[1]];
      if (f) openPosition(f.fundKey);
    },
    [shown, openPosition]
  );

  const columns: Column<FundRow>[] = [
    {
      id: 'fund',
      header: 'Fund',
      value: f => f.label,
      render: f => <a href={fundPath(f.fundKey)}>{f.label}</a>,
      exportAs: [{ header: 'Fund key', value: f => f.fundKey }],
      wrap: true,
    },
    { id: 'first', header: 'First mark', value: f => f.first },
    { id: 'last', header: 'Latest mark', value: f => f.last },
    { id: 'filings', header: 'Filings', value: f => f.filings, num: true },
    { id: 'latest', header: 'Latest value', value: f => f.latest, num: true, render: f => moneyC(f.latest) },
  ];

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
          label="Metric"
          value={metric}
          onChange={v => setMetric(v === 'value' ? '' : v, { replace: true })}
          options={[
            { id: 'value', label: 'Value' },
            { id: 'shares', label: 'Shares' },
            { id: 'price', label: '$/share' },
            { id: 'delta', label: 'Δ value' },
          ]}
        />
      </div>
      <ErrorBox error={hist.error} />
      {hist.loading && !hist.data && <Loading rows={6} />}
      {hist.data && (
        <>
          <Card
            title={`Positions by fund and mark month (${shown.length} of ${funds.length} funds)`}
            actions={
              funds.length > ROWS_SHOWN ? (
                <button class="btn sm" type="button" onClick={() => setAll(allParam ? '' : '1', { replace: true })}>
                  {allParam ? `Show the ${ROWS_SHOWN} most recent` : `Show all ${funds.length}`}
                </button>
              ) : (
                <span class="muted small">each cell is one filing; empty = no row that month</span>
              )
            }
          >
            {shown.length ? (
              <Chart
                build={build}
                height={Math.max(220, shown.length * 20 + 90)}
                label={`${name}: ${metric} by fund and mark month`}
                on={{ click: onClick }}
              />
            ) : (
              <Empty>No positions in this scope.</Empty>
            )}
          </Card>
          <Card title="Funds" flush>
            <DataTable
              source={hist.data}
              columns={columns}
              rows={funds}
              rowKey={f => f.fundKey}
              sort={{ id: 'last', desc: true }}
              exportName={`${name}-positions`}
              maxHeight={420}
              onRowClick={f => openPosition(f.fundKey)}
            />
          </Card>
        </>
      )}
    </div>
  );
}
