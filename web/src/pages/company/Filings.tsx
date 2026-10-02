import { qs, useApi } from '../../api/client';
import type { FilingRow, FilingRows } from '../../api/types';
import { fundPath, money, moneyC, num, pctOfNav } from '../../lib/format';
import { ScopeBar } from '../../scope/ScopeBar';
import { isRange, scopeParams, useScope } from '../../scope/scope';
import { Badge, Card, ErrorBox, FilingRef, Kpi, Loading } from '../../ui/bits';
import { DataTable, type Column } from '../../ui/DataTable';
import { FilterPickers, useFilterOptions, type ViewProps } from './shared';

// The stored rows behind every number: each canonical filing's rows for the
// company as filed (title, the filer's ids, units, balance, value, fair-value
// level), in the range and scope. Amended-away filings are left out; rows at
// $0 are kept and marked.

export default function Filings({ base, sq, name, newest, openPosition }: ViewProps) {
  const [scope] = useScope();
  const opts = useFilterOptions(base, sq);
  const range = isRange(scope);
  const rows = useApi<FilingRows>(
    `${base}/rows${qs({ from: range ? scope.from : '', to: range ? scope.to : '', ...sq, ...scopeParams(scope) })}`
  );
  const d = rows.data;

  const columns: Column<FilingRow>[] = [
    {
      id: 'markDate',
      header: 'Mark date',
      value: r => r.markDate,
      render: r => <FilingRef cik={r.cik} accession={r.accession} date={r.markDate} />,
      exportAs: [
        { header: 'Accession', value: r => r.accession },
        { header: 'Filing date', value: r => r.filingDate },
        { header: 'Row', value: r => r.rowKey },
      ],
    },
    {
      id: 'fund',
      header: 'Fund',
      value: r => r.seriesName || r.registrant,
      render: r => <a href={fundPath(r.fundKey)}>{r.seriesName || r.registrant}</a>,
      exportAs: [
        { header: 'Fund key', value: r => r.fundKey },
        { header: 'Registrant', value: r => r.registrant },
      ],
      wrap: true,
    },
    {
      id: 'title',
      header: 'Title as filed',
      value: r => r.title,
      render: r => (
        <span class="small">
          {r.title}
          {r.issuerName && r.issuerName !== r.title && <div class="muted">issuer: {r.issuerName}</div>}
        </span>
      ),
      exportAs: [{ header: 'Issuer as filed', value: r => r.issuerName }],
      wrap: true,
    },
    {
      id: 'ids',
      header: 'Filer’s ids',
      value: r => [r.otherId, r.cusip, r.isin].filter(Boolean).join(' '),
      render: r => (
        <span class="small mono">
          {[r.otherIdDesc && r.otherId ? `${r.otherIdDesc} ${r.otherId}` : r.otherId, r.cusip, r.isin]
            .filter(x => x && !/^0+$/.test(String(x)))
            .join(' · ') || '—'}
        </span>
      ),
      exportAs: [
        { header: 'Other id', value: r => r.otherId },
        { header: 'Other id description', value: r => r.otherIdDesc },
        { header: 'CUSIP', value: r => r.cusip },
        { header: 'ISIN', value: r => r.isin },
        { header: 'LEI', value: r => r.lei },
      ],
    },
    {
      id: 'cat',
      header: 'Category',
      value: r => r.assetCat,
      render: r => (
        <span class="small">
          {r.assetCat ?? '—'}
          {r.viaSpv && (
            <>
              {' '}
              <Badge tone="info">SPV</Badge>
            </>
          )}
        </span>
      ),
      exportAs: [{ header: 'Instrument type', value: r => r.instrumentType }],
    },
    {
      id: 'balance',
      header: 'Balance',
      value: r => r.balance,
      num: true,
      render: r => (
        <span>
          {num(r.balance)} <span class="muted small">{r.unit}</span>
        </span>
      ),
      exportAs: [{ header: 'Unit', value: r => r.unit }],
    },
    {
      id: 'value',
      header: 'Value',
      value: r => r.valueUsd,
      num: true,
      render: r => (r.counts ? moneyC(r.valueUsd) : <span class="muted">{moneyC(r.valueUsd)} (at $0)</span>),
    },
    {
      id: 'perUnit',
      header: 'Per share / unit',
      value: r => (r.balance && r.balance > 0 ? r.valueUsd / r.balance : null),
      num: true,
      render: r =>
        r.balance && r.balance > 0 ? `${money(r.valueUsd / r.balance)}${r.unit === 'NS' ? '/sh' : '/unit'}` : '—',
    },
    { id: 'pctNav', header: '% of fund', value: r => r.pctNav, num: true, render: r => pctOfNav(r.pctNav) },
    { id: 'level', header: 'FV level', value: r => r.fvLevel },
    { id: 'country', header: 'Country', value: r => r.country },
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
        {!range && <span class="muted small">Every stored row since the first filing. Pick a range to narrow.</span>}
      </div>
      <ErrorBox error={rows.error} />
      {rows.loading && !d && <Loading rows={6} />}
      {d && (
        <>
          <div class="kpis">
            <Kpi
              label="Rows"
              value={num(d.count)}
              sub={d.truncated ? `the newest ${num(d.rows.length)} shown` : 'as filed'}
            />
            <Kpi label="Filings" value={num(new Set(d.rows.map(r => r.accession)).size)} />
            <Kpi label="Funds" value={num(new Set(d.rows.map(r => r.fundKey)).size)} />
          </div>
          <Card title="Stored rows" flush>
            <DataTable
              columns={columns}
              rows={d.rows}
              rowKey={r => `${r.accession}:${r.rowKey}`}
              sort={{ id: 'markDate', desc: true }}
              exportName={`${name}-rows`}
              filterPlaceholder="Filter titles, ids, funds…"
              maxHeight={640}
              onRowClick={r => openPosition(r.fundKey)}
            />
          </Card>
        </>
      )}
    </div>
  );
}
