import { lazy } from 'preact-iso';
import { useCallback, useMemo } from 'preact/hooks';
import { useRoute } from 'preact-iso';
import { qs, useApi } from '../../api/client';
import type { ClassesAsOf, Company as CompanyT, CompanyStats, Envelope, Freshness, TrendPoint } from '../../api/types';
import { longDate, money, moneyC, num } from '../../lib/format';
import { useParam } from '../../scope/scope';
import { Badge, Empty, ErrorBox, Kpi, Loading, Tabs, WatchButton } from '../../ui/bits';
import { Chart } from '../../ui/Chart';
import type { ChartTheme } from '../../ui/theme';
import { PositionDrawer } from './PositionDrawer';
import type { ViewProps } from './shared';

// The company workbench (P6b W2): one private company across every fund that
// reports it. Overview (value by firm, fund or class over time), Holders (as of
// a date, with each fund's change since its prior filing), Positions (fund ×
// mark date grid), Changes (the bridge, flows by period and the ledger), Marks
// & classes (per-share marks, spreads, mark leadership) and Filings (the rows
// behind every number). Any fund row opens its position history in a drawer.
// Every tab reads the scope from the URL and asks the server within it.

const Overview = lazy(() => import('./Overview'));
const Holders = lazy(() => import('./Holders'));
const Positions = lazy(() => import('./Positions'));
const Changes = lazy(() => import('./Changes'));
const Marks = lazy(() => import('./Marks'));
const Filings = lazy(() => import('./Filings'));

interface Head extends Envelope {
  company?: CompanyT;
  stats?: CompanyStats;
  brands?: { brand: string }[];
  entity?: { id: number; key: string; name: string; category: string; names: string[] };
  label?: string;
  answeredBy: { source: string; reason?: string };
}

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'holders', label: 'Holders' },
  { id: 'positions', label: 'Positions' },
  { id: 'changes', label: 'Changes' },
  { id: 'marks', label: 'Marks & classes' },
  { id: 'filings', label: 'Filings' },
];

function Sparkline({ points }: { points: TrendPoint[] }) {
  const build = useCallback(
    (t: ChartTheme) => ({
      grid: { left: 0, right: 0, top: 2, bottom: 2 },
      xAxis: { type: 'category', show: false, data: points.map(p => p.date), boundaryGap: false },
      yAxis: { type: 'value', show: false, scale: true },
      tooltip: { show: false },
      series: [
        {
          type: 'line',
          data: points.map(p => p.total),
          showSymbol: false,
          lineStyle: { width: 1.5, color: t.series[0] },
          areaStyle: { opacity: 0.15, color: t.series[0] },
        },
      ],
      animation: false,
    }),
    [points]
  );
  return <Chart build={build} height={44} label="Value held by month since the first mark" />;
}

export default function Company() {
  const { params, path } = useRoute();
  const isEntity = path.startsWith('/name/');
  const id = isEntity ? null : Number.parseInt(String(params.slug), 10);
  const key = params.key ?? '';
  const base = isEntity ? `/api/entities/${encodeURIComponent(key)}` : `/api/companies/${id}`;
  const [tab, setTab] = useParam('tab');
  const [stored, setStored] = useParam('stored');
  const [pos, setPos] = useParam('pos');
  const current = TABS.some(t => t.id === tab) ? tab : 'overview';
  const fresh = useApi<Freshness>('/api/freshness');
  const valid = isEntity || Number.isInteger(id);
  const head = useApi<Head>(valid ? base : null);
  const h = head.data;
  const name = h?.company?.name ?? h?.entity?.name ?? '';
  const listed = h?.answeredBy?.source === 'live';
  const sq = useMemo<Record<string, number>>(() => (stored ? { stored: 1 } : ({} as Record<string, number>)), [stored]);
  const showViews = !!h && (!listed || !!stored);
  const trend = useApi<Envelope & { points: TrendPoint[] }>(showViews ? `${base}/trend${qs(sq)}` : null);
  const classes = useApi<ClassesAsOf>(showViews ? `${base}/classes${qs(sq)}` : null);

  // The latest per-share mark of the three most-held classes, with its date.
  const latestMarks = useMemo(
    () =>
      (classes.data?.classes ?? [])
        .slice(0, 3)
        .map(c => ({ instrument: c.instrument, at: c.byMarkDate.find(b => b.median != null) }))
        .filter(x => x.at),
    [classes.data]
  );
  const firmCount = useMemo(() => {
    const ids = new Set<number>();
    for (const c of classes.data?.classes ?? []) for (const m of c.marks) for (const f of m.firms) ids.add(f.id);
    return ids.size;
  }, [classes.data]);

  if (!valid) return <Empty>Not a company id.</Empty>;
  const view: ViewProps = {
    base,
    sq,
    subject: { ...(isEntity ? { entity: key } : { company: id as number }), ...sq },
    name,
    newest: fresh.data?.newestReportDate ?? null,
    openPosition: fundKey => setPos(fundKey),
  };
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
            {!isEntity && h.company && <WatchButton kind="company" id={h.company.id} label={name} />}
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
              <Kpi
                label="Value now"
                value={moneyC(h.stats.current_value_usd)}
                sub={trend.data?.points.length ? <Sparkline points={trend.data.points} /> : undefined}
              />
              <Kpi label="Firms holding" value={firmCount ? num(firmCount) : '—'} sub="advisers on the latest N-CEN" />
              <Kpi
                label="Funds ever"
                value={num(h.stats.funds_ever)}
                sub={`first reported ${longDate(h.stats.first_mark_date)}`}
              />
              <Kpi
                label="Latest mark by class"
                value={
                  latestMarks.length ? (
                    <span class="small" style={{ display: 'block', lineHeight: 1.5 }}>
                      {latestMarks.map(m => (
                        <span key={m.instrument} style={{ display: 'block' }}>
                          {m.instrument}: {money(m.at!.median)}
                        </span>
                      ))}
                    </span>
                  ) : (
                    '—'
                  )
                }
                sub={latestMarks[0] ? `median, mark date ${latestMarks[0].at!.markDate}` : undefined}
              />
            </div>
          )}
          {showViews && (
            <>
              <Tabs tabs={TABS} current={current} onSelect={t => setTab(t === 'overview' ? '' : t)} />
              {current === 'overview' && <Overview {...view} />}
              {current === 'holders' && <Holders {...view} />}
              {current === 'positions' && <Positions {...view} />}
              {current === 'changes' && <Changes {...view} />}
              {current === 'marks' && <Marks {...view} />}
              {current === 'filings' && <Filings {...view} />}
            </>
          )}
          {pos && showViews && <PositionDrawer {...view} fundKey={pos} onClose={() => setPos('')} />}
        </>
      )}
    </div>
  );
}
