import { useCallback, useMemo } from 'preact/hooks';
import { qs, useApi } from '../api/client';
import type { Drill, DrillEvent, Freshness, Pivot, PivotMetric } from '../api/types';
import {
  escapeHtml,
  companyPath,
  firmPath,
  fundPath,
  longDate,
  money,
  moneyC,
  moneyDelta,
  num,
  tone,
} from '../lib/format';
import { FirmPicker } from '../scope/FirmPicker';
import { ScopeBar } from '../scope/ScopeBar';
import { isRange, scopeParams, useParam, useScope, useSetParams } from '../scope/scope';
import { Badge, Card, Empty, ErrorBox, FilingRef, Kpi, Loading, Segmented } from '../ui/bits';
import { Chart } from '../ui/Chart';
import { DataTable, type Column } from '../ui/DataTable';
import type { ChartTheme } from '../ui/theme';

// Explore (P6b W4): one pivot across the warehouse. Rows are firms, funds,
// companies or share classes; columns are months, quarters or years. Levels
// (value, funds holding) are as of each period end; changes are summed over
// the filings whose mark dates fall in the period (DATA-QUALITY period rule).
// Every cell drills to the legs behind it, which sum to the cell. The whole
// view lives in the URL, so a link is a saved view.

type Rows = Pivot['rows'];
type Period = Pivot['period'];
type Row = Pivot['results'][number];

export const METRIC_LABEL: Record<PivotMetric, string> = {
  value: 'Value (period end)',
  holders: 'Funds holding (period end)',
  firstReported: 'First reported',
  added: 'Added',
  reduced: 'Reduced',
  exited: 'No longer reported',
  mark: 'Mark moved',
  valueOnly: 'Value only (no share count)',
  started: 'Started filing',
  stopped: 'Stopped filing',
  positionEffect: 'Position effect (net)',
  markEffect: 'Mark effect',
};
const METRICS = Object.keys(METRIC_LABEL) as PivotMetric[];
const isLevel = (m: PivotMetric) => m === 'value' || m === 'holders';
const ROW_LABEL: Record<Rows, string> = { firm: 'Firm', fund: 'Fund', company: 'Company', class: 'Share class' };
const ROW_PLURAL: Record<Rows, string> = { firm: 'Firms', fund: 'Funds', company: 'Companies', class: 'Share classes' };

const addYears = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + n);
  return d.toISOString().slice(0, 10);
};

function rowHref(rows: Rows, r: { key: string | number; label: string | null }): string | null {
  if (rows === 'firm') return r.key === 0 ? null : firmPath(Number(r.key));
  if (rows === 'fund') return fundPath(String(r.key));
  const [id, ...cls] = String(r.key).split(':');
  const path = companyPath(Number(id), String(r.label ?? '').split(' · ')[0] ?? '');
  return rows === 'class' ? `${path}?tab=marks&class=${encodeURIComponent(cls.join(':'))}` : path;
}

export default function Explore() {
  const [scope] = useScope();
  const fresh = useApi<Freshness>('/api/freshness');
  const newest = fresh.data?.newestReportDate ?? null;
  const [rowsP] = useParam('rows');
  const [perP] = useParam('per');
  const [metricP] = useParam('metric');
  const [trackedP] = useParam('tracked');
  const [nP, setN] = useParam('n');
  const [dk] = useParam('dk');
  const [dp] = useParam('dp');
  const setParams = useSetParams();
  const rows: Rows = (['fund', 'company', 'class'] as const).find(x => x === rowsP) ?? 'firm';
  const period: Period = (['month', 'year'] as const).find(x => x === perP) ?? 'quarter';
  const metric: PivotMetric = METRICS.find(m => m === metricP) ?? 'value';
  const limit = nP === '200' ? 200 : 50;
  const range = isRange(scope);
  const to = range ? scope.to : (newest ?? '');
  const from = range ? scope.from : newest ? addYears(newest, period === 'month' ? -1 : -2) : '';
  const filters = scopeParams(scope, ['firm', 'fund']);

  const pivot = useApi<Pivot>(
    to ? `/api/analysis/pivot${qs({ rows, period, from, to, limit, tracked: trackedP === '1', ...filters })}` : null
  );
  const p = pivot.data;

  // The drill: one row key ('_' = the total row) × one period index.
  const drillIdx = dp === '' ? -1 : Number(dp);
  const drillPeriod = p && drillIdx >= 0 ? p.periods[drillIdx] : undefined;
  const drill = useApi<Drill>(
    drillPeriod && dk
      ? `/api/analysis/drill${qs({
          rows,
          key: dk === '_' ? undefined : dk,
          metric,
          from: drillPeriod.from,
          to: drillPeriod.to,
          tracked: trackedP === '1',
          ...filters,
        })}`
      : null
  );
  const openDrill = (key: string | number | null, i: number) =>
    setParams({ dk: key == null ? '_' : String(key), dp: String(i) });
  // Changing the shape of the pivot closes the drill (its cell is gone).
  const reshape = (name: string, v: string) => setParams({ [name]: v, dk: '', dp: '' });

  const fmt = (v: number | undefined) =>
    v == null ? '—' : metric === 'holders' ? num(v) : metric === 'value' ? moneyC(v) : moneyDelta(v);
  const summary = (r: Row | Pivot['total']) => {
    const xs = r[metric];
    return isLevel(metric) ? xs[xs.length - 1] : xs.reduce((t, v) => t + v, 0);
  };

  const shown = useMemo(() => p?.results ?? [], [p]);
  const build = useCallback(
    (t: ChartTheme) => {
      const list = [...shown].reverse();
      const labels = p?.periods.map(x => x.label + (x.partial ? '*' : '')) ?? [];
      const data: [number, number, number][] = [];
      let lo = Infinity;
      let hi = -Infinity;
      list.forEach((r, y) =>
        r[metric].forEach((v, x) => {
          if (isLevel(metric) ? v === 0 : !v) return;
          data.push([x, y, v]);
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
        })
      );
      const diverging = !isLevel(metric) && lo < 0;
      const bound = Math.max(Math.abs(lo), Math.abs(hi)) || 1;
      return {
        textStyle: { fontFamily: t.font, color: t.text2 },
        aria: { enabled: true },
        grid: { left: 8, right: 16, top: 8, bottom: 56, containLabel: true },
        tooltip: {
          backgroundColor: t.surface,
          borderColor: t.border,
          textStyle: { color: t.text, fontSize: 12 },
          formatter: (q: { value: [number, number, number] }) => {
            const r = list[q.value[1]]!;
            const per = p!.periods[q.value[0]]!;
            return `${escapeHtml(r.label)}<br/>${escapeHtml(per.label)}${per.partial ? ' (part of the period)' : ''}: ${METRIC_LABEL[metric]} ${fmt(q.value[2])}<br/><span style="opacity:.7">click for the filings behind it</span>`;
          },
        },
        xAxis: {
          type: 'category',
          data: labels,
          axisLabel: { color: t.text3, fontSize: 10 },
          axisLine: { lineStyle: { color: t.border } },
        },
        yAxis: {
          type: 'category',
          data: list.map(r => r.label),
          axisLabel: { color: t.text2, fontSize: 11, width: 200, overflow: 'truncate' },
          axisLine: { lineStyle: { color: t.border } },
        },
        visualMap: {
          type: 'continuous',
          min: diverging ? -bound : lo === Infinity ? 0 : Math.min(0, lo),
          max: diverging ? bound : hi === -Infinity ? 1 : hi,
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
    [shown, p, metric]
  );
  const onClick = useCallback(
    (params: unknown) => {
      const v = (params as { value?: [number, number, number] }).value;
      if (!v) return;
      const r = [...shown].reverse()[v[1]];
      if (r) openDrill(r.key, v[0]);
    },
    [shown]
  );

  const cellButton = (key: string | number | null, i: number, v: number | undefined, label: string) => (
    <button
      type="button"
      class={`cell-link ${isLevel(metric) ? '' : tone(v)}`}
      aria-label={`${label}: drill into ${p?.periods[i]?.label}`}
      aria-pressed={dk === (key == null ? '_' : String(key)) && drillIdx === i}
      onClick={() => openDrill(key, i)}
    >
      {v ? fmt(v) : <span class="muted">—</span>}
    </button>
  );

  const columns: Column<Row>[] = useMemo(
    () => [
      {
        id: 'label',
        header: ROW_LABEL[rows],
        value: r => r.label,
        render: r => {
          const href = rowHref(rows, r);
          return href ? <a href={href}>{r.label}</a> : <span>{r.label}</span>;
        },
        exportAs: [{ header: 'Key', value: r => String(r.key) }],
        wrap: true,
        width: '220px',
      },
      ...(p?.periods ?? []).map((per, i): Column<Row> => ({
        id: `p${i}`,
        header: per.label + (per.partial ? '*' : ''),
        title: `${per.from} → ${per.to}${per.partial ? ' (part of the period)' : ''}`,
        value: r => r[metric][i],
        num: true,
        render: r => cellButton(r.key, i, r[metric][i], String(r.label)),
      })),
      {
        id: 'sum',
        header: isLevel(metric) ? 'Latest' : 'Window',
        title: isLevel(metric) ? 'As of the last period end' : 'Sum over the window',
        value: r => summary(r),
        num: true,
        render: r => <strong class={isLevel(metric) ? '' : tone(summary(r))}>{fmt(summary(r))}</strong>,
      },
    ],
    [p, metric, rows, dk, drillIdx]
  );

  const totals = () =>
    p
      ? {
          label: <span title="Each fund counted once, even when co-advised by two firms">Total</span>,
          ...Object.fromEntries(p.periods.map((_, i) => [`p${i}`, cellButton(null, i, p.total[metric][i], 'Total')])),
          sum: <strong>{fmt(summary(p.total))}</strong>,
        }
      : {};

  const link = typeof location !== 'undefined' ? location.href : '';
  return (
    <div class="stack">
      <div class="page-head">
        <div>
          <div class="eyebrow">Explore</div>
          <h1>Pivot across firms, funds, companies and classes</h1>
          <p class="muted" style={{ margin: '4px 0 0' }}>
            Levels are as of each period end (each fund's latest filing within 123 days). Changes are summed over the
            filings whose mark dates fall in the period; a mark date is never moved to a quarter end. Click any cell for
            the filings behind it.
          </p>
        </div>
      </div>
      <div class="row wrap">
        <ScopeBar supports={{ range: true, filters: ['firm', 'fund'] }} newest={newest} />
        <FirmPicker />
        <label class="row small">
          <input
            type="checkbox"
            checked={trackedP === '1'}
            onChange={e => reshape('tracked', (e.target as HTMLInputElement).checked ? '1' : '')}
          />
          Tracked companies only
        </label>
      </div>
      <div class="row wrap">
        <Segmented
          label="Rows"
          value={rows}
          onChange={v => reshape('rows', v === 'firm' ? '' : v)}
          options={[
            { id: 'firm', label: 'Firms' },
            { id: 'fund', label: 'Funds' },
            { id: 'company', label: 'Companies' },
            { id: 'class', label: 'Classes' },
          ]}
        />
        <Segmented
          label="Period"
          value={period}
          onChange={v => reshape('per', v === 'quarter' ? '' : v)}
          options={[
            { id: 'month', label: 'Month' },
            { id: 'quarter', label: 'Quarter' },
            { id: 'year', label: 'Year' },
          ]}
        />
        <select
          class="input"
          aria-label="Metric"
          value={metric}
          onChange={e => {
            const v = (e.target as HTMLSelectElement).value;
            setParams({ metric: v === 'value' ? '' : v });
          }}
        >
          {METRICS.map(m => (
            <option key={m} value={m}>
              {METRIC_LABEL[m]}
            </option>
          ))}
        </select>
        <span class="spacer" />
        <button
          class="btn sm"
          type="button"
          title="This view is its URL: copy it to save or share"
          onClick={() => void navigator.clipboard?.writeText(link)}
        >
          Copy link to this view
        </button>
      </div>
      <ErrorBox error={pivot.error} />
      {pivot.loading && !p && <Loading rows={8} />}
      {p && (
        <>
          <div class="kpis">
            <Kpi
              label={ROW_PLURAL[rows]}
              value={num(p.count)}
              sub={p.count > shown.length ? `top ${shown.length} shown` : undefined}
            />
            <Kpi
              label="Value at the end"
              value={moneyC(p.total.value[p.total.value.length - 1])}
              sub={`as of ${longDate(p.to)}`}
            />
            <Kpi
              label="Position effect"
              value={
                <span class={tone(p.total.positionEffect.reduce((t, v) => t + v, 0))}>
                  {moneyDelta(p.total.positionEffect.reduce((t, v) => t + v, 0))}
                </span>
              }
              sub="first reported + added − reduced − no longer reported"
            />
            <Kpi
              label="Mark effect"
              value={
                <span class={tone(p.total.markEffect.reduce((t, v) => t + v, 0))}>
                  {moneyDelta(p.total.markEffect.reduce((t, v) => t + v, 0))}
                </span>
              }
              sub={`${longDate(p.from)} → ${longDate(p.to)}`}
            />
          </div>
          <Card
            title={`${METRIC_LABEL[metric]} by ${ROW_LABEL[rows].toLowerCase()} and ${period}`}
            actions={
              p.count > 50 ? (
                <button
                  class="btn sm"
                  type="button"
                  onClick={() => setN(limit === 200 ? '' : '200', { replace: true })}
                >
                  {limit === 200 ? 'Show top 50' : 'Show top 200'}
                </button>
              ) : undefined
            }
          >
            {shown.length ? (
              <Chart
                build={build}
                height={Math.max(220, Math.min(shown.length, 60) * 20 + 90)}
                label={`${METRIC_LABEL[metric]} by ${ROW_LABEL[rows].toLowerCase()} and ${period}`}
                on={{ click: onClick }}
              />
            ) : (
              <Empty>Nothing in this scope.</Empty>
            )}
            <p class="muted small" style={{ margin: '8px 0 0' }}>
              * part of a calendar period (the window starts or ends inside it).
              {rows === 'firm' &&
                ' Firm rows count a co-advised fund for each firm (current adviser, latest N-CEN); the total counts it once.'}
            </p>
          </Card>
          {drillPeriod && dk && (
            <DrillView state={drill} period={drillPeriod} onClose={() => setParams({ dk: '', dp: '' })} />
          )}
          <Card title="Table" flush>
            <DataTable
              columns={columns}
              rows={shown}
              rowKey={r => String(r.key)}
              totals={totals}
              exportName={`explore-${rows}-${period}-${metric}-${p.from}-${p.to}`}
              filterPlaceholder={`Filter ${ROW_PLURAL[rows].toLowerCase()}…`}
              maxHeight={560}
            />
          </Card>
        </>
      )}
    </div>
  );
}

function legLine(l: DrillEvent['legs'][number]): string {
  const unit = l.perShare ? '/sh' : '/unit';
  const sh =
    l.prevBalance != null && l.balance != null && l.prevBalance !== l.balance
      ? `${num(l.prevBalance)} → ${num(l.balance)}${l.split ? ` (split ${l.split}:1)` : ''}`
      : l.balance != null
        ? num(l.balance)
        : 'no share count';
  const mark =
    l.prevPrice != null && l.price != null && l.prevPrice !== l.price
      ? `${money(l.prevPrice)} → ${money(l.price)}${unit}`
      : l.price != null
        ? `${money(l.price)}${unit}`
        : '';
  return `${l.classLabel}: ${sh}${mark ? ` · ${mark}` : ''} · ${moneyDelta(l.amount)}`;
}

function DrillView({
  state,
  period,
  onClose,
}: {
  state: { data: Drill | null; error: Error | null; loading: boolean };
  period: Pivot['periods'][number];
  onClose: () => void;
}) {
  const d = state.data;
  const level = d ? isLevel(d.metric) : false;
  const columns: Column<DrillEvent>[] = [
    {
      id: 'fund',
      header: 'Fund',
      value: e => e.fundLabel ?? e.fundKey,
      render: e => <a href={fundPath(e.fundKey)}>{e.fundLabel ?? e.fundKey}</a>,
      exportAs: [{ header: 'Fund key', value: e => e.fundKey }],
      wrap: true,
    },
    {
      id: 'company',
      header: 'Company',
      value: e => e.company,
      render: e => <a href={companyPath(e.companyId, e.company ?? '')}>{e.company}</a>,
      exportAs: [{ header: 'Company id', value: e => e.companyId }],
    },
    {
      id: 'date',
      header: 'Mark date',
      value: e => e.markDate,
      render: e =>
        e.accession ? (
          <FilingRef cik={e.cik} accession={e.accession} date={e.markDate} />
        ) : (
          <span title={`last filing ${e.lastAccession}`}>{e.markDate}</span>
        ),
      exportAs: [
        { header: 'Accession', value: e => e.accession ?? e.lastAccession },
        { header: 'Filed', value: e => e.filingDate },
      ],
    },
    {
      id: 'what',
      header: level ? 'Held' : 'Change',
      value: e => e.label,
      render: e => <Badge tone={e.amount > 0 ? 'pos' : e.amount < 0 ? 'warn' : ''}>{level ? 'held' : e.label}</Badge>,
    },
    {
      id: 'amount',
      header: d ? (d.metric === 'holders' ? 'Value' : METRIC_LABEL[d.metric]) : '',
      value: e => e.amount,
      num: true,
      render: e => <span class={level ? '' : tone(e.amount)}>{level ? moneyC(e.amount) : moneyDelta(e.amount)}</span>,
    },
    {
      id: 'legs',
      header: 'Legs (class: shares · mark · amount)',
      value: e => e.legs.map(legLine).join('; '),
      render: e => (
        <span class="small">
          {e.legs.map((l, i) => (
            <div key={i}>{legLine(l)}</div>
          ))}
        </span>
      ),
      wrap: true,
      noSort: true,
    },
  ];
  return (
    <Card
      title={
        <h3>
          {d ? `${d.rowLabel} · ${METRIC_LABEL[d.metric]} · ${period.label}` : 'Loading the filings behind the cell…'}
        </h3>
      }
      actions={
        <button class="btn sm" type="button" onClick={onClose}>
          Close
        </button>
      }
      flush
    >
      <ErrorBox error={state.error} />
      {state.loading && !d && <Loading rows={4} />}
      {d && (
        <>
          <div class="row wrap" style={{ padding: '8px 12px' }}>
            <strong class={level ? '' : tone(d.total)}>
              {d.metric === 'holders' ? `${num(d.total)} funds` : level ? moneyC(d.total) : moneyDelta(d.total)}
            </strong>
            <span class="muted small">
              {d.label}. {num(d.count)} filings, {num(d.legCount)} legs, {num(d.funds)} funds
              {d.count > d.events.length ? `; the ${d.events.length} largest shown` : ''}. The legs sum to the cell.
            </span>
          </div>
          <DataTable
            columns={columns}
            rows={d.events}
            rowKey={(e, i) => `${e.fundKey}|${e.companyId}|${e.accession ?? e.markDate}|${i}`}
            exportName={`drill-${d.rows}-${d.key ?? 'total'}-${d.metric}-${d.from}-${d.to}`}
            maxHeight={480}
            empty="No filings in this cell."
          />
        </>
      )}
    </Card>
  );
}
