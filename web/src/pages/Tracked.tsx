import { useEffect, useState } from 'preact/hooks';
import { qs, useApi } from '../api/client';
import type { Freshness, TrackedDashboard, UnifiedHit, WatchKind, WatchlistAnswer } from '../api/types';
import {
  companyPath,
  firmPath,
  fundPath,
  longDate,
  money,
  moneyC,
  moneyDelta,
  num,
  pct,
  signedNum,
  tone,
} from '../lib/format';
import { followRedirects, importV1, removeWatch, v1Entries, watchlist } from '../lib/watchlist';
import { ScopeBar } from '../scope/ScopeBar';
import { useParam, useScope } from '../scope/scope';
import { Badge, Card, Empty, ErrorBox, Kpi, Loading, Tabs } from '../ui/bits';
import { DataTable, type Column } from '../ui/DataTable';

// Tracked & Watchlist (P6b W4): the viewer's own list of companies, firms and
// funds (kept in this browser; numbers from the server, the as-of rule now and
// a year earlier) and the tracked-company dashboard (holders, value, the
// most-held class's median mark and its 12-month change, spread, stale marks).

const KIND_LABEL: Record<WatchKind, string> = { company: 'Company', firm: 'Firm', fund: 'Fund' };
const hrefOf = (kind: WatchKind, key: string | number, label: string) =>
  kind === 'company'
    ? companyPath(Number(key), label)
    : kind === 'firm'
      ? firmPath(Number(key))
      : fundPath(String(key));

export default function Tracked() {
  const [view, setView] = useParam('view');
  const current = view === 'tracked' ? 'tracked' : 'watchlist';
  const [scope] = useScope();
  const fresh = useApi<Freshness>('/api/freshness');
  const newest = fresh.data?.newestReportDate ?? null;
  return (
    <div class="stack">
      <div class="page-head">
        <div>
          <div class="eyebrow">Tracked & Watchlist</div>
          <h1>What you follow</h1>
          <p class="muted" style={{ margin: '4px 0 0' }}>
            As of {longDate(scope.asof || newest)} and a year earlier, each fund at its own mark date.
          </p>
        </div>
        <span class="spacer" />
        <ScopeBar supports={{ asof: true }} newest={newest} />
      </div>
      <Tabs
        tabs={[
          { id: 'watchlist', label: `Your watchlist (${watchlist.value.length})` },
          { id: 'tracked', label: 'Tracked companies' },
        ]}
        current={current}
        onSelect={id => setView(id === 'watchlist' ? '' : id)}
      />
      {current === 'watchlist' ? <Watchlist /> : <TrackedCompanies />}
    </div>
  );
}

function AddBox() {
  const [q, setQ] = useState('');
  const term = q.trim();
  const hits = useApi<{ results: UnifiedHit[] }>(
    term.length >= 2 ? `/api/search${qs({ q: term, kinds: 'company,firm,fund', limit: 8 })}` : null
  );
  const add = (kind: WatchKind, key: string | number, label: string) => {
    if (!watchlist.value.some(x => x.kind === kind && x.key === String(key)))
      watchlist.value = [...watchlist.value, { kind, key: String(key), label }];
    setQ('');
  };
  const options = (hits.data?.results ?? []).flatMap((h): { kind: WatchKind; key: string; label: string }[] =>
    h.type === 'company' && h.id != null
      ? [{ kind: 'company', key: String(h.id), label: h.name }]
      : h.type === 'firm'
        ? [{ kind: 'firm', key: String(h.id), label: h.name }]
        : h.type === 'fund'
          ? [{ kind: 'fund', key: h.fundKey, label: h.name }]
          : []
  );
  return (
    <div class="stack" style={{ gap: '6px' }}>
      <input
        class="input"
        type="search"
        placeholder="Add a company, firm or fund…"
        aria-label="Add to watchlist"
        value={q}
        onInput={e => setQ((e.target as HTMLInputElement).value)}
        style={{ maxWidth: '420px' }}
      />
      {term.length >= 2 && (
        <div class="row wrap">
          {hits.loading && <span class="muted small">Searching…</span>}
          {!hits.loading && !options.length && <span class="muted small">No company, firm or fund matches.</span>}
          {options.map(o => (
            <button key={`${o.kind}:${o.key}`} class="btn sm" type="button" onClick={() => add(o.kind, o.key, o.label)}>
              + {o.label} <span class="muted">({KIND_LABEL[o.kind].toLowerCase()})</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

type WRow = WatchlistAnswer['items'][number];
// Why a saved item has no numbers (never shown as a zero).
const STATUS_NOTE: Record<WRow['status']['state'], string> = {
  live: '',
  listed: 'listed company: not in the private warehouse',
  merged: 'merged into another; moving it there',
  dropped: 'dropped from the reviewed list',
  unknown: 'no longer exists',
};

function Watchlist() {
  const [scope] = useScope();
  const items = watchlist.value;
  const keys = (k: WatchKind) =>
    items
      .filter(i => i.kind === k)
      .map(i => i.key)
      .join(',');
  const w = useApi<WatchlistAnswer>(
    items.length
      ? `/api/watchlist${qs({ company: keys('company'), firm: keys('firm'), fund: keys('fund'), date: scope.asof })}`
      : null
  );
  const v1 = v1Entries();
  const [imported, setImported] = useState<string | null>(null);
  const d = w.data;
  // a merged company or firm id moves to its successor (the list refetches)
  useEffect(() => {
    if (d) followRedirects(d.items);
  }, [d]);
  const label = (r: WRow) => r.label ?? items.find(i => i.kind === r.kind && i.key === String(r.key))?.label ?? '';
  const columns: Column<WRow>[] = [
    {
      id: 'kind',
      header: 'Kind',
      value: r => KIND_LABEL[r.kind],
      render: r => <Badge>{KIND_LABEL[r.kind]}</Badge>,
      width: '84px',
    },
    {
      id: 'name',
      header: 'Name',
      value: r => label(r),
      render: r =>
        r.status.state === 'live' ? (
          <a href={hrefOf(r.kind, r.key, label(r))}>{label(r)}</a>
        ) : (
          <span>
            {r.status.state === 'listed' ? <a href={hrefOf(r.kind, r.key, label(r))}>{label(r)}</a> : label(r)}{' '}
            <span class="muted small">· {STATUS_NOTE[r.status.state]}</span>
          </span>
        ),
      exportAs: [
        { header: 'Key', value: r => String(r.key) },
        { header: 'Status', value: r => (r.status.state === 'live' ? '' : STATUS_NOTE[r.status.state]) },
      ],
      wrap: true,
    },
    { id: 'value', header: 'Value', value: r => r.value, num: true, render: r => moneyC(r.value) },
    {
      id: 'ago',
      header: 'A year earlier',
      value: r => r.valueYearAgo,
      num: true,
      render: r => moneyC(r.valueYearAgo),
    },
    {
      id: 'pos',
      header: 'Position effect',
      title: 'First reported + added − reduced − no longer reported over the year, at the prior marks',
      value: r => r.positionEffect,
      num: true,
      render: r => <span class={tone(r.positionEffect)}>{moneyDelta(r.positionEffect)}</span>,
    },
    {
      id: 'mark',
      header: 'Mark effect',
      title: 'The new marks on the shares held, over the year',
      value: r => r.markEffect,
      num: true,
      render: r => <span class={tone(r.markEffect)}>{moneyDelta(r.markEffect)}</span>,
    },
    {
      id: 'funds',
      header: 'Funds / companies',
      title: 'A company: funds holding it. A firm or fund: companies it holds (funds holding for a firm).',
      value: r => (r.kind === 'company' ? r.funds : r.companies),
      num: true,
      render: r =>
        r.funds == null
          ? '—'
          : r.kind === 'company'
            ? `${num(r.funds)} funds (${signedNum(r.funds - (r.fundsYearAgo ?? 0))})`
            : `${num(r.companies)} companies${r.kind === 'firm' ? ` · ${num(r.funds)} funds` : ''}`,
    },
    {
      id: 'remove',
      header: '',
      value: () => '',
      noExport: true,
      noSort: true,
      render: r => (
        <button
          class="btn sm ghost"
          type="button"
          aria-label={`Remove ${label(r)}`}
          onClick={() => removeWatch(r.kind, String(r.key))}
        >
          Remove
        </button>
      ),
    },
  ];
  return (
    <div class="stack">
      <Card title="Add">
        <AddBox />
        <p class="muted small" style={{ margin: '8px 0 0' }}>
          Your list is kept in this browser only. ☆ Watch on any company, firm or fund page adds it too.
          {v1.companies.length > 0 && (
            <>
              {' '}
              <button
                class="btn sm"
                type="button"
                onClick={() => {
                  const r = importV1();
                  setImported(
                    `${r.added} companies added from the v1 watchlist${r.skipped ? `; ${r.skipped} names v1 never matched to a reviewed company stay in Legacy` : ''}.`
                  );
                }}
              >
                Import {v1.companies.length} from the v1 watchlist
              </button>
            </>
          )}
          {imported && <span> {imported}</span>}
        </p>
      </Card>
      {!items.length ? (
        <Empty>Your watchlist is empty. Add a company, firm or fund above.</Empty>
      ) : (
        <>
          <ErrorBox error={w.error} />
          {w.loading && !d && <Loading rows={4} />}
          {d && (
            <>
              <div class="kpis">
                <Kpi label="Items" value={num(d.items.length)} />
                <Kpi label="As of" value={longDate(d.date)} sub={`against ${longDate(d.yearAgo)}`} />
              </div>
              <Card flush>
                <DataTable
                  columns={columns}
                  rows={d.items}
                  rowKey={r => `${r.kind}:${r.key}`}
                  exportName={`watchlist-${d.date}`}
                />
              </Card>
              <p class="muted small" style={{ margin: 0 }}>
                {d.label}. A firm is each fund's current adviser (latest N-CEN).
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}

type TRow = TrackedDashboard['companies'][number];

function TrackedCompanies() {
  const [scope] = useScope();
  const t = useApi<TrackedDashboard>(`/api/market/tracked${qs({ date: scope.asof })}`);
  const d = t.data;
  const columns: Column<TRow>[] = [
    {
      id: 'name',
      header: 'Company',
      value: r => r.name,
      render: r => <a href={companyPath(r.companyId, r.name)}>{r.name}</a>,
      exportAs: [{ header: 'Company id', value: r => r.companyId }],
    },
    { id: 'value', header: 'Value', value: r => r.value, num: true, render: r => moneyC(r.value) },
    {
      id: 'funds',
      header: 'Funds',
      value: r => r.funds,
      num: true,
      render: r => (
        <span title={`${r.fundsYearAgo} a year earlier`}>
          {num(r.funds)} <span class={tone(r.holderChange)}>({signedNum(r.holderChange)})</span>
        </span>
      ),
      exportAs: [{ header: 'Funds a year earlier', value: r => r.fundsYearAgo }],
    },
    { id: 'class', header: 'Most-held class', value: r => r.mainClass, wrap: true },
    {
      id: 'median',
      header: 'Median mark',
      title: 'Median per-share mark of the funds that filed the class at its newest mark date',
      value: r => r.median,
      num: true,
      render: r => (r.median != null ? money(r.median) : '—'),
    },
    { id: 'markDate', header: 'Mark date', value: r => r.markDate },
    {
      id: 'chg',
      header: '12-month mark change',
      title: "Median of each fund's own split-adjusted change on one instrument",
      value: r => r.markChange12mPct,
      num: true,
      render: r =>
        r.markChange12mPct != null ? (
          <span class={tone(r.markChange12mPct)} title={`${r.markChangeFunds} funds`}>
            {pct(r.markChange12mPct)}
          </span>
        ) : (
          '—'
        ),
    },
    {
      id: 'spread',
      header: 'Spread',
      title: 'High / low − 1 of the funds’ marks at the newest mark date',
      value: r => r.dispersionPct,
      num: true,
      render: r => (r.dispersionPct != null ? `${r.dispersionPct.toFixed(1)}%` : '—'),
    },
    { id: 'stale', header: 'Stale marks', value: r => r.staleFunds, num: true },
  ];
  return (
    <div class="stack">
      <ErrorBox error={t.error} />
      {t.loading && !d && <Loading rows={6} />}
      {d && (
        <>
          <div class="kpis">
            <Kpi label="Tracked companies" value={num(d.companies.length)} />
            <Kpi
              label="Value held"
              value={moneyC(d.companies.reduce((s, r) => s + r.value, 0))}
              sub={`as of ${longDate(d.date)}`}
            />
            <Kpi
              label="A year earlier"
              value={moneyC(d.companies.reduce((s, r) => s + r.valueYearAgo, 0))}
              sub={`as of ${longDate(d.yearAgo)}`}
            />
          </div>
          <Card flush>
            <DataTable
              columns={columns}
              rows={d.companies}
              rowKey={r => String(r.companyId)}
              sort={{ id: 'value', desc: true }}
              exportName={`tracked-${d.date}`}
              filterPlaceholder="Filter companies…"
              maxHeight={640}
            />
          </Card>
        </>
      )}
    </div>
  );
}
