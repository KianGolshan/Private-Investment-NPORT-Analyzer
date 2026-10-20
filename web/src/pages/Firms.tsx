import { BASIS, BasisNote } from '../ui/Basis';
import { qs, useApi } from '../api/client';
import type { FirmList, Freshness } from '../api/types';
import { firmPath, longDate, moneyC, num } from '../lib/format';
import { ScopeBar } from '../scope/ScopeBar';
import { useScope } from '../scope/scope';
import { Card, ErrorBox, Loading } from '../ui/bits';
import { DataTable } from '../ui/DataTable';
import { PAGE_TITLES, usePageTitle } from '../lib/title';
import { Term } from '../ui/Term';
import { CategorySwitch, useCategoryFilter } from '../ui/Category';
import { KnownSwitch, knownNote, useKnown } from '../ui/Known';

export default function Firms() {
  usePageTitle(PAGE_TITLES.firms);
  const [scope] = useScope();
  const fresh = useApi<Freshness>('/api/freshness');
  const cat = useCategoryFilter();
  const known = useKnown(scope.asof);
  const firms = useApi<FirmList>(`/api/firms${qs({ date: scope.asof, category: cat.category, known: known.on })}`);
  const noun = cat.all ? 'private holdings' : 'private companies';
  const rows = (firms.data?.results ?? []).filter(f => f.value > 0);
  return (
    <div class="stack">
      <div class="page-head">
        <div>
          <div class="eyebrow">Firms</div>
          <h1>Firms by private value</h1>
          <p class="muted" style={{ margin: '4px 0 0' }}>
            A fund belongs to the firm named as its adviser in its latest <Term id="ncen" />. As of{' '}
            {firms.data ? longDate(firms.data.date) : '…'}, {cat.all ? 'every private holding' : 'operating companies'}.{' '}
            {knownNote(scope.asof, known.on)}
          </p>
          <BasisNote />
        </div>
        <span class="spacer" />
        <KnownSwitch asof={scope.asof} />
        <CategorySwitch />
        <ScopeBar supports={{ asof: true }} newest={fresh.data?.newestReportDate ?? null} />
      </div>
      <ErrorBox error={firms.error} />
      {firms.loading && !firms.data && <Loading rows={6} />}
      {firms.data && (
        <p class="muted small" style={{ margin: 0 }}>
          {moneyC(firms.data.uniqueValue)} in {noun} held by {num(firms.data.uniqueFunds)} funds across all firms. A
          fund with two advisers counts in full for each firm, so the firm values below do not add up to this.
        </p>
      )}
      {firms.data && (
        <Card flush>
          <DataTable
            basis={`${BASIS}. ${firms.data.categories ? 'Operating companies only' : 'Every private holding'}. ${knownNote(scope.asof, !!firms.data.knownAsOf)}`}
            source={firms.data}
            columns={[
              {
                id: 'name',
                header: 'Firm',
                value: f => f.name,
                render: f => (
                  <a href={firmPath(f.id) + qs({ asof: scope.asof, show: cat.all ? 'all' : undefined })}>{f.name}</a>
                ),
                exportAs: [{ header: 'Firm id', value: f => f.id }],
              },
              { id: 'holding', header: 'Funds holding private companies', value: f => f.fundsHolding, num: true },
              { id: 'managed', header: 'Funds advised', value: f => f.fundsManaged, num: true },
              { id: 'companies', header: 'Companies', value: f => f.companies, num: true },
              { id: 'value', header: 'Private value', value: f => f.value, num: true, render: f => moneyC(f.value) },
            ]}
            rows={rows}
            rowKey={f => String(f.id)}
            sort={{ id: 'value', desc: true }}
            exportName={`firms-${firms.data.date}${firms.data.categories ? '' : '-all'}${firms.data.knownAsOf ? '-known' : ''}`}
            filterPlaceholder="Filter firms…"
            maxHeight={680}
            totals={rs => ({ name: `${num(rs.length)} firms` })}
          />
        </Card>
      )}
    </div>
  );
}
