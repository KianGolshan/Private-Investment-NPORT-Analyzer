import { qs, useApi } from '../api/client';
import type { Envelope, Firm, Freshness } from '../api/types';
import { firmPath, longDate, moneyC, num } from '../lib/format';
import { ScopeBar } from '../scope/ScopeBar';
import { useScope } from '../scope/scope';
import { Card, ErrorBox, Loading } from '../ui/bits';
import { DataTable } from '../ui/DataTable';

export default function Firms() {
  const [scope] = useScope();
  const fresh = useApi<Freshness>('/api/freshness');
  const firms = useApi<Envelope & { date: string; results: Firm[] }>(`/api/firms${qs({ date: scope.asof })}`);
  const rows = (firms.data?.results ?? []).filter(f => f.value > 0);
  return (
    <div class="stack">
      <div class="page-head">
        <div>
          <div class="eyebrow">Managers</div>
          <h1>Firms by private value</h1>
          <p class="muted" style={{ margin: '4px 0 0' }}>
            Funds map to firms by their adviser in N-CEN (current adviser). As of{' '}
            {firms.data ? longDate(firms.data.date) : '…'}.
          </p>
        </div>
        <span class="spacer" />
        <ScopeBar supports={{ asof: true }} newest={fresh.data?.newestReportDate ?? null} />
      </div>
      <ErrorBox error={firms.error} />
      {firms.loading && !firms.data && <Loading rows={6} />}
      {firms.data && (
        <Card flush>
          <DataTable
            columns={[
              {
                id: 'name',
                header: 'Firm',
                value: f => f.name,
                render: f => <a href={firmPath(f.id) + (scope.asof ? `?asof=${scope.asof}` : '')}>{f.name}</a>,
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
            exportName={`firms-${firms.data.date}`}
            filterPlaceholder="Filter firms…"
            maxHeight={680}
            totals={{ name: `${num(rows.length)} firms`, value: moneyC(rows.reduce((s, f) => s + f.value, 0)) }}
          />
        </Card>
      )}
    </div>
  );
}
