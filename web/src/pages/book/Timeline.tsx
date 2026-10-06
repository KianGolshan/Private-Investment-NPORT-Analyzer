import { useCallback, useMemo } from 'preact/hooks';
import { qs, useApi } from '../../api/client';
import type { Timeline as TimelineT } from '../../api/types';
import { escapeHtml, companyPath, longDate, moneyC, moneyDelta, num, tone } from '../../lib/format';
import { useParam } from '../../scope/scope';
import { Card, Empty, ErrorBox, Kpi, Loading, Segmented } from '../../ui/bits';
import { Chart } from '../../ui/Chart';
import { DataTable } from '../../ui/DataTable';
import type { ChartTheme } from '../../ui/theme';
import type { Who } from './BookOverview';

// When a firm (or fund) held each private company (P6b W3): one row per
// company, a bar while any of its funds reported it (the as-of rule: until the
// next filing without it, or 123 days without a filing), and a mark per event
// by mark date: first reported, added, reduced, no longer reported, reported at
// $0. Worded as filed; the events equal firmChanges (tested).

type Company = TimelineT['companies'][number];

const MARK: Record<string, { symbol: string; color: (t: ChartTheme) => string; label: string }> = {
  new: { symbol: 'triangle', color: t => t.pos, label: 'first reported' },
  // Held in a fund's first stored filing (the data starts in 2019): not "first reported".
  firstFiling: { symbol: 'emptyTriangle', color: t => t.text3, label: 'held at the first stored filing' },
  resumed: { symbol: 'emptyTriangle', color: t => t.pos, label: 'reported after a gap' },
  added: { symbol: 'circle', color: t => t.series[0]!, label: 'added' },
  mixed: { symbol: 'diamond', color: t => t.series[4]!, label: 'added and reduced' },
  reduced: { symbol: 'circle', color: t => t.warn, label: 'reduced' },
  exited: { symbol: 'rect', color: t => t.neg, label: 'no longer reported' },
  zeroed: { symbol: 'rect', color: t => t.warn, label: 'reported at $0' },
};

export function Timeline({ who, name }: { who: Who; name: string }) {
  const [sortParam, setSort] = useParam('sort');
  const sort = sortParam === 'value' ? 'value' : 'entry';
  const tl = useApi<TimelineT>(`/api/analysis/timeline${qs(who)}`);
  const d = tl.data;
  const companies = useMemo(() => {
    const list = [...(d?.companies ?? [])];
    return sort === 'value'
      ? list.sort((a, b) => b.value - a.value || a.firstHeld.localeCompare(b.firstHeld))
      : list.sort((a, b) => a.firstHeld.localeCompare(b.firstHeld) || b.value - a.value);
  }, [d, sort]);
  const held = companies.filter(c => c.lastHeld == null).length;

  const build = useCallback(
    (t: ChartTheme) => {
      const rows = [...companies].reverse(); // first company at the top
      const asOf = d?.asOf ?? '';
      const bars: { value: [number, number, number]; c: Company }[] = [];
      rows.forEach((c, y) =>
        c.spans.forEach(s => bars.push({ value: [y, Date.parse(s.from), Date.parse(s.until ?? asOf)], c }))
      );
      const kinds = [...new Set(rows.flatMap(c => c.events.map(e => MARK[e.type]?.label)).filter(Boolean))] as string[];
      const marks = kinds.map(label => {
        const types = Object.entries(MARK)
          .filter(([, m]) => m.label === label)
          .map(([k]) => k);
        const m = MARK[types[0]!]!;
        return {
          name: label,
          type: 'scatter',
          symbol: m.symbol,
          symbolSize: 8,
          itemStyle: { color: m.color(t) },
          z: 3,
          data: rows.flatMap((c, y) =>
            c.events.filter(e => types.includes(e.type)).map(e => ({ value: [Date.parse(e.markDate), y], e, c }))
          ),
        };
      });
      return {
        textStyle: { fontFamily: t.font, color: t.text2 },
        aria: { enabled: true },
        legend: { top: 0, left: 0, textStyle: { color: t.text2, fontSize: 12 }, data: kinds },
        grid: { left: 8, right: 16, top: 30, bottom: 30, containLabel: true },
        tooltip: {
          trigger: 'item',
          backgroundColor: t.surface,
          borderColor: t.border,
          textStyle: { color: t.text, fontSize: 12 },
          formatter: (p: { data: { c: Company; e?: Company['events'][number] } }) => {
            const { c, e } = p.data;
            if (e)
              return `${escapeHtml(c.name)}<br/>${e.markDate}: ${escapeHtml(MARK[e.type]?.label ?? e.label)} in ${num(e.funds)} fund${e.funds > 1 ? 's' : ''}<br/>Δ value ${moneyDelta(e.valueChange)} (position ${moneyDelta(e.positionEffect)}, mark ${moneyDelta(e.markEffect)})`;
            return `${escapeHtml(c.name)}<br/>held ${c.firstHeld} → ${c.lastHeld ?? 'now'}<br/>value now ${moneyC(c.value)} in ${num(c.funds)} funds`;
          },
        },
        xAxis: {
          type: 'time',
          axisLabel: { color: t.text3, fontSize: 11 },
          axisLine: { lineStyle: { color: t.border } },
          splitLine: { show: true, lineStyle: { color: t.border, type: 'dashed' } },
        },
        yAxis: {
          type: 'category',
          data: rows.map(c => c.name),
          axisLabel: { color: t.text2, fontSize: 11, width: 200, overflow: 'truncate' },
          axisLine: { lineStyle: { color: t.border } },
          axisTick: { show: false },
        },
        series: [
          {
            name: 'held',
            type: 'custom',
            encode: { x: [1, 2], y: 0 },
            data: bars,
            renderItem: (
              _params: unknown,
              api: {
                value: (i: number) => number;
                coord: (v: [number, number]) => [number, number];
                size: (v: [number, number]) => [number, number];
                style: (o?: object) => object;
              }
            ) => {
              const y = api.value(0);
              const start = api.coord([api.value(1), y]);
              const end = api.coord([api.value(2), y]);
              const h = api.size([0, 1])[1] * 0.5;
              return {
                type: 'rect',
                shape: { x: start[0], y: start[1] - h / 2, width: Math.max(2, end[0] - start[0]), height: h },
                style: { fill: t.heat[1], opacity: 0.35 },
              };
            },
          },
          ...marks,
        ],
      };
    },
    [companies, d]
  );

  const firstOf = (c: Company, types: string[]) => c.events.filter(e => types.includes(e.type)).length;
  return (
    <div class="stack">
      <div class="row wrap">
        <span class="muted small">{d ? `As of ${longDate(d.asOf)}; firms are the ${d.attribution}.` : ''}</span>
        <span class="spacer" />
        <Segmented
          label="Sort"
          value={sort}
          onChange={v => setSort(v === 'entry' ? '' : v, { replace: true })}
          options={[
            { id: 'entry', label: 'By first held' },
            { id: 'value', label: 'By value now' },
          ]}
        />
      </div>
      <ErrorBox error={tl.error} />
      {tl.loading && !d && <Loading rows={6} />}
      {d && (
        <>
          <div class="kpis">
            <Kpi label="Companies ever held" value={num(companies.length)} />
            <Kpi label="Held now" value={num(held)} sub={`as of ${longDate(d.asOf)}`} />
            <Kpi label="Value now" value={moneyC(companies.reduce((s, c) => s + c.value, 0))} />
            <Kpi
              label="First held"
              value={longDate(companies.reduce((m, c) => (c.firstHeld < m ? c.firstHeld : m), '9999-12-31'))}
            />
          </div>
          <Card title="Investment timeline" actions={<span class="muted small">a bar while any fund reported it</span>}>
            {companies.length ? (
              <Chart
                build={build}
                height={Math.max(240, companies.length * 22 + 80)}
                label={`${name}: when each private company was held`}
              />
            ) : (
              <Empty>No private-company holdings.</Empty>
            )}
          </Card>
          <Card title="By company" flush>
            <DataTable
              columns={[
                {
                  id: 'name',
                  header: 'Company',
                  value: (c: Company) => c.name,
                  render: c => (
                    <a
                      href={
                        companyPath(c.companyId, c.name) +
                        ('firm' in who ? `?firm=${who.firm}` : `?fund=${encodeURIComponent(who.fund)}`)
                      }
                    >
                      {c.name}
                    </a>
                  ),
                  wrap: true,
                },
                { id: 'first', header: 'First held', value: c => c.firstHeld },
                {
                  id: 'last',
                  header: 'Held until',
                  value: c => c.lastHeld ?? '9999',
                  render: c => (c.lastHeld ? c.lastHeld : <span class="muted">held now</span>),
                },
                { id: 'value', header: 'Value now', value: c => c.value, num: true, render: c => moneyC(c.value) },
                { id: 'funds', header: 'Funds now', value: c => c.funds, num: true },
                {
                  id: 'adds',
                  header: 'First reported / added / reduced / no longer',
                  value: c => firstOf(c, ['added']),
                  render: c =>
                    `${firstOf(c, ['new', 'resumed'])} / ${firstOf(c, ['added', 'mixed'])} / ${firstOf(c, ['reduced', 'mixed'])} / ${firstOf(c, ['exited'])}`,
                  title: 'Event dates (several funds on one date count once)',
                  noSort: true,
                },
                {
                  id: 'pos',
                  header: 'Position Δ',
                  value: c => c.positionEffect,
                  num: true,
                  render: c => <span class={tone(c.positionEffect)}>{moneyDelta(c.positionEffect)}</span>,
                  title: 'Every change in its funds’ filings since the first, at the prior mark',
                },
                {
                  id: 'mark',
                  header: 'Mark Δ',
                  value: c => c.markEffect,
                  num: true,
                  render: c => <span class={tone(c.markEffect)}>{moneyDelta(c.markEffect)}</span>,
                },
              ]}
              rows={companies}
              rowKey={c => String(c.companyId)}
              sort={{ id: sort === 'value' ? 'value' : 'first', desc: sort === 'value' }}
              exportName={`${name}-timeline`}
              maxHeight={520}
            />
          </Card>
        </>
      )}
    </div>
  );
}
