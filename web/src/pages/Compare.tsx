import { BASIS, BasisNote } from '../ui/Basis';
import { useCallback, useMemo, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { qs, useApi } from '../api/client';
import type { Compare as Answer, Freshness, UnifiedHit } from '../api/types';
import { escapeHtml, companyPath, firmPath, fundPath, money, moneyC, moneyDelta, tone } from '../lib/format';
import { ScopeBar } from '../scope/ScopeBar';
import { isRange, useScope, useSetParams } from '../scope/scope';
import { Badge, Card, Empty, ErrorBox, Loading, Segmented } from '../ui/bits';
import { Chart } from '../ui/Chart';
import { DataTable, type Column } from '../ui/DataTable';
import { baseOption, type ChartTheme } from '../ui/theme';

// Compare (P6b W4, replaces v1's Batch): 2 to 5 companies, firms, funds or
// share classes overlaid: value at each period end (the pivot's rows), the
// position and mark effects over the range, and for companies and classes the
// per-share marks: at each mark date, the median of the funds that filed the
// class that day (as filed, same date only; a company shows its largest
// class), with the spread at the newest date two or more funds filed.

type Rows = Answer['rows'];
type Row = Answer['results'][number];
const KINDS: { id: Rows; label: string; one: string; search: string }[] = [
  { id: 'company', label: 'Companies', one: 'Company', search: 'company' },
  { id: 'firm', label: 'Firms', one: 'Firm', search: 'firm' },
  { id: 'fund', label: 'Funds', one: 'Fund', search: 'fund' },
  { id: 'class', label: 'Share classes', one: 'Share class', search: 'class' },
];
const addYears = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + n);
  return d.toISOString().slice(0, 10);
};
const nameOf = (r: Row) => r.label ?? String(r.key);
// null when nothing is known (a subject that is not live), never a plausible 0
const sum = (xs: (number | null)[]) => (xs.some(v => v != null) ? xs.reduce<number>((t, v) => t + (v ?? 0), 0) : null);
const STATE_LABEL = {
  unknown: 'not in the warehouse',
  listed: 'listed: no private book',
  merged: 'merged',
  dropped: 'dropped',
} as const;

function hrefOf(rows: Rows, r: Row): string {
  if (rows === 'firm') return firmPath(Number(r.key));
  if (rows === 'fund') return fundPath(String(r.key));
  const [id, ...cls] = String(r.key).split(':');
  const path = companyPath(Number(id), String(r.label ?? '').split(' · ')[0] ?? '');
  return rows === 'class' ? `${path}?tab=marks&class=${encodeURIComponent(cls.join(':'))}` : path;
}

export default function Compare() {
  const [scope] = useScope();
  const loc = useLocation();
  const setParams = useSetParams();
  const sp = new URLSearchParams(loc.url.includes('?') ? loc.url.slice(loc.url.indexOf('?') + 1) : '');
  const rows: Rows = (['firm', 'fund', 'class'] as const).find(x => x === sp.get('rows')) ?? 'company';
  const period = sp.get('per') === 'month' ? 'month' : sp.get('per') === 'year' ? 'year' : 'quarter';
  const keys = sp.getAll('key').slice(0, 5);
  const [indexed, setIndexed] = useState(false);
  const fresh = useApi<Freshness>('/api/freshness');
  const newest = fresh.data?.newestReportDate ?? null;
  const range = isRange(scope);
  const to = range ? scope.to : (newest ?? '');
  const from = range ? scope.from : newest ? addYears(newest, -3) : '';

  // Keys are repeated params (?key=1&key=5); set them through the URL so Back works.
  const setKeys = (next: string[], nextRows: Rows = rows) => {
    const q = new URLSearchParams(sp);
    q.delete('key');
    next.forEach(k => q.append('key', k));
    if (nextRows === 'company') q.delete('rows');
    else q.set('rows', nextRows);
    loc.route(`${loc.path}?${q.toString()}`);
  };

  const c = useApi<Answer>(
    keys.length >= 2 && to ? `/api/analysis/compare${qs({ rows, key: keys, period, from, to })}` : null
  );
  const d = c.data;

  const buildValue = useCallback(
    (t: ChartTheme) => {
      const b = baseOption(t);
      return {
        ...b,
        legend: { ...b.legend, show: true },
        tooltip: { ...b.tooltip, valueFormatter: (v: number) => moneyC(v) },
        xAxis: { type: 'category', data: d?.periods.map(p => p.label) ?? [], ...b.xAxisDefaults },
        yAxis: { type: 'value', ...b.yAxisDefaults, axisLabel: { ...b.yAxisDefaults.axisLabel, formatter: moneyC } },
        series: (d?.results ?? [])
          .filter(r => r.status.state === 'live')
          .map(r => ({ type: 'line', name: nameOf(r), data: r.value, symbolSize: 5 })),
      };
    },
    [d]
  );

  const withMarks = (d?.results ?? []).filter(r => r.marks?.length);
  const buildMarks = useCallback(
    (t: ChartTheme) => {
      const b = baseOption(t);
      return {
        ...b,
        legend: { ...b.legend, show: true },
        tooltip: {
          ...b.tooltip,
          trigger: 'item',
          formatter: (p: { seriesName: string; data: [string, number, number, number] }) =>
            `${escapeHtml(p.seriesName)}<br/>mark date ${escapeHtml(p.data[0])}: median ${indexed ? p.data[1].toFixed(1) : money(p.data[1])}<br/>${p.data[2]} funds filed that day${indexed ? ` · ${money(p.data[3])}/sh` : ''}`,
        },
        xAxis: { type: 'time', ...b.xAxisDefaults },
        yAxis: {
          type: indexed ? 'value' : 'log',
          ...b.yAxisDefaults,
          axisLabel: { ...b.yAxisDefaults.axisLabel, formatter: (v: number) => (indexed ? String(v) : money(v)) },
        },
        series: withMarks.map(r => {
          const base = r.marks![0]!.median;
          return {
            type: 'line',
            name: `${r.label}${rows === 'company' ? ` · ${r.markClass}` : ''}`,
            symbolSize: 6,
            data: r.marks!.map(m => [m.markDate, indexed ? (m.median / base) * 100 : m.median, m.funds, m.median]),
          };
        }),
      };
    },
    [d, indexed]
  );

  const columns: Column<Row>[] = useMemo(
    () => [
      {
        id: 'name',
        header: KINDS.find(k => k.id === rows)!.one,
        value: r => r.label,
        render: r =>
          r.status.state === 'live' ? (
            <a href={hrefOf(rows, r)}>{r.label}</a>
          ) : (
            <span>
              {r.label ?? String(r.key)} <Badge tone="warn">{STATE_LABEL[r.status.state]}</Badge>
            </span>
          ),
        exportAs: [{ header: 'Key', value: r => String(r.key) }],
        wrap: true,
      },
      {
        id: 'value',
        header: 'Value',
        title: `As of ${d?.to}`,
        value: r => r.value[r.value.length - 1],
        num: true,
        render: r => moneyC(r.value[r.value.length - 1]),
      },
      {
        id: 'funds',
        header: rows === 'company' || rows === 'class' ? 'Funds' : 'Companies',
        value: r => (rows === 'company' || rows === 'class' ? r.funds : r.companies),
        num: true,
      },
      {
        id: 'pos',
        header: 'Position effect',
        value: r => sum(r.positionEffect),
        num: true,
        render: r => <span class={tone(sum(r.positionEffect))}>{moneyDelta(sum(r.positionEffect))}</span>,
      },
      {
        id: 'mark',
        header: 'Mark effect',
        value: r => sum(r.markEffect),
        num: true,
        render: r => <span class={tone(sum(r.markEffect))}>{moneyDelta(sum(r.markEffect))}</span>,
      },
      ...(rows === 'company' || rows === 'class'
        ? ([
            ...(rows === 'company' ? [{ id: 'cls', header: 'Largest class', value: (r: Row) => r.markClass }] : []),
            {
              id: 'median',
              header: 'Latest median mark',
              value: (r: Row) => r.marks?.[r.marks.length - 1]?.median,
              num: true,
              render: (r: Row) => {
                const m = r.marks?.[r.marks.length - 1];
                return m ? <span title={`mark date ${m.markDate}, ${m.funds} funds`}>{money(m.median)}</span> : '—';
              },
              exportAs: [{ header: 'Median mark date', value: (r: Row) => r.marks?.[r.marks.length - 1]?.markDate }],
            },
            {
              id: 'spread',
              header: 'Spread',
              title: 'High / low − 1 of the funds’ marks at the newest date two or more funds filed',
              value: (r: Row) => r.spread?.pct,
              num: true,
              render: (r: Row) =>
                r.spread ? (
                  <span title={`${r.spread.funds} funds on ${r.spread.markDate}`}>{r.spread.pct.toFixed(1)}%</span>
                ) : (
                  '—'
                ),
            },
          ] as Column<Row>[])
        : []),
      {
        id: 'marks',
        header: 'Mark dates in force',
        value: r => r.newestMark,
        render: r => (
          <span class="small">
            {r.oldestMark ? (r.oldestMark === r.newestMark ? r.oldestMark : `${r.oldestMark} … ${r.newestMark}`) : '—'}
          </span>
        ),
      },
    ],
    [rows, d]
  );

  // The per-period table: one row per period, one value column per item.
  const periodRows = useMemo(() => (d ? d.periods.map((p, i) => ({ p, i })) : []), [d]);
  const periodCols: Column<{ p: Answer['periods'][number]; i: number }>[] = [
    { id: 'period', header: 'Period end', value: x => x.p.to },
    ...(d?.results ?? []).map(r => ({
      id: String(r.key),
      header: nameOf(r),
      value: (x: { i: number }) => r.value[x.i],
      num: true,
      render: (x: { i: number }) => moneyC(r.value[x.i]),
    })),
  ];

  return (
    <div class="stack">
      <div class="page-head">
        <div>
          <div class="eyebrow">Compare</div>
          <h1>Two to five side by side</h1>
          <p class="muted" style={{ margin: '4px 0 0' }}>
            Value at each period end (each fund's latest filing within 123 days), position and mark effects over the
            range, and per-share marks as filed: at each mark date, the median of the funds that filed the class that
            day. Marks are not split-adjusted across funds.
          </p>
          <BasisNote />
        </div>
      </div>
      <div class="row wrap">
        <Segmented
          label="Compare"
          value={rows}
          onChange={v => setKeys([], v)}
          options={KINDS.map(k => ({ id: k.id, label: k.label }))}
        />
        <Segmented
          label="Period"
          value={period}
          onChange={v => setParams({ per: v === 'quarter' ? '' : v })}
          options={[
            { id: 'month', label: 'Month' },
            { id: 'quarter', label: 'Quarter' },
            { id: 'year', label: 'Year' },
          ]}
        />
        <span class="spacer" />
        <ScopeBar supports={{ range: true }} newest={newest} />
      </div>
      <Card title={`Items (${keys.length} of 5)`}>
        <Picker
          kind={rows}
          keys={keys}
          labels={new Map((d?.results ?? []).map(r => [String(r.key), nameOf(r)]))}
          onChange={setKeys}
        />
      </Card>
      {keys.length < 2 ? (
        <Empty>Add at least two {KINDS.find(k => k.id === rows)!.label.toLowerCase()} to compare.</Empty>
      ) : (
        <>
          <ErrorBox error={c.error} />
          {c.loading && !d && <Loading rows={6} />}
          {d && (
            <>
              <Card title="Summary" flush>
                <DataTable
                  basis={BASIS}
                  source={d}
                  columns={columns}
                  rows={d.results}
                  rowKey={r => String(r.key)}
                  exportName={`compare-${rows}-${d.from}-${d.to}`}
                />
              </Card>
              <div class="grid-2">
                <Card title={`Value at each ${period} end`}>
                  <Chart build={buildValue} height={320} label="Value at each period end" />
                </Card>
                {withMarks.length > 0 && (
                  <Card
                    title="Per-share marks (median of the funds filing that day; index: first mark = 100)"
                    actions={
                      <Segmented
                        label="Scale"
                        value={indexed ? 'idx' : 'usd'}
                        onChange={v => setIndexed(v === 'idx')}
                        options={[
                          { id: 'usd', label: '$/sh, log' },
                          { id: 'idx', label: 'Index' },
                        ]}
                      />
                    }
                  >
                    <Chart build={buildMarks} height={320} label="Median per-share marks by mark date" />
                  </Card>
                )}
              </div>
              <Card title="Value by period" flush>
                <DataTable
                  basis={BASIS}
                  source={d}
                  columns={periodCols}
                  rows={periodRows}
                  rowKey={x => x.p.to}
                  exportName={`compare-${rows}-values-${d.from}-${d.to}`}
                />
              </Card>
            </>
          )}
        </>
      )}
    </div>
  );
}

function Picker({
  kind,
  keys,
  labels,
  onChange,
}: {
  kind: Rows;
  keys: string[];
  labels: Map<string, string>;
  onChange: (keys: string[]) => void;
}) {
  const [q, setQ] = useState('');
  const term = q.trim();
  const search = KINDS.find(k => k.id === kind)!.search;
  const hits = useApi<{ results: UnifiedHit[] }>(
    term.length >= 2 && keys.length < 5 ? `/api/search${qs({ q: term, kinds: search, limit: 8 })}` : null
  );
  const options = (hits.data?.results ?? []).flatMap(h =>
    h.type === 'company' && h.id != null && kind === 'company'
      ? [{ key: String(h.id), label: h.name }]
      : h.type === 'firm' && kind === 'firm'
        ? [{ key: String(h.id), label: h.name }]
        : h.type === 'fund' && kind === 'fund'
          ? [{ key: h.fundKey, label: h.name }]
          : h.type === 'class' && kind === 'class'
            ? [{ key: `${h.companyId}:${h.classLabel}`, label: `${h.company} · ${h.classLabel}` }]
            : []
  );
  return (
    <div class="stack" style={{ gap: '6px' }}>
      <div class="row wrap">
        {keys.map(k => (
          <span class="chip" key={k}>
            {labels.get(k) ?? k}
            <button
              type="button"
              aria-label={`Remove ${labels.get(k) ?? k}`}
              onClick={() => onChange(keys.filter(x => x !== k))}
            >
              ×
            </button>
          </span>
        ))}
        {keys.length < 5 && (
          <input
            class="input"
            type="search"
            placeholder={`Add a ${kind === 'class' ? 'share class (e.g. Stripe Series I)' : kind}…`}
            aria-label={`Add a ${kind}`}
            value={q}
            onInput={e => setQ((e.target as HTMLInputElement).value)}
            style={{ width: '280px' }}
          />
        )}
      </div>
      {term.length >= 2 && (
        <div class="row wrap">
          {hits.loading && <span class="muted small">Searching…</span>}
          {!hits.loading && !options.length && <span class="muted small">No match.</span>}
          {options
            .filter(o => !keys.includes(o.key))
            .map(o => (
              <button
                key={o.key}
                class="btn sm"
                type="button"
                onClick={() => {
                  onChange([...keys, o.key]);
                  setQ('');
                }}
              >
                + {o.label}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
