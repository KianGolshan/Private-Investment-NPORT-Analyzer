import { useMemo } from 'preact/hooks';
import { qs, useApi } from '../../api/client';
import type { FundFilings, Xray, XrayCompare, XrayHolding, XrayReturns } from '../../api/types';
import {
  companyPath,
  entityPath,
  money,
  moneyC,
  moneyDelta,
  num,
  pct,
  pctOfNav,
  price,
  share,
  signedNum,
  tone,
} from '../../lib/format';
import { useParam } from '../../scope/scope';
import { Badge, Card, ErrorBox, FilingRef, Kpi, Loading, Segmented } from '../../ui/bits';
import { DataTable } from '../../ui/DataTable';

// Fund X-Ray, ported from v1 (P6b W3) onto the warehouse routes that keep v1's
// shapes (lib/services/fund.js): the private book at any filing, the comparison
// with the prior quarter or year, and mark-implied returns. Words follow the
// filings: "first reported", "no longer reported", "reduced", never a sale.

type Props = { fund: FundFilings; name: string };
const KIND_LABEL = { company: 'operating company', fund: 'fund interest', vehicle: 'opaque vehicle' } as const;

/** The filing picker shared by the three tabs (?filing=<accession>, default the newest). */
function useFiling(fund: FundFilings) {
  const [acc, setAcc] = useParam('filing');
  const filings = fund.filings;
  const current = filings.find(f => f.accession === acc) ?? filings[0];
  const picker = (
    <label class="row small">
      Filing
      <select class="input" value={current?.accession} onChange={e => setAcc((e.target as HTMLSelectElement).value)}>
        {filings.map(f => (
          <option key={f.accession} value={f.accession}>
            {f.reportDate} ({f.form}, filed {f.filingDate})
          </option>
        ))}
      </select>
    </label>
  );
  return { current, picker, filings };
}

const privateBy = (h: XrayHolding) =>
  h.company ? `company status (${h.company.name})` : (h.labels[0] ?? (h.unreviewed ? 'unreviewed name' : '—'));

export function XRay({ fund, name }: Props) {
  const { current, picker } = useFiling(fund);
  const key = fund.fund.fundKey;
  const x = useApi<Xray>(
    current ? `/api/funds/${encodeURIComponent(key)}/xray${qs({ accession: current.accession })}` : null
  );
  const d = x.data?.xray;
  const countries = useMemo(() => Object.entries(d?.byCountry ?? {}).sort((a, b) => b[1] - a[1]), [d]);
  return (
    <div class="stack">
      <div class="row wrap">{picker}</div>
      <ErrorBox error={x.error} />
      {x.loading && !d && <Loading rows={6} />}
      {d && (
        <>
          <div class="kpis">
            <Kpi
              label="Private value"
              value={moneyC(d.privateValueUSD)}
              sub={
                d.privatePctOfNetAssets != null
                  ? `${share(d.privatePctOfNetAssets / 100)} of net assets`
                  : d.privatePctOfHoldingsValue != null
                    ? `${share(d.privatePctOfHoldingsValue / 100)} of holdings value (net assets not positive)`
                    : 'share of net assets not reported'
              }
            />
            <Kpi
              label="Private positions"
              value={num(d.privateHoldingsCount)}
              sub={`of ${num(d.totalHoldingsCount)} holdings`}
            />
            {(['company', 'fund', 'vehicle'] as const).map(k => (
              <Kpi
                key={k}
                label={d.privateByKind[k].label}
                value={moneyC(d.privateByKind[k].valueUSD)}
                sub={`${num(d.privateByKind[k].rows)} rows`}
              />
            ))}
          </div>
          <Card
            title={`Private book as of ${d.markDate}`}
            actions={
              <span class="muted small">
                <FilingRef cik={fund.fund.cik} accession={d.accession} showAccession /> · private = the company’s
                status, not fair-value level alone
              </span>
            }
            flush
          >
            <DataTable
              columns={[
                {
                  id: 'name',
                  header: 'Company',
                  value: (h: XrayHolding) => h.company?.name ?? h.name,
                  render: h =>
                    h.company ? (
                      <a href={companyPath(h.company.id, h.company.name) + `?fund=${encodeURIComponent(key)}`}>
                        {h.company.name}
                      </a>
                    ) : h.unreviewed ? (
                      <a href={entityPath(h.unreviewed.key)}>{h.name}</a>
                    ) : (
                      h.name
                    ),
                  exportAs: [{ header: 'Name as filed', value: h => h.name }],
                  wrap: true,
                },
                {
                  id: 'title',
                  header: 'Instrument',
                  value: h => h.instrumentLabel,
                  render: h => (
                    <span class="small" title={h.title}>
                      {h.instrumentLabel}{' '}
                      {h.privateKind !== 'company' && <Badge tone="info">{KIND_LABEL[h.privateKind]}</Badge>}
                    </span>
                  ),
                  exportAs: [
                    { header: 'Title', value: h => h.title },
                    { header: 'Filer id', value: h => h.filerId },
                  ],
                },
                { id: 'shares', header: 'Shares / units', value: h => h.shares, num: true, render: h => num(h.shares) },
                {
                  id: 'price',
                  header: 'Mark',
                  value: h => h.pricePerShare,
                  num: true,
                  render: h => price(h.pricePerShare, h.perShare ? 'NS' : h.unit),
                },
                {
                  id: 'value',
                  header: 'Value',
                  value: h => h.marketValue,
                  num: true,
                  render: h => moneyC(h.marketValue),
                },
                {
                  id: 'pct',
                  header: '% of NAV',
                  value: h => h.pctOfNetAssets,
                  num: true,
                  render: h => pctOfNav(h.pctOfNetAssets),
                },
                { id: 'level', header: 'FV level', value: h => h.fairValLevel },
                { id: 'restricted', header: 'Restricted', value: h => h.isRestrictedSec },
                { id: 'country', header: 'Country', value: h => h.country },
                { id: 'by', header: 'Private by', value: privateBy, wrap: true },
              ]}
              rows={d.privateHoldings}
              rowKey={h => h.rowKey}
              sort={{ id: 'value', desc: true }}
              exportName={`${name}-xray-${d.markDate}`}
              filterPlaceholder="Filter holdings…"
              maxHeight={620}
              totals={rs => ({
                name: `${num(rs.length)} positions`,
                value: moneyC(rs.reduce((s, h) => s + h.marketValue, 0)),
              })}
            />
          </Card>
          {d.truncated && (
            <div class="notice warn">
              Lists are cut to the largest {num(d.truncated.shown)} rows by value: {num(d.privateHoldings.length)} of{' '}
              {num(d.truncated.privateHoldings)} private rows
              {d.truncated.notPrivate > d.notPrivate.length &&
                ` and ${num(d.notPrivate.length)} of ${num(d.truncated.notPrivate)} rows that are not private`}{' '}
              are shown. The totals above cover every row.
            </div>
          )}
          {d.notPrivate.length > 0 && (
            <Card title={`Level-3 or restricted rows that are not private (${d.notPrivate.length})`} flush>
              <DataTable
                columns={[
                  { id: 'name', header: 'Name', value: (h: XrayHolding) => h.name, wrap: true },
                  { id: 'title', header: 'Title', value: h => h.title, wrap: true },
                  {
                    id: 'value',
                    header: 'Value',
                    value: h => h.marketValue,
                    num: true,
                    render: h => moneyC(h.marketValue),
                  },
                  { id: 'reason', header: 'Why not private', value: h => h.reason ?? '', wrap: true },
                ]}
                rows={d.notPrivate}
                rowKey={h => h.rowKey}
                sort={{ id: 'value', desc: true }}
                exportName={`${name}-xray-not-private-${d.markDate}`}
              />
            </Card>
          )}
          {d.capitalStructure.length > 0 && (
            <Card title="Debt held beside equity in the same company" flush>
              <DataTable
                columns={[
                  { id: 'issuer', header: 'Company', value: (c: Xray['xray']['capitalStructure'][number]) => c.issuer },
                  {
                    id: 'total',
                    header: 'Total',
                    value: c => c.totalValueUSD,
                    num: true,
                    render: c => moneyC(c.totalValueUSD),
                  },
                  {
                    id: 'debt',
                    header: 'Debt share',
                    value: c => c.debtPctOfExposure,
                    num: true,
                    render: c => `${c.debtPctOfExposure.toFixed(1)}%`,
                  },
                  {
                    id: 'coupon',
                    header: 'Weighted coupon',
                    value: c => c.weightedDebtCouponPct,
                    num: true,
                    render: c => (c.weightedDebtCouponPct == null ? '—' : `${c.weightedDebtCouponPct.toFixed(2)}%`),
                  },
                  {
                    id: 'instruments',
                    header: 'Instruments',
                    value: c => c.instruments.map(i => i.instrumentLabel).join('; '),
                    render: c => (
                      <span class="small">
                        {c.instruments.map(i => `${i.instrumentLabel} ${moneyC(i.marketValue)}`).join(' · ')}
                      </span>
                    ),
                    wrap: true,
                    noSort: true,
                  },
                ]}
                rows={d.capitalStructure}
                rowKey={c => c.issuer}
                sort={{ id: 'total', desc: true }}
                exportName={`${name}-capital-structure-${d.markDate}`}
              />
            </Card>
          )}
          {countries.length > 1 && (
            <Card title="Private value by issuer country (as filed)">
              <div class="small">
                {countries.map(([c, v]) => (
                  <span key={c} style={{ marginRight: '14px' }}>
                    {c}: {moneyC(v)}
                  </span>
                ))}
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

const STATUS: Record<string, { label: string; tone: '' | 'pos' | 'warn' }> = {
  new: { label: 'first reported', tone: 'pos' },
  exited: { label: 'no longer reported', tone: 'warn' },
  held: { label: 'held', tone: '' },
};

/** The filing a year earlier: the closest to 365 days before, within 45 days (v1's rule). */
function yearEarlier(filings: FundFilings['filings'], idx: number) {
  const target = Date.parse(filings[idx]!.reportDate) - 365 * 86400000;
  let best: number | null = null;
  for (let i = idx + 1; i < filings.length; i++) {
    const diff = Math.abs(Date.parse(filings[i]!.reportDate) - target) / 86400000;
    if (diff <= 45 && (best == null || diff < Math.abs(Date.parse(filings[best]!.reportDate) - target) / 86400000))
      best = i;
  }
  return best;
}

export function Compare({ fund, name }: Props) {
  const { current, picker, filings } = useFiling(fund);
  const [modeParam, setMode] = useParam('vs');
  const mode = modeParam === 'yoy' ? 'yoy' : 'qoq';
  const key = fund.fund.fundKey;
  const idx = current ? filings.indexOf(current) : -1;
  const priorIdx =
    idx < 0 ? null : mode === 'qoq' ? (idx + 1 < filings.length ? idx + 1 : null) : yearEarlier(filings, idx);
  const prior = priorIdx == null ? null : filings[priorIdx]!;
  const c = useApi<XrayCompare>(
    current && prior
      ? `/api/funds/${encodeURIComponent(key)}/compare${qs({ current: current.accession, prior: prior.accession })}`
      : null
  );
  const cmp = c.data?.comparison;
  type P = NonNullable<XrayCompare['comparison']>['positions'][number];
  return (
    <div class="stack">
      <div class="row wrap">
        {picker}
        <Segmented
          label="Compare with"
          value={mode}
          onChange={v => setMode(v === 'qoq' ? '' : v, { replace: true })}
          options={[
            { id: 'qoq', label: 'Prior filing' },
            { id: 'yoy', label: 'A year earlier' },
          ]}
        />
        {prior && <span class="muted small">vs {prior.reportDate}</span>}
      </div>
      {!prior && (
        <div class="notice">
          No {mode === 'qoq' ? 'earlier filing' : 'filing about a year earlier (±45 days)'} to compare with.
        </div>
      )}
      <ErrorBox error={c.error} />
      {c.loading && !cmp && <Loading rows={6} />}
      {cmp && (
        <>
          <div class="kpis">
            <Kpi
              label="Private value"
              value={moneyC(cmp.totals.privateValueUSD.current)}
              sub={
                <span class={tone(cmp.totals.privateValueUSD.delta)}>
                  {moneyDelta(cmp.totals.privateValueUSD.delta)} ({pct(cmp.totals.privateValueUSD.deltaPct)})
                </span>
              }
            />
            <Kpi
              label="From marks"
              value={
                <span class={tone(cmp.totals.valueChangeFromPrice.amount)}>
                  {moneyDelta(cmp.totals.valueChangeFromPrice.amount)}
                </span>
              }
              sub="positions held in both, at the new mark"
            />
            <Kpi
              label="From shares"
              value={
                <span class={tone(cmp.totals.valueChangeFromShares.amount)}>
                  {moneyDelta(cmp.totals.valueChangeFromShares.amount)}
                </span>
              }
              sub="shares added or removed in positions held in both"
            />
            <Kpi
              label="First reported · no longer · held"
              value={`${num(cmp.totals.newCount)} · ${num(cmp.totals.exitedCount)} · ${num(cmp.totals.continuingCount)}`}
            />
          </div>
          <Card title={`${current!.reportDate} vs ${prior!.reportDate}`} flush>
            <DataTable
              columns={[
                {
                  id: 'name',
                  header: 'Holding',
                  value: (p: P) => p.name,
                  render: p => <span title={p.title}>{p.name}</span>,
                  wrap: true,
                },
                { id: 'class', header: 'Instrument', value: p => p.instrumentLabel },
                {
                  id: 'status',
                  header: 'Change',
                  value: p => STATUS[p.status]?.label ?? p.status,
                  render: p => <Badge tone={STATUS[p.status]?.tone ?? ''}>{STATUS[p.status]?.label ?? p.status}</Badge>,
                },
                {
                  id: 'shares',
                  header: 'Δ shares',
                  value: p => p.shares.delta,
                  num: true,
                  render: p => (p.splitRatio ? `split ${p.splitRatio}:1` : signedNum(p.shares.delta)),
                },
                {
                  id: 'price',
                  header: 'Mark',
                  value: p => p.pricePerShare.deltaPct,
                  num: true,
                  render: p =>
                    p.pricePerShare.prior != null && p.pricePerShare.current != null
                      ? `${money(p.pricePerShare.prior)} → ${money(p.pricePerShare.current)}`
                      : money(p.pricePerShare.current ?? p.pricePerShare.prior),
                },
                {
                  id: 'value',
                  header: 'Value',
                  value: p => p.marketValue.current,
                  num: true,
                  render: p => moneyC(p.marketValue.current),
                },
                {
                  id: 'delta',
                  header: 'Δ value',
                  value: p => p.marketValue.delta,
                  num: true,
                  render: p => (
                    <span class={tone(p.marketValue.delta)}>
                      {moneyDelta(
                        p.marketValue.delta ??
                          (p.status === 'exited' ? -(p.marketValue.prior ?? 0) : p.marketValue.current)
                      )}
                    </span>
                  ),
                },
                {
                  id: 'markFx',
                  header: 'Mark Δ',
                  value: p => p.priceEffectUSD,
                  num: true,
                  render: p =>
                    p.priceEffectUSD == null ? (
                      '—'
                    ) : (
                      <span class={tone(p.priceEffectUSD)}>{moneyDelta(p.priceEffectUSD)}</span>
                    ),
                },
                {
                  id: 'shareFx',
                  header: 'Shares Δ',
                  value: p => p.shareEffectUSD,
                  num: true,
                  render: p =>
                    p.shareEffectUSD == null ? (
                      '—'
                    ) : (
                      <span class={tone(p.shareEffectUSD)}>{moneyDelta(p.shareEffectUSD)}</span>
                    ),
                },
              ]}
              rows={cmp.positions}
              rowKey={p => p.key}
              sort={{ id: 'value', desc: true }}
              exportName={`${name}-compare-${current!.reportDate}-${prior!.reportDate}`}
              filterPlaceholder="Filter holdings…"
              maxHeight={620}
            />
          </Card>
        </>
      )}
    </div>
  );
}

const STATUS_RETURNS: Record<string, string> = {
  open: 'held',
  exited: 'left the private book',
  converted: 'converted',
};

export function Returns({ fund, name }: Props) {
  const { current, picker } = useFiling(fund);
  const key = fund.fund.fundKey;
  const r = useApi<XrayReturns>(
    current ? `/api/funds/${encodeURIComponent(key)}/returns${qs({ accession: current.accession, n: 8 })}` : null
  );
  const d = r.data?.returns;
  const x = (v: number | null) => (v != null && Number.isFinite(v) ? `${v.toFixed(2)}×` : '—');
  const irr = (v: number | null) => (v != null && Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : '—');
  type P = XrayReturns['returns']['positions'][number];
  const notes = (p: P) => {
    const n: string[] = [];
    if (p.entryIsWindowStart) n.push('held before the oldest filing shown');
    if (p.lotsUnavailable) n.push('no share count or mark');
    if (p.chainedFrom) n.push(`converted from ${p.chainedFrom}`);
    const adds = p.events.filter(e => e.type === 'addon').length;
    if (adds) n.push(`added ${adds}×`);
    if (p.events.some(e => e.type === 'partial_realization')) n.push('reduced');
    for (const e of p.events.filter(e => e.type === 'split'))
      n.push(`${e.ratio! >= 1 ? `${e.ratio}-for-1` : `1-for-${Math.round(1 / e.ratio!)}`} split ${e.date}`);
    if (p.status === 'exited') n.push(`no longer reported after ${p.lastDate}`);
    return n.join('; ') || '—';
  };
  return (
    <div class="stack">
      <div class="row wrap">
        {picker}
        <span class="muted small">the 8 filings up to the one picked</span>
      </div>
      <div class="notice warn">
        These are <strong>proxies built from the fund’s own marks</strong>, not real returns. N-PORT never reports what
        a fund paid, so each purchase is costed at the mark of the filing where it first appears or grows. A position
        already held in the oldest filing shown is measured from that filing. A holding that leaves the private book is
        counted at its last mark: the filing cannot tell a sale from a conversion into listed stock.
      </div>
      <ErrorBox error={r.error} />
      {r.loading && !d && <Loading rows={6} />}
      {d && (
        <>
          <div class="kpis">
            <Kpi
              label="Mark-implied MOIC"
              value={x(d.summary.moic)}
              sub={`${num(d.summary.positionCount)} positions, ${num(d.summary.periodCount)} filings`}
            />
            <Kpi
              label="Mark-implied IRR"
              value={irr(d.summary.irr)}
              sub={`${d.summary.firstDate} → ${d.summary.lastDate}`}
            />
            <Kpi label="Proxy invested" value={moneyC(d.summary.invested)} />
            <Kpi
              label="Counted as realized"
              value={moneyC(d.summary.realized)}
              sub={`${moneyC(d.summary.partialSales)} from reductions · ${moneyC(d.summary.leftPrivateBook)} left the private book`}
            />
            <Kpi label="Unrealized value" value={moneyC(d.summary.currentValue)} />
          </div>
          {d.summary.excludedCount > 0 && (
            <div class="muted small">
              {num(d.summary.excludedCount)} position(s) excluded: no usable share count or mark.
            </div>
          )}
          <Card title="By position" flush>
            <DataTable
              columns={[
                { id: 'name', header: 'Position', value: (p: P) => p.title || p.name, wrap: true },
                { id: 'status', header: 'Status', value: p => STATUS_RETURNS[p.status] ?? p.status },
                { id: 'since', header: 'Since', value: p => p.firstDate },
                {
                  id: 'invested',
                  header: 'Proxy invested',
                  value: p => p.invested,
                  num: true,
                  render: p => (p.lotsUnavailable ? '—' : moneyC(p.invested)),
                },
                {
                  id: 'realized',
                  header: 'Counted as realized',
                  value: p => p.realized,
                  num: true,
                  render: p => (p.lotsUnavailable ? '—' : moneyC(p.realized)),
                },
                {
                  id: 'current',
                  header: 'Unrealized',
                  value: p => p.currentValue,
                  num: true,
                  render: p => moneyC(p.currentValue),
                },
                {
                  id: 'moic',
                  header: 'MOIC',
                  value: p => p.moic,
                  num: true,
                  render: p => (p.lotsUnavailable ? '—' : x(p.moic)),
                },
                {
                  id: 'irr',
                  header: 'IRR',
                  value: p => p.irr,
                  num: true,
                  render: p => (p.lotsUnavailable ? '—' : irr(p.irr)),
                },
                { id: 'notes', header: 'Notes', value: notes, wrap: true, noSort: true },
              ]}
              rows={d.positions}
              rowKey={(p, i) => `${p.name}:${p.title}:${i}`}
              sort={{ id: 'current', desc: true }}
              exportName={`${name}-returns-${d.summary.lastDate}`}
              maxHeight={620}
            />
          </Card>
        </>
      )}
    </div>
  );
}
