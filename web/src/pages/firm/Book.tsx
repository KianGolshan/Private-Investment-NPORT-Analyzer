import { useCallback, useMemo } from 'preact/hooks';
import type { FirmBook } from '../../api/types';
import { escapeHtml, companyPath, fundPath, money, moneyC, num, pctOfNav, price, share } from '../../lib/format';
import { ScopeBar } from '../../scope/ScopeBar';
import { useParam } from '../../scope/scope';
import { Badge, Card, Empty, FilingRef, Segmented } from '../../ui/bits';
import { Chart } from '../../ui/Chart';
import { DataTable } from '../../ui/DataTable';
import type { ChartTheme } from '../../ui/theme';

// A firm's book as of a date: by company (each position with its fund, mark
// date and accession), by fund, or as a company × fund matrix.

type Pos = FirmBook['byCompany'][number]['positions'][number] & {
  companyId: number;
  company: string;
  tracked: boolean;
};
type View = 'company' | 'fund' | 'matrix';
const MATRIX_ROWS = 30;
const MATRIX_COLS = 25;

export function Book({ id, book: b, newest }: { id: number; book: FirmBook; newest: string | null }) {
  const [viewParam, setView] = useParam('view');
  const view: View = viewParam === 'fund' || viewParam === 'matrix' ? viewParam : 'company';
  const positions = useMemo(
    () =>
      b.byCompany.flatMap(c =>
        c.positions.map(p => ({ ...p, companyId: c.companyId, company: c.name, tracked: c.tracked }))
      ),
    [b]
  );
  const companyTotals = useMemo(() => new Map(b.byCompany.map(c => [String(c.companyId), c])), [b]);

  // The matrix: the largest companies × the largest funds, value per cell.
  const matrix = useMemo(() => {
    const companies = b.byCompany.slice(0, MATRIX_ROWS);
    const funds = b.byFund.slice(0, MATRIX_COLS);
    const fundIdx = new Map(funds.map((f, i) => [f.fundKey, i]));
    const cells: [number, number, number][] = [];
    companies.forEach((c, ci) => {
      const byFund = new Map<number, number>();
      for (const p of c.positions) {
        const fi = fundIdx.get(p.fundKey);
        if (fi != null) byFund.set(fi, (byFund.get(fi) ?? 0) + p.value);
      }
      for (const [fi, v] of byFund) cells.push([fi, companies.length - 1 - ci, v]);
    });
    return { companies, funds, cells };
  }, [b]);

  const build = useCallback(
    (t: ChartTheme) => {
      const max = Math.max(1, ...matrix.cells.map(c => c[2]));
      return {
        textStyle: { fontFamily: t.font, color: t.text2 },
        aria: { enabled: true },
        grid: { left: 8, right: 16, top: 8, bottom: 56, containLabel: true },
        tooltip: {
          backgroundColor: t.surface,
          borderColor: t.border,
          textStyle: { color: t.text, fontSize: 12 },
          formatter: (p: { value: [number, number, number] }) =>
            `${escapeHtml(matrix.companies[matrix.companies.length - 1 - p.value[1]]!.name)}<br/>${escapeHtml(matrix.funds[p.value[0]]!.label)}<br/>${moneyC(p.value[2])}`,
        },
        xAxis: {
          type: 'category',
          data: matrix.funds.map(f => f.label),
          axisLabel: { color: t.text3, fontSize: 10, rotate: 40, width: 140, overflow: 'truncate' },
          axisLine: { lineStyle: { color: t.border } },
        },
        yAxis: {
          type: 'category',
          data: [...matrix.companies].reverse().map(c => c.name),
          axisLabel: { color: t.text2, fontSize: 11, width: 180, overflow: 'truncate' },
          axisLine: { lineStyle: { color: t.border } },
        },
        visualMap: {
          type: 'continuous',
          min: 0,
          max,
          orient: 'horizontal',
          left: 'center',
          bottom: 0,
          itemHeight: 160,
          textStyle: { color: t.text3, fontSize: 10 },
          formatter: (v: number) => moneyC(v),
          inRange: { color: [t.heat[0], t.heat[1]] },
        },
        series: [
          {
            type: 'heatmap',
            data: matrix.cells,
            itemStyle: { borderColor: t.surface, borderWidth: 1 },
          },
        ],
      };
    },
    [matrix]
  );

  return (
    <div class="stack">
      <div class="row wrap">
        <ScopeBar supports={{ asof: true }} newest={newest} />
        <span class="spacer" />
        <Segmented
          label="Book view"
          value={view}
          onChange={v => setView(v === 'company' ? '' : v, { replace: true })}
          options={[
            { id: 'company', label: 'By company' },
            { id: 'fund', label: 'By fund' },
            { id: 'matrix', label: 'Company × fund' },
          ]}
        />
      </div>
      {view === 'company' && (
        <Card flush>
          <DataTable<Pos>
            columns={[
              {
                id: 'fund',
                header: 'Fund',
                value: p => p.fund,
                render: p => <a href={fundPath(p.fundKey)}>{p.fund}</a>,
                exportAs: [
                  { header: 'Company', value: p => p.company },
                  { header: 'Fund key', value: p => p.fundKey },
                ],
                wrap: true,
              },
              {
                id: 'markDate',
                header: 'Mark date',
                value: p => p.markDate,
                render: p => <FilingRef cik={p.cik} accession={p.accession} date={p.markDate} />,
                exportAs: [{ header: 'Accession', value: p => p.accession }],
              },
              {
                id: 'class',
                header: 'Class',
                value: p => p.instrument,
                render: p => (
                  <span title={p.title}>
                    {p.instrument} {p.viaSpv && <Badge tone="info">through SPV</Badge>}
                  </span>
                ),
              },
              { id: 'shares', header: 'Shares / units', value: p => p.balance, num: true, render: p => num(p.balance) },
              {
                id: 'price',
                header: 'Mark',
                value: p => p.pricePerShare ?? p.pricePerUnit,
                num: true,
                render: p => price(p.pricePerShare ?? p.pricePerUnit, p.unit),
              },
              { id: 'value', header: 'Value', value: p => p.value, num: true, render: p => moneyC(p.value) },
              { id: 'pctNav', header: '% of fund', value: p => p.pctNav, num: true, render: p => pctOfNav(p.pctNav) },
            ]}
            rows={positions}
            rowKey={(p, i) => `${p.companyId}:${p.fundKey}:${i}`}
            sort={{ id: 'value', desc: true }}
            group={{
              key: p => String(p.companyId),
              header: k => {
                const c = companyTotals.get(k)!;
                return (
                  <div class="row">
                    <a href={companyPath(c.companyId, c.name) + `?firm=${id}`}>{c.name}</a>
                    {c.tracked && <Badge tone="accent">Tracked</Badge>}
                    <span class="spacer" />
                    <span class="muted small">{num(c.funds)} funds</span>
                    <span class="num" style={{ minWidth: '90px' }}>
                      {moneyC(c.value)}
                    </span>
                  </div>
                );
              },
            }}
            exportName={`${b.firm.name}-book-${b.date}`}
            filterPlaceholder="Filter companies, funds, classes…"
            totals={rs => ({ fund: 'Total', value: moneyC(rs.reduce((s, p) => s + p.value, 0)) })}
          />
        </Card>
      )}
      {view === 'fund' && (
        <Card flush>
          <DataTable
            columns={[
              {
                id: 'fund',
                header: 'Fund',
                value: f => f.label,
                render: f => <a href={fundPath(f.fundKey)}>{f.label}</a>,
                exportAs: [{ header: 'Fund key', value: f => f.fundKey }],
                wrap: true,
              },
              {
                id: 'markDate',
                header: 'Mark date',
                value: f => f.markDate,
                render: f => <FilingRef cik={f.cik} accession={f.accession} date={f.markDate} />,
                exportAs: [{ header: 'Accession', value: f => f.accession }],
              },
              { id: 'companies', header: 'Companies', value: f => f.companies, num: true },
              { id: 'value', header: 'Private value', value: f => f.value, num: true, render: f => moneyC(f.value) },
              {
                id: 'pct',
                header: '% of net assets',
                value: f => (f.netAssets ? f.value / f.netAssets : null),
                num: true,
                render: f => share(f.netAssets ? f.value / f.netAssets : null),
              },
              { id: 'net', header: 'Net assets', value: f => f.netAssets, num: true, render: f => moneyC(f.netAssets) },
            ]}
            rows={b.byFund}
            rowKey={f => f.fundKey}
            sort={{ id: 'value', desc: true }}
            exportName={`${b.firm.name}-funds-${b.date}`}
            filterPlaceholder="Filter funds…"
            totals={rs => ({ fund: `${num(rs.length)} funds`, value: moneyC(rs.reduce((s, f) => s + f.value, 0)) })}
          />
        </Card>
      )}
      {view === 'matrix' && (
        <Card
          title={`The ${matrix.companies.length} largest companies × the ${matrix.funds.length} largest funds`}
          actions={<span class="muted small">value as of each fund’s mark date; the tables list everything</span>}
        >
          {matrix.cells.length ? (
            <Chart
              build={build}
              height={Math.max(260, matrix.companies.length * 22 + 140)}
              label={`${b.firm.name}: private book by company and fund`}
            />
          ) : (
            <Empty>No private holdings.</Empty>
          )}
          <div class="muted small" style={{ marginTop: '6px' }}>
            Largest cell: {money(Math.max(0, ...matrix.cells.map(c => c[2])))}
          </div>
        </Card>
      )}
    </div>
  );
}
