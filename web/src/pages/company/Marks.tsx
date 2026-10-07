import { useCallback, useMemo } from 'preact/hooks';
import { qs, useApi } from '../../api/client';
import type { ClassesAsOf, Envelope, FirmRef, Leadership, MarkSeries } from '../../api/types';
import { firmPath, fundPath, longDate, money, num, pct } from '../../lib/format';
import { ScopeBar } from '../../scope/ScopeBar';
import { scopeParams, useParam, useScope } from '../../scope/scope';
import { Card, Empty, ErrorBox, FilingRef, Loading } from '../../ui/bits';
import { Chart } from '../../ui/Chart';
import { DataTable } from '../../ui/DataTable';
import { baseOption, type ChartTheme } from '../../ui/theme';
import { FilterPickers, useFilterOptions, type ViewProps } from './shared';

// Per-share marks by class (share rows only, trap 40; split-adjusted within a
// fund's series), each class's spread across funds at one mark date, gaps
// between classes within one filing (F30), stale marks, and mark leadership:
// which firm first filed each new per-share level, as filed. Funds report on
// staggered calendars, so a lag is shown beside each firm's previous mark date.

interface Stale extends Envelope {
  stale: {
    fundKey: string;
    fund: string;
    firms: FirmRef[];
    cik: string;
    instrument: string;
    pricePerShare: number;
    unchangedSince: string;
    reports: number;
    lastMarkDate: string;
    accession: string;
    marketMovePct: number;
  }[];
}

type LevelRow = Leadership['levels'][number];
type ClassRow = ClassesAsOf['classes'][number]['byMarkDate'][number] & { instrument: string };
type GapRow = ClassesAsOf['withinFiling'][number];

export default function Marks({ base, sq, name, newest }: ViewProps) {
  const [scope] = useScope();
  const [cls, setCls] = useParam('cls');
  const opts = useFilterOptions(base, sq);
  const filters = scopeParams(scope, ['firm', 'fund', 'kind']);
  const marks = useApi<MarkSeries>(`${base}/marks${qs({ ...sq, ...filters })}`);
  const classes = useApi<ClassesAsOf>(`${base}/classes${qs({ date: scope.asof, ...sq, ...filters })}`);
  // Leadership compares firms, so it always reads every firm (only "how held" narrows it).
  const lead = useApi<Leadership>(
    `${base}/leadership${qs({ instrument: cls, ...sq, ...scopeParams(scope, ['kind']) })}`
  );
  const stale = useApi<Stale>(`${base}/stale${qs({ ...sq, ...filters })}`);
  const m = marks.data;

  const shownClasses = useMemo(() => {
    const all = m?.classes ?? [];
    if (cls) return all.filter(c => c === cls);
    const n = new Map<string, number>();
    for (const s of m?.series ?? []) n.set(s.instrument, (n.get(s.instrument) ?? 0) + s.funds);
    return [...all].sort((a, b) => (n.get(b) ?? 0) - (n.get(a) ?? 0)).slice(0, 6);
  }, [m, cls]);

  const build = useCallback(
    (t: ChartTheme) => {
      const b = baseOption(t);
      let series: Record<string, unknown>[];
      if (!cls) {
        // each class's median across funds per mark date
        series = shownClasses.map((c, i) => ({
          name: c,
          type: 'line',
          data: (m?.series ?? []).filter(s => s.instrument === c).map(s => [s.markDate, s.median]),
          showSymbol: true,
          symbolSize: 5,
          itemStyle: { color: t.series[i % t.series.length] },
        }));
      } else {
        // one class: every firm's own line over the low–high band across funds
        const pts = (m?.series ?? []).filter(s => s.instrument === cls);
        const fs = (m?.firmSeries ?? []).filter(s => s.instrument === cls);
        const count = new Map<number, number>();
        for (const x of fs) count.set(x.firmId, (count.get(x.firmId) ?? 0) + x.funds);
        const top = [...count.entries()].sort((a, c) => c[1] - a[1]).slice(0, 8);
        series = [
          {
            name: 'Low',
            type: 'line',
            stack: 'band',
            data: pts.map(s => [s.markDate, s.low]),
            lineStyle: { opacity: 0 },
            symbol: 'none',
            tooltip: { show: false },
          },
          {
            name: 'Low–high across funds',
            type: 'line',
            stack: 'band',
            data: pts.map(s => [s.markDate, (s.high ?? 0) - (s.low ?? 0)]),
            lineStyle: { opacity: 0 },
            symbol: 'none',
            areaStyle: { color: t.border, opacity: 0.6 },
            itemStyle: { color: t.text3 },
            tooltip: { show: false },
          },
          ...top.map(([firmId], i) => {
            const rows = fs.filter(x => x.firmId === firmId);
            return {
              name: rows[0]?.firm ?? `Firm ${firmId}`,
              type: 'line',
              data: rows.map(x => [x.markDate, x.median]),
              showSymbol: true,
              symbolSize: 6,
              itemStyle: { color: t.series[i % t.series.length] },
            };
          }),
        ];
      }
      return {
        ...b,
        legend: { ...b.legend, data: series.map(x => x.name as string).filter(n => n !== 'Low') },
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
        series,
      };
    },
    [m, shownClasses, cls]
  );

  const classRows: ClassRow[] = useMemo(
    () =>
      (classes.data?.classes ?? [])
        .filter(c => !cls || c.instrument === cls)
        .flatMap(c => c.byMarkDate.map(b => ({ ...b, instrument: c.instrument }))),
    [classes.data, cls]
  );
  const levels = useMemo(() => (lead.data?.levels ?? []).filter(l => l.firms > 1), [lead.data]);
  const firmLinks = (firms: FirmRef[]) => (
    <span class="small">
      {firms.map((f, i) => (
        <span key={f.id}>
          {i > 0 && ', '}
          <a href={firmPath(f.id)}>{f.name}</a>
        </span>
      ))}
    </span>
  );

  return (
    <div class="stack">
      <div class="row wrap">
        <ScopeBar
          supports={{ asof: true, filters: ['firm', 'fund', 'kind'] }}
          newest={newest}
          fundName={opts.fundName}
        />
        <FilterPickers firms={opts.firms} kinds={opts.indirect} />
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
      <ErrorBox error={marks.error || classes.error || lead.error || stale.error} />
      {marks.loading && !m && <Loading rows={5} />}
      {m && (
        <Card
          title={
            cls
              ? `${cls}: each firm's per-share mark, over the low–high band across funds`
              : 'Per-share mark by class (median across funds at each mark date)'
          }
          actions={<span class="muted small">split-adjusted within each fund's series</span>}
        >
          {m.series.length ? (
            <Chart build={build} height={360} label={`${name}: per-share marks by class`} />
          ) : (
            <Empty>No per-share marks.</Empty>
          )}
        </Card>
      )}
      {lead.data && (
        <Card
          title={`Mark leadership${cls ? `: ${cls}` : ''} (all firms)`}
          actions={
            <span class="muted small">
              who first filed each new per-share level (moves over {lead.data.tolerancePct}%, levels within{' '}
              {lead.data.tolerancePct}%); funds file on staggered calendars, so compare each firm’s previous mark date
            </span>
          }
          flush
        >
          {levels.length ? (
            <DataTable
              columns={[
                { id: 'instrument', header: 'Class', value: (l: LevelRow) => l.instrument },
                { id: 'mark', header: 'Level', value: (l: LevelRow) => l.mark, num: true, render: l => money(l.mark) },
                { id: 'first', header: 'First filed', value: (l: LevelRow) => l.firstDate },
                {
                  id: 'leader',
                  header: 'First by',
                  value: (l: LevelRow) =>
                    l.adopters
                      .filter(a => a.lagDays === 0)
                      .map(a => a.firm)
                      .join(', '),
                  render: l => (
                    <span class="small">
                      {l.adopters
                        .filter(a => a.lagDays === 0)
                        .map((a, i) => (
                          <span key={a.firmId}>
                            {i > 0 && ', '}
                            <a href={firmPath(a.firmId)}>{a.firm}</a>{' '}
                            <span class="muted">
                              from {money(a.prevMark)} ({pct(a.movePct)})
                            </span>
                          </span>
                        ))}
                    </span>
                  ),
                  wrap: true,
                },
                {
                  id: 'followers',
                  header: 'Then',
                  value: (l: LevelRow) =>
                    l.adopters
                      .filter(a => a.lagDays > 0)
                      .map(a => `${a.firm} +${a.lagDays}d`)
                      .join('; '),
                  render: l => (
                    <span class="small">
                      {l.adopters
                        .filter(a => a.lagDays > 0)
                        .map((a, i) => (
                          <span key={a.firmId} title={`previous mark ${money(a.prevMark)} on ${a.prevMarkDate}`}>
                            {i > 0 && '; '}
                            <a href={firmPath(a.firmId)}>{a.firm}</a> {a.markDate} (+{a.lagDays}d; prior mark{' '}
                            {a.prevMarkDate})
                          </span>
                        ))}
                    </span>
                  ),
                  wrap: true,
                  noSort: true,
                },
                { id: 'firms', header: 'Firms', value: (l: LevelRow) => l.firms, num: true },
              ]}
              rows={levels}
              rowKey={l => `${l.instrument}:${l.mark}:${l.firstDate}`}
              sort={{ id: 'first', desc: true }}
              exportName={`${name}-mark-leadership`}
              maxHeight={420}
            />
          ) : (
            <Empty>No per-share level was filed by more than one firm{cls ? ` for ${cls}` : ''}.</Empty>
          )}
          {lead.data.firms.length > 0 && (
            <div class="card-body">
              <div class="muted small" style={{ marginBottom: '6px' }}>
                By firm, over levels two or more firms filed
              </div>
              <DataTable
                columns={[
                  {
                    id: 'firm',
                    header: 'Firm',
                    value: (f: Leadership['firms'][number]) => f.firm,
                    render: f => <a href={firmPath(f.firmId)}>{f.firm}</a>,
                  },
                  { id: 'levels', header: 'Levels', value: f => f.levels, num: true },
                  { id: 'first', header: 'Filed first', value: f => f.first, num: true },
                  {
                    id: 'lag',
                    header: 'Median lag otherwise',
                    value: f => f.medianLagDays,
                    num: true,
                    render: f => (f.medianLagDays == null ? '—' : `${num(f.medianLagDays)} days`),
                  },
                ]}
                rows={lead.data.firms}
                rowKey={f => String(f.firmId)}
                sort={{ id: 'first', desc: true }}
                exportName={`${name}-mark-leadership-firms`}
                maxHeight={300}
              />
            </div>
          )}
        </Card>
      )}
      {classes.data && (
        <Card title={`Marks by class as of ${longDate(classes.data.date)}`} flush>
          <DataTable
            columns={[
              { id: 'instrument', header: 'Class', value: (r: ClassRow) => r.instrument },
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
                title: 'High against low at the same mark date, as filed',
              },
              {
                id: 'firms',
                header: 'Firms',
                value: r => r.firms.map(f => f.name).join('; '),
                render: r => firmLinks(r.firms),
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
      {classes.data && classes.data.withinFiling.length > 0 && (
        <Card
          title="Classes marked apart within one filing"
          actions={
            <span class="muted small">each class against the filing’s lowest mark (F30); no method guessed</span>
          }
          flush
        >
          <DataTable
            columns={[
              {
                id: 'fund',
                header: 'Fund',
                value: (g: GapRow) => g.fund,
                render: g => <a href={fundPath(g.fundKey)}>{g.fund}</a>,
                wrap: true,
              },
              {
                id: 'markDate',
                header: 'Mark date',
                value: g => g.markDate,
                render: g => <FilingRef cik={g.cik} accession={g.accession} date={g.markDate} />,
              },
              {
                id: 'classes',
                header: 'Classes',
                value: g => g.classes.map(c => `${c.instrument} ${money(c.pricePerShare)}`).join('; '),
                render: g => (
                  <span class="small">
                    {g.classes
                      .map(
                        c => `${c.instrument} ${money(c.pricePerShare)}${c.vsLowPct ? ` (${pct(c.vsLowPct, 2)})` : ''}`
                      )
                      .join(' · ')}
                  </span>
                ),
                wrap: true,
                noSort: true,
              },
            ]}
            rows={classes.data.withinFiling}
            rowKey={g => g.accession}
            sort={{ id: 'markDate', desc: true }}
            exportName={`${name}-class-gaps`}
            maxHeight={360}
          />
        </Card>
      )}
      {stale.data && stale.data.stale.length > 0 && (
        <Card
          title={`Stale marks (${stale.data.stale.length})`}
          actions={<span class="muted small">the same mark for 3+ filings while the class median moved over 1%</span>}
          flush
        >
          <DataTable
            columns={[
              {
                id: 'fund',
                header: 'Fund',
                value: (s: Stale['stale'][number]) => s.fund,
                render: s => <a href={fundPath(s.fundKey)}>{s.fund}</a>,
                wrap: true,
              },
              { id: 'class', header: 'Class', value: s => s.instrument },
              {
                id: 'mark',
                header: 'Mark',
                value: s => s.pricePerShare,
                num: true,
                render: s => money(s.pricePerShare),
              },
              { id: 'since', header: 'Unchanged since', value: s => s.unchangedSince },
              { id: 'reports', header: 'Filings', value: s => s.reports, num: true },
              {
                id: 'last',
                header: 'Latest',
                value: s => s.lastMarkDate,
                render: s => <FilingRef cik={s.cik} accession={s.accession} date={s.lastMarkDate} />,
              },
              {
                id: 'move',
                header: 'Class median moved',
                value: s => s.marketMovePct,
                num: true,
                render: s => pct(s.marketMovePct),
              },
            ]}
            rows={stale.data.stale}
            rowKey={s => `${s.fundKey}:${s.instrument}`}
            sort={{ id: 'reports', desc: true }}
            exportName={`${name}-stale-marks`}
          />
        </Card>
      )}
    </div>
  );
}
