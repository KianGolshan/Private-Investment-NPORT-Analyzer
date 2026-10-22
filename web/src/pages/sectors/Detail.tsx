import { useRoute } from 'preact-iso';
import { qs, useApi } from '../../api/client';
import type { Freshness, MarkChanges, MarkIndex, SectorCompanies } from '../../api/types';
import { companyPath, longDate, moneyC, num, pct, sectorPath, share } from '../../lib/format';
import { usePageTitle } from '../../lib/title';
import { ScopeBar } from '../../scope/ScopeBar';
import { isRange, useParam, useScope, useSetParams } from '../../scope/scope';
import { BASIS, BasisNote } from '../../ui/Basis';
import { Card, Empty, ErrorBox, isNotFound, Kpi, Loading, Segmented } from '../../ui/bits';
import { DataTable } from '../../ui/DataTable';
import { Term } from '../../ui/Term';
import NotFound from '../NotFound';
import { asLevel, IndexChart, IndexTable, indexPct, type IndexView, LEVEL_LABEL } from './shared';

// One sector, industry or theme (P14, ADR 0010): its companies as of a date,
// the per-share mark index for it, and each company's mark change.
export default function SectorDetail() {
  const { params } = useRoute();
  const level = asLevel(params.level ?? '');
  const key = decodeURIComponent(params.code ?? '');
  const [scope] = useScope();
  const setParams = useSetParams();
  const [viewP] = useParam('view');
  const view: IndexView = viewP === 'value' ? 'value' : 'typical';
  const fresh = useApi<Freshness>('/api/freshness');
  const range = isRange(scope);
  const window = { from: range ? scope.from : undefined, to: range ? scope.to : undefined };
  const cos = useApi<SectorCompanies>(
    `/api/sectors/companies${qs({ level, key, date: range ? scope.to : scope.asof })}`
  );
  const idx = useApi<MarkIndex>(`/api/sectors/index${qs({ level, keys: key, ...window })}`);
  const marks = useApi<MarkChanges>(`/api/sectors/marks${qs({ level, key, ...window })}`);
  const label = cos.data?.label ?? idx.data?.groups[0]?.label ?? key;
  usePageTitle(`${label}: private companies, holdings and marks`);
  if (isNotFound(cos.error)) return <NotFound />;
  const g = idx.data?.groups[0];
  const last = g?.points[g.points.length - 1];
  // where each index is 100: the window's start, or the first period with enough companies marked
  const base = g?.points.find(p => p.index != null);
  const valueBase = g?.points.find(p => p.valueIndex != null);
  const c = cos.data;

  return (
    <div class="stack">
      <div class="page-head">
        <div>
          <div class="eyebrow">
            <a href={`/sectors${qs({ level: level === 'sector' ? undefined : level })}`}>Sectors</a> ·{' '}
            {LEVEL_LABEL[level]}
          </div>
          <h1>{label}</h1>
          <p class="muted" style={{ margin: '4px 0 0', maxWidth: '72ch' }}>
            Private operating companies Vantage labels {level === 'theme' ? 'with this theme' : `in this ${level}`} (
            <Term id="sector">how labels work</Term>).{' '}
            {c && (
              <>
                As of {longDate(c.date)}: {num(c.companies)} companies, {moneyC(c.totalValue)} held by funds
                {level !== 'theme' && c.marketTotal
                  ? `, ${share(c.totalValue / c.marketTotal, 1)} of Market's total`
                  : ''}
                .
              </>
            )}
          </p>
          <BasisNote />
        </div>
        <span class="spacer" />
        <ScopeBar supports={{ asof: true, range: true }} newest={fresh.data?.newestReportDate ?? null} />
      </div>
      <ErrorBox error={cos.error ?? idx.error ?? marks.error} />
      {g && last && (
        <div class="kpis">
          <Kpi
            label="Held by funds"
            value={c ? moneyC(c.totalValue) : '…'}
            sub={c ? `${num(c.companies)} companies` : undefined}
          />
          <Kpi
            label="Average company's mark"
            value={last.index == null ? '—' : indexPct(last.index)}
            sub={base ? `since ${longDate(base.date)}${last.partial ? ' (last period partial)' : ''}` : undefined}
          />
          <Kpi
            label="Value-weighted mark"
            value={last.valueIndex == null ? '—' : indexPct(last.valueIndex)}
            sub={`${num(g.cohort)} companies measured${valueBase ? `, since ${longDate(valueBase.date)}` : ''}`}
          />
          <Kpi
            label="Last period"
            value={last.up == null ? '—' : `${num(last.up)} up · ${num(last.down)} down`}
            sub={last.unchanged == null ? undefined : `${share(last.unchanged, 0)} of marks unchanged`}
          />
        </div>
      )}
      <Card flush>
        <div class="row wrap" style={{ padding: '12px 12px 0' }}>
          <strong>
            <Term id="markIndex">Per-share mark index</Term>
          </strong>
          <span class="spacer" />
          <Segmented
            label="Index"
            value={view}
            onChange={v => setParams({ view: v === 'typical' ? '' : v })}
            options={[
              { id: 'typical', label: 'Average company' },
              { id: 'value', label: 'Value-weighted' },
            ]}
          />
        </div>
        {idx.loading && !idx.data && <Loading rows={4} />}
        {idx.data && g && (
          <>
            <div style={{ padding: '0 12px' }}>
              <IndexChart idx={idx.data} view={view} label={`${label}: per-share mark index`} />
            </div>
            <IndexTable idx={idx.data} level={level} exportName={`mark-index-${key}-${idx.data.from}-${idx.data.to}`} />
          </>
        )}
      </Card>
      {marks.data && (
        <Card
          title={`Each company's per-share mark change, ${longDate(marks.data.from)} to ${longDate(marks.data.to)}`}
          flush
        >
          <DataTable<MarkChanges['companies'][number]>
            basis={`Per-share mark change: the median of the company's funds, each following its own security (split-adjusted). ${BASIS}.`}
            source={marks.data}
            columns={[
              {
                id: 'name',
                header: 'Company',
                value: r => r.name,
                render: r => <a href={companyPath(r.companyId, r.name)}>{r.name}</a>,
                exportAs: [{ header: 'Company id', value: r => r.companyId }],
                wrap: true,
              },
              {
                id: 'change',
                header: 'Mark change',
                value: r => r.change,
                num: true,
                render: r => (r.change == null ? <span class="muted">no mark in force</span> : pct(r.change * 100, 1)),
              },
              { id: 'funds', header: 'Funds', value: r => r.funds, num: true },
              { id: 'chains', header: 'Securities followed', value: r => r.chains, num: true },
              { id: 'still', header: 'Still marked at the end', value: r => r.stillMarked, num: true },
            ]}
            rows={marks.data.companies}
            rowKey={r => String(r.companyId)}
            sort={{ id: 'change', desc: true }}
            exportName={`mark-changes-${key}-${marks.data.from}-${marks.data.to}`}
            empty={<Empty>No company here has a mark in force at the start of the window.</Empty>}
            maxHeight={520}
          />
        </Card>
      )}
      {c && (
        <Card title={`Companies as of ${longDate(c.date)}`} flush>
          <DataTable<SectorCompanies['results'][number]>
            basis={`${BASIS}. Operating companies.`}
            source={c}
            columns={[
              { id: 'rank', header: '#', value: r => r.rank, num: true },
              {
                id: 'name',
                header: 'Company',
                value: r => r.name,
                render: r => <a href={companyPath(r.companyId, r.name)}>{r.name}</a>,
                exportAs: [{ header: 'Company id', value: r => r.companyId }],
                wrap: true,
              },
              ...(level !== 'industry'
                ? [
                    {
                      id: 'industry',
                      header: 'Industry',
                      value: (r: SectorCompanies['results'][number]) => r.industryLabel,
                      render: (r: SectorCompanies['results'][number]) =>
                        r.industry ? <a href={sectorPath('industry', r.industry)}>{r.industryLabel}</a> : '—',
                      wrap: true,
                    },
                  ]
                : []),
              { id: 'value', header: 'Held by funds', value: r => r.value, num: true, render: r => moneyC(r.value) },
              { id: 'funds', header: 'Funds', value: r => r.funds, num: true },
              { id: 'newest', header: 'Newest mark', value: r => r.newestMark, render: r => longDate(r.newestMark) },
              {
                id: 'confidence',
                header: 'Label confidence',
                value: r => r.labelConfidence,
                title: 'How sure the reviewed label is (high, medium; not yet classified)',
              },
            ]}
            rows={c.results}
            rowKey={r => String(r.companyId)}
            sort={{ id: 'value', desc: true }}
            exportName={`companies-${key}-${c.date}`}
            maxHeight={620}
          />
        </Card>
      )}
    </div>
  );
}
