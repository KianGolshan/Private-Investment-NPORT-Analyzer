import { BASIS } from '../../ui/Basis';
import { useMemo } from 'preact/hooks';
import { qs, useApi } from '../../api/client';
import type { MarksVsOthers as MarksT } from '../../api/types';
import { companyPath, longDate, money, moneyC, num, pct } from '../../lib/format';
import { ScopeBar } from '../../scope/ScopeBar';
import { useParam, useScope } from '../../scope/scope';
import { Badge, Card, ErrorBox, Kpi, Loading, Segmented } from '../../ui/bits';
import { DataTable } from '../../ui/DataTable';
import type { Who } from './BookOverview';

// Each class a firm (or fund) holds as of D: its funds' median per-share mark
// beside the median of every other fund that filed the same class at the same
// mark date (as filed; LESSONS 39). Funds report on staggered calendars, so a
// class no other fund marked that date has no comparison, and says so.

type Row = MarksT['rows'][number];
const TONE = { above: 'pos', same: '', below: 'warn', 'no other fund that date': '' } as const;

export function MarksVsOthers({ who, name, newest }: { who: Who; name: string; newest: string | null }) {
  const [scope] = useScope();
  const [show, setShow] = useParam('show');
  const all = show === 'all';
  const m = useApi<MarksT>(`/api/analysis/marks${qs({ ...who, date: scope.asof })}`);
  const d = m.data;
  const rows = useMemo(() => (d?.rows ?? []).filter(r => all || r.diffPct != null), [d, all]);
  const others = 'firm' in who ? 'other firms’ and funds’' : 'other funds’';
  const q = 'firm' in who ? `?tab=marks&firm=${who.firm}` : `?tab=marks&fund=${encodeURIComponent(who.fund)}`;
  return (
    <div class="stack">
      <div class="row wrap">
        <ScopeBar supports={{ asof: true }} newest={newest} />
        <span class="spacer" />
        <Segmented
          label="Rows"
          value={all ? 'all' : 'compared'}
          onChange={v => setShow(v === 'all' ? 'all' : '', { replace: true })}
          options={[
            { id: 'compared', label: 'Compared' },
            { id: 'all', label: 'All classes held' },
          ]}
        />
      </div>
      <ErrorBox error={m.error} />
      {m.loading && !d && <Loading rows={5} />}
      {d && (
        <>
          <div class="kpis">
            <Kpi
              label="Classes held, priced"
              value={num(d.summary.positions)}
              sub={`${num(d.summary.compared)} with another fund at the same mark date`}
            />
            <Kpi
              label="Above the others’ median"
              value={num(d.summary.above)}
              sub={`${moneyC(d.summary.valueAbove)} held`}
            />
            <Kpi
              label={`Within ${d.tolerancePct}%`}
              value={num(d.summary.same)}
              sub={`${moneyC(d.summary.valueSame)} held`}
            />
            <Kpi label="Below" value={num(d.summary.below)} sub={`${moneyC(d.summary.valueBelow)} held`} />
          </div>
          <Card
            title={`Marks against ${others} median, as of ${longDate(d.date)}`}
            actions={<span class="muted small">same class, same mark date, as filed; no method guessed</span>}
            flush
          >
            <DataTable
              basis={BASIS}
              columns={[
                {
                  id: 'company',
                  header: 'Company',
                  value: (r: Row) => r.company,
                  render: r => <a href={companyPath(r.companyId, r.company) + q}>{r.company}</a>,
                  wrap: true,
                },
                { id: 'class', header: 'Class', value: r => r.classLabel },
                { id: 'markDate', header: 'Mark date', value: r => r.markDate },
                { id: 'mark', header: 'Mark', value: r => r.mark, num: true, render: r => money(r.mark) },
                {
                  id: 'others',
                  header: 'Others’ median',
                  value: r => r.othersMedian,
                  num: true,
                  render: r => money(r.othersMedian),
                },
                {
                  id: 'band',
                  header: 'Others’ low–high',
                  value: r => r.othersLow,
                  num: true,
                  render: r => (r.othersLow == null ? '—' : `${money(r.othersLow)} – ${money(r.othersHigh)}`),
                  noSort: true,
                },
                {
                  id: 'n',
                  header: 'Other funds · firms',
                  value: r => r.otherFunds,
                  num: true,
                  render: r => `${num(r.otherFunds)} · ${num(r.otherFirms)}`,
                },
                {
                  id: 'diff',
                  header: 'vs median',
                  value: r => r.diffPct,
                  num: true,
                  render: r =>
                    r.diffPct == null ? (
                      <span class="muted small">{r.position}</span>
                    ) : (
                      <Badge tone={TONE[r.position]}>
                        {r.position === 'same' ? 'same' : `${r.position} ${pct(r.diffPct)}`}
                      </Badge>
                    ),
                },
                { id: 'value', header: 'Value', value: r => r.value, num: true, render: r => moneyC(r.value) },
                { id: 'funds', header: 'Funds', value: r => r.funds, num: true },
              ]}
              rows={rows}
              rowKey={r => `${r.companyId}:${r.classLabel}:${r.markDate}`}
              sort={{ id: 'value', desc: true }}
              exportName={`${name}-marks-vs-others-${d.date}`}
              filterPlaceholder="Filter companies or classes…"
              maxHeight={620}
            />
          </Card>
        </>
      )}
    </div>
  );
}
