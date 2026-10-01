import { useCallback, useMemo } from 'preact/hooks';
import { useRoute } from 'preact-iso';
import { qs, useApi } from '../api/client';
import type {
  Activity,
  ClassesAsOf,
  Company as CompanyT,
  CompanyStats,
  Envelope,
  Exposure,
  Freshness,
  Holding,
  MarkSeries,
  Position,
  TrendPoint,
} from '../api/types';
import { firmPath, fundPath, longDate, money, moneyC, num, pct, price, share } from '../lib/format';
import { ScopeBar } from '../scope/ScopeBar';
import { isRange, useParam, useScope } from '../scope/scope';
import { Badge, Card, Empty, ErrorBox, FilingRef, Kpi, Loading, Tabs } from '../ui/bits';
import { ChangesTable } from '../ui/ChangesTable';
import { Chart } from '../ui/Chart';
import { DataTable, type Column } from '../ui/DataTable';
import { baseOption, type ChartTheme } from '../ui/theme';

// The company workbench: one private company across every fund that reports
// it. Overview (value and holders over time), Holders (as of a date), Changes
// (position changes over a range) and Marks (per-share marks by class).

interface Head extends Envelope {
  company?: CompanyT;
  stats?: CompanyStats;
  brands?: { brand: string }[];
  entity?: { id: number; key: string; name: string; category: string; names: string[] };
  label?: string;
  answeredBy: { source: string; reason?: string };
}

interface Live {
  source: 'live';
  reason?: string;
}

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'holders', label: 'Holders' },
  { id: 'changes', label: 'Changes' },
  { id: 'marks', label: 'Marks & classes' },
];

export default function Company() {
  const { params, path } = useRoute();
  const isEntity = path.startsWith('/name/');
  const id = isEntity ? null : Number.parseInt(String(params.slug), 10);
  const base = isEntity ? `/api/entities/${encodeURIComponent(params.key ?? '')}` : `/api/companies/${id}`;
  const [tab, setTab] = useParam('tab');
  const [stored, setStored] = useParam('stored');
  const current = TABS.some(t => t.id === tab) ? tab : 'overview';
  const fresh = useApi<Freshness>('/api/freshness');
  const head = useApi<Head>(!isEntity && !Number.isInteger(id) ? null : base);
  const h = head.data;
  const name = h?.company?.name ?? h?.entity?.name ?? '';
  const listed = h?.answeredBy?.source === 'live';
  const sq: Record<string, number> = stored ? { stored: 1 } : {};

  if (!isEntity && !Number.isInteger(id)) return <Empty>Not a company id.</Empty>;
  return (
    <div class="stack">
      <ErrorBox error={head.error} />
      {head.loading && !h && <Loading rows={3} />}
      {h && (
        <>
          <div class="page-head">
            <div>
              <div class="eyebrow">{isEntity ? 'Unreviewed name' : 'Private company'}</div>
              <h1>{name}</h1>
              <div class="row wrap" style={{ marginTop: '6px' }}>
                {h.company?.status === 'public' ? (
                  <Badge tone="warn">Listed</Badge>
                ) : (
                  <Badge tone="info">Private</Badge>
                )}
                {h.company?.tracked && <Badge tone="accent">Tracked</Badge>}
                {isEntity && (
                  <Badge tone="warn" title="Not yet reviewed into a company">
                    Unreviewed
                  </Badge>
                )}
                {h.brands?.map(b => (
                  <Badge key={b.brand}>Brand: {b.brand}</Badge>
                ))}
                {h.entity && h.entity.names.length > 1 && (
                  <span class="muted small">Also filed as {h.entity.names.slice(1, 4).join(', ')}</span>
                )}
              </div>
            </div>
            <span class="spacer" />
            {!isEntity && (
              <a class="btn sm" href={`${base}/feed.xml`} target="_blank" rel="noopener">
                Atom feed
              </a>
            )}
          </div>
          {listed && (
            <div class="notice warn">
              This company is listed. The warehouse keeps its private-era marks and restricted rows only; funds holding
              its listed stock are not in these rows.{' '}
              <button class="btn sm" type="button" onClick={() => setStored(stored ? '' : '1')}>
                {stored ? 'Hide stored rows' : 'Show stored private-era rows'}
              </button>
            </div>
          )}
          {h.stats && (
            <div class="kpis">
              <Kpi
                label="Funds holding now"
                value={num(h.stats.current_funds)}
                sub={`as of ${longDate(h.stats.as_of)}`}
              />
              <Kpi label="Value now" value={moneyC(h.stats.current_value_usd)} />
              <Kpi label="Funds ever" value={num(h.stats.funds_ever)} />
              <Kpi label="First reported" value={longDate(h.stats.first_mark_date)} />
              <Kpi label="Latest mark" value={longDate(h.stats.last_mark_date)} />
            </div>
          )}
          {(!listed || stored) && (
            <>
              <Tabs tabs={TABS} current={current} onSelect={t => setTab(t === 'overview' ? '' : t)} />
              {current === 'overview' && (
                <Overview base={base} sq={sq} name={name} newest={fresh.data?.newestReportDate ?? null} />
              )}
              {current === 'holders' && (
                <Holders base={base} sq={sq} name={name} newest={fresh.data?.newestReportDate ?? null} />
              )}
              {current === 'changes' && (
                <Changes base={base} sq={sq} name={name} newest={fresh.data?.newestReportDate ?? null} />
              )}
              {current === 'marks' && (
                <Marks base={base} sq={sq} name={name} newest={fresh.data?.newestReportDate ?? null} />
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

interface ViewProps {
  base: string;
  sq: Record<string, number>;
  name: string;
  newest: string | null;
}

function Overview({ base, sq, name, newest }: ViewProps) {
  const [scope, setScope] = useScope();
  const trend = useApi<Envelope & { points: TrendPoint[] }>(`${base}/trend${qs(sq)}`);
  const pts = trend.data?.points ?? [];
  const range = isRange(scope);

  const onZoom = useCallback(
    (_p: unknown, chart: { getOption: () => unknown }) => {
      const opt = chart.getOption() as { dataZoom?: { startValue?: number; endValue?: number }[] };
      const z = opt.dataZoom?.[0];
      if (!z || z.startValue == null || z.endValue == null) return;
      const from = pts[z.startValue]?.date;
      const to = pts[z.endValue]?.date;
      if (from && to && (from !== scope.from || to !== scope.to)) setScope({ from, to, asof: '' }, { replace: true });
    },
    [pts, scope.from, scope.to]
  );

  const build = useCallback(
    (t: ChartTheme) => {
      const b = baseOption(t);
      const dates = pts.map(p => p.date);
      const startIdx = range
        ? Math.max(
            0,
            dates.findIndex(d => d >= scope.from)
          )
        : 0;
      let endIdx = range ? dates.findIndex(d => d > scope.to) - 1 : dates.length - 1;
      if (endIdx < 0) endIdx = dates.length - 1;
      return {
        ...b,
        legend: { ...b.legend, data: ['Value', 'Funds holding'] },
        grid: { ...b.grid, bottom: 48 },
        tooltip: {
          ...b.tooltip,
          valueFormatter: (v: number) => (v > 10000 ? moneyC(v) : num(v)),
        },
        xAxis: { type: 'category', data: dates, boundaryGap: false, ...b.xAxisDefaults },
        yAxis: [
          { type: 'value', ...b.yAxisDefaults, axisLabel: { ...b.yAxisDefaults.axisLabel, formatter: moneyC } },
          { type: 'value', ...b.yAxisDefaults, splitLine: { show: false }, minInterval: 1 },
        ],
        dataZoom: [
          { type: 'slider', startValue: startIdx, endValue: endIdx, height: 22, bottom: 6 },
          { type: 'inside', startValue: startIdx, endValue: endIdx },
        ],
        series: [
          {
            name: 'Value',
            type: 'line',
            data: pts.map(p => p.total),
            areaStyle: { opacity: 0.18 },
            showSymbol: false,
            lineStyle: { width: 2 },
          },
          {
            name: 'Funds holding',
            type: 'line',
            yAxisIndex: 1,
            step: 'end',
            data: pts.map(p => p.funds),
            showSymbol: false,
            lineStyle: { width: 1.5, type: 'dashed' },
          },
        ],
      };
    },
    [pts, range, scope.from, scope.to]
  );

  const shown = range ? pts.filter(p => p.date >= scope.from && p.date <= scope.to) : pts;
  const columns: Column<TrendPoint>[] = [
    { id: 'date', header: 'Month end', value: p => p.date },
    { id: 'funds', header: 'Funds holding', value: p => p.funds, num: true },
    { id: 'total', header: 'Value', value: p => p.total, num: true, render: p => moneyC(p.total) },
    { id: 'entered', header: 'Funds entered', value: p => p.entered, num: true },
    { id: 'left', header: 'Funds left', value: p => p.left, num: true },
    { id: 'zero', header: 'Reported at $0', value: p => p.zeroValue, num: true },
  ];

  return (
    <div class="stack">
      <div class="row wrap">
        <ScopeBar supports={{ range: true, asof: true }} newest={newest} />
      </div>
      <ErrorBox error={trend.error} />
      {trend.loading && !trend.data && <Loading rows={5} />}
      {trend.data && (
        <>
          <Card
            title="Value and holders at each month end"
            actions={
              <span class="muted small">Drag the slider to set the range · as of each month end, mixed mark dates</span>
            }
          >
            {pts.length ? (
              <Chart
                build={build}
                height={340}
                label={`${name}: value and funds holding by month`}
                on={{ datazoom: onZoom }}
              />
            ) : (
              <Empty>No stored marks.</Empty>
            )}
          </Card>
          <Card title="By month" flush>
            <DataTable
              columns={columns}
              rows={shown}
              rowKey={p => p.date}
              sort={{ id: 'date', desc: true }}
              exportName={`${name}-trend`}
              maxHeight={420}
            />
          </Card>
        </>
      )}
    </div>
  );
}

interface PosRow extends Position {
  h: Holding;
}

function Holders({ base, sq, name, newest }: ViewProps) {
  const [scope] = useScope();
  const exp = useApi<Exposure & Partial<Live>>(`${base}/exposure${qs({ date: scope.asof, ...sq })}`);
  const d = exp.data;
  const rows = useMemo(() => {
    const out: PosRow[] = [];
    for (const h of d?.holdings ?? []) for (const p of h.positions ?? []) out.push({ ...p, h });
    return out.filter(
      r =>
        (!scope.classes.length || scope.classes.includes(r.instrumentLabel)) &&
        (!scope.kind || (scope.kind === 'indirect') === r.viaSpv) &&
        (!scope.funds.length || scope.funds.includes(r.h.fundKey))
    );
  }, [d, scope.classes, scope.kind, scope.funds]);
  const total = rows.reduce((s, r) => s + (r.valueUsd || 0), 0);

  const columns: Column<PosRow>[] = [
    {
      id: 'fund',
      header: 'Fund',
      value: r => r.h.fundLabel || r.h.seriesName || r.h.registrant,
      render: r => <a href={fundPath(r.h.fundKey)}>{r.h.fundLabel || r.h.seriesName}</a>,
      exportAs: [
        { header: 'Fund key', value: r => r.h.fundKey },
        { header: 'Registrant', value: r => r.h.registrant },
      ],
      wrap: true,
    },
    {
      id: 'markDate',
      header: 'Mark date',
      value: r => r.h.markDate,
      render: r => <FilingRef cik={r.h.cik} accession={r.h.accession} date={r.h.markDate} />,
      exportAs: [{ header: 'Accession', value: r => r.h.accession }],
    },
    {
      id: 'class',
      header: 'Class',
      value: r => r.instrumentLabel,
      render: r => (
        <span title={r.title}>
          {r.instrumentLabel} {r.viaSpv && <Badge tone="info">indirect</Badge>}
        </span>
      ),
      exportAs: [
        { header: 'Title', value: r => r.title },
        { header: 'Instrument key', value: r => r.instrumentKey },
        { header: 'Indirect (SPV)', value: r => r.viaSpv },
      ],
    },
    {
      id: 'shares',
      header: 'Shares / units',
      value: r => r.balance,
      num: true,
      render: r => num(r.balance),
      exportAs: [{ header: 'Unit', value: r => r.unit }],
    },
    {
      id: 'price',
      header: 'Mark',
      value: r => r.pricePerShare ?? r.pricePerUnit,
      num: true,
      render: r => price(r.pricePerShare ?? r.pricePerUnit, r.unit),
    },
    { id: 'value', header: 'Value', value: r => r.valueUsd, num: true, render: r => moneyC(r.valueUsd) },
    { id: 'pctNav', header: '% of fund', value: r => r.pctNav, num: true, render: r => share(r.pctNav) },
    { id: 'level', header: 'FV level', value: r => r.fvLevel, num: true },
  ];

  const others = (list: Holding[] | undefined, title: string, note: string) =>
    list && list.length > 0 ? (
      <Card title={`${title} (${list.length})`} actions={<span class="muted small">{note}</span>} flush>
        <DataTable
          columns={[
            {
              id: 'fund',
              header: 'Fund',
              value: (h: Holding) => h.fundLabel || h.seriesName || h.registrant,
              render: (h: Holding) => <a href={fundPath(h.fundKey)}>{h.fundLabel || h.seriesName}</a>,
              wrap: true,
            },
            {
              id: 'mark',
              header: 'Latest filing',
              value: (h: Holding) => h.markDate,
              render: (h: Holding) => <FilingRef cik={h.cik} accession={h.accession} date={h.markDate} />,
              exportAs: [{ header: 'Accession', value: (h: Holding) => h.accession }],
            },
            {
              id: 'last',
              header: 'Last reported holding',
              value: (h: Holding) => h.lastHeldDate,
              render: (h: Holding) => <FilingRef cik={h.cik} accession={h.lastHeldAccession} date={h.lastHeldDate} />,
            },
          ]}
          rows={list}
          rowKey={h => h.fundKey}
          sort={{ id: 'last', desc: true }}
          exportName={`${name}-${title}`}
        />
      </Card>
    ) : null;

  return (
    <div class="stack">
      <div class="row wrap">
        <ScopeBar supports={{ asof: true, filters: true }} newest={newest} />
      </div>
      <ErrorBox error={exp.error} />
      {exp.loading && !d && <Loading rows={6} />}
      {d && (
        <>
          <div class="kpis">
            <Kpi label="Funds holding" value={num(d.funds)} sub={`as of ${longDate(d.date)}`} />
            <Kpi label="Value" value={moneyC(d.total)} sub="each fund at its own mark date" />
            <Kpi
              label="Positions shown"
              value={num(rows.length)}
              sub={total !== d.total ? `${moneyC(total)} after filters` : undefined}
            />
            <Kpi label="No longer reported" value={num(d.exited.length)} sub="since their last holding" />
          </div>
          <Card title={`Holders as of ${longDate(d.date)}`} flush>
            <DataTable
              columns={columns}
              rows={rows}
              rowKey={r => `${r.h.fundKey}:${r.rowKey}`}
              sort={{ id: 'value', desc: true }}
              exportName={`${name}-holders-${d.date}`}
              filterPlaceholder="Filter funds or classes…"
              maxHeight={620}
              totals={{ fund: 'Total', value: moneyC(total) }}
            />
          </Card>
          {d.disclosedExposure.length > 0 && (
            <Card title="Disclosed without naming vehicles">
              <ul>
                {d.disclosedExposure.map(x => (
                  <li key={x.fundKey + x.reportDate}>
                    {x.fundKey}: “{x.basis}” ({x.reportDate}, {x.sourceAccession})
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {others(d.zeroValue, 'Reported at $0', 'still reported, valued at $0')}
          {others(d.exited, 'No longer reported', 'the fund’s latest filing has no row for the company')}
          {others(d.inactive, 'Fund stopped filing', 'no N-PORT within 123 days of the date')}
        </>
      )}
    </div>
  );
}

function Changes({ base, sq, name, newest }: ViewProps) {
  const [scope] = useScope();
  const range = isRange(scope);
  const act = useApi<Activity>(
    `${base}/activity${qs({ since: range ? scope.from : '', until: range ? scope.to : '', ...sq })}`
  );
  const events = useMemo(
    () => (act.data?.events ?? []).filter(e => !scope.funds.length || scope.funds.includes(e.fundKey)),
    [act.data, scope.funds]
  );
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const e of events) c[e.label] = (c[e.label] ?? 0) + 1;
    return c;
  }, [events]);
  return (
    <div class="stack">
      <div class="row wrap">
        <ScopeBar supports={{ range: true, asof: false, filters: true }} newest={newest} />
        {!range && <span class="muted small">All changes since the first filing. Pick a range to narrow.</span>}
      </div>
      <ErrorBox error={act.error} />
      {act.loading && !act.data && <Loading rows={6} />}
      {act.data && (
        <>
          <div class="kpis">
            {['first reported', 'added', 'reduced', 'no longer reported', 'mark moved'].map(k => (
              <Kpi key={k} label={k} value={num(counts[k] ?? 0)} />
            ))}
          </div>
          <Card title="Position changes, filing by filing" flush>
            <ChangesTable events={events} exportName={`${name}-changes`} />
          </Card>
        </>
      )}
    </div>
  );
}

function Marks({ base, sq, name, newest }: ViewProps) {
  const [scope] = useScope();
  const [cls, setCls] = useParam('cls');
  const marks = useApi<MarkSeries>(`${base}/marks${qs(sq)}`);
  const classes = useApi<ClassesAsOf>(`${base}/classes${qs({ date: scope.asof, ...sq })}`);
  const m = marks.data;
  const shownClasses = useMemo(() => {
    const all = m?.classes ?? [];
    if (cls) return all.filter(c => c === cls);
    // the classes with the most points first, at most 6 lines
    const n = new Map<string, number>();
    for (const s of m?.series ?? []) n.set(s.instrument, (n.get(s.instrument) ?? 0) + s.funds);
    return [...all].sort((a, b) => (n.get(b) ?? 0) - (n.get(a) ?? 0)).slice(0, 6);
  }, [m, cls]);

  const build = useCallback(
    (t: ChartTheme) => {
      const b = baseOption(t);
      return {
        ...b,
        grid: { ...b.grid, bottom: 48 },
        tooltip: { ...b.tooltip, valueFormatter: (v: number) => money(v) },
        xAxis: { type: 'time', ...b.xAxisDefaults },
        yAxis: {
          type: 'value',
          scale: true,
          ...b.yAxisDefaults,
          axisLabel: { ...b.yAxisDefaults.axisLabel, formatter: (v: number) => `$${v}` },
        },
        dataZoom: [{ type: 'slider', height: 22, bottom: 6 }, { type: 'inside' }],
        series: shownClasses.flatMap((c, i) => {
          const pts = (m?.series ?? []).filter(s => s.instrument === c);
          const color = t.series[i % t.series.length];
          return [
            {
              name: c,
              type: 'line',
              data: pts.map(s => [s.markDate, s.median]),
              showSymbol: true,
              symbolSize: 5,
              itemStyle: { color },
            },
            ...(cls
              ? [
                  {
                    name: `${c} low–high`,
                    type: 'scatter',
                    data: pts.flatMap(s =>
                      s.low != null && s.high != null && s.low !== s.high
                        ? [
                            [s.markDate, s.low],
                            [s.markDate, s.high],
                          ]
                        : []
                    ),
                    symbolSize: 4,
                    itemStyle: { color, opacity: 0.45 },
                  },
                ]
              : []),
          ];
        }),
      };
    },
    [m, shownClasses, cls]
  );

  type ClassRow = ClassesAsOf['classes'][number]['byMarkDate'][number] & { instrument: string; classValue: number };
  const classRows: ClassRow[] = useMemo(
    () =>
      (classes.data?.classes ?? []).flatMap(c =>
        c.byMarkDate.map(b => ({ ...b, instrument: c.instrument, classValue: c.value }))
      ),
    [classes.data]
  );

  return (
    <div class="stack">
      <div class="row wrap">
        <ScopeBar supports={{ asof: true }} newest={newest} />
        <span class="spacer" />
        <label class="row small">
          Class
          <select
            class="input"
            value={cls}
            onChange={e => setCls((e.target as HTMLSelectElement).value, { replace: true })}
          >
            <option value="">Most-held classes</option>
            {(m?.classes ?? []).map(c => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
      </div>
      <ErrorBox error={marks.error || classes.error} />
      {marks.loading && !m && <Loading rows={5} />}
      {m && (
        <Card
          title="Per-share mark by class (median across funds at each mark date)"
          actions={<span class="muted small">split-adjusted within each fund's series</span>}
        >
          {m.series.length ? (
            <Chart build={build} height={360} label={`${name}: per-share marks by class`} />
          ) : (
            <Empty>No per-share marks.</Empty>
          )}
        </Card>
      )}
      {classes.data && (
        <Card title={`Marks by class as of ${longDate(classes.data.date)}`} flush>
          <DataTable
            columns={[
              { id: 'instrument', header: 'Class', value: r => r.instrument },
              { id: 'markDate', header: 'Mark date', value: r => r.markDate },
              { id: 'funds', header: 'Funds', value: r => r.funds, num: true },
              { id: 'median', header: 'Median', value: r => r.median, num: true, render: r => money(r.median) },
              { id: 'low', header: 'Low', value: r => r.low, num: true, render: r => money(r.low) },
              { id: 'high', header: 'High', value: r => r.high, num: true, render: r => money(r.high) },
              {
                id: 'spread',
                header: 'Spread',
                value: r => r.spreadPct,
                num: true,
                render: r => (r.spreadPct ? pct(r.spreadPct) : '—'),
              },
              {
                id: 'firms',
                header: 'Firms',
                value: r => r.firms.map(f => f.name).join('; '),
                render: r => (
                  <span class="small">
                    {r.firms.map((f, i) => (
                      <span key={f.id}>
                        {i > 0 && ', '}
                        <a href={firmPath(f.id)}>{f.name}</a>
                      </span>
                    ))}
                  </span>
                ),
                wrap: true,
              },
            ]}
            rows={classRows}
            rowKey={r => `${r.instrument}:${r.markDate}`}
            sort={{ id: 'funds', desc: true }}
            exportName={`${name}-classes-${classes.data.date}`}
            maxHeight={520}
          />
        </Card>
      )}
    </div>
  );
}
