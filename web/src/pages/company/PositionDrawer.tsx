import { useCallback, useEffect, useMemo, useRef } from 'preact/hooks';
import { qs, useApi } from '../../api/client';
import type { FactLeg, PositionHistory } from '../../api/types';
import { fundPath, money, moneyC, moneyDelta, num, price, tone } from '../../lib/format';
import { scopeParams, useScope } from '../../scope/scope';
import { Card, Empty, ErrorBox, FilingRef, Kpi, Loading } from '../../ui/bits';
import { Chart } from '../../ui/Chart';
import { DataTable, type Column } from '../../ui/DataTable';
import { baseOption, type ChartTheme } from '../../ui/theme';
import type { ViewProps } from './shared';

// One fund's position in the company across its whole history (?pos=<fund>):
// value and per-share mark at every filing, and every leg's change with its
// position and mark effects, worded as filed. Opened from any fund row.

export function PositionDrawer({
  base,
  sq,
  name,
  fundKey,
  onClose,
}: Pick<ViewProps, 'base' | 'sq' | 'name'> & { fundKey: string; onClose: () => void }) {
  const [scope] = useScope();
  const hist = useApi<PositionHistory>(
    `${base}/positions/${encodeURIComponent(fundKey)}${qs({ ...sq, ...scopeParams(scope, ['class', 'kind']) })}`
  );
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    close.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const legs = hist.data?.legs ?? [];
  // One point per filing: the value reported, and the per-share mark of share rows.
  const filings = useMemo(() => {
    const m = new Map<string, { markDate: string; value: number; shares: number; shareValue: number }>();
    for (const l of legs) {
      const x =
        m.get(l.markDate) ??
        m.set(l.markDate, { markDate: l.markDate, value: 0, shares: 0, shareValue: 0 }).get(l.markDate)!;
      x.value += l.value;
      if (l.perShare && l.balance) {
        x.shares += l.balance;
        x.shareValue += l.value;
      }
    }
    const out = [...m.values()].sort((a, b) => a.markDate.localeCompare(b.markDate));
    // Split-adjust the per-share line to today's shares (trap 9): a 3:1 split
    // divides every earlier mark by 3, so it never reads as a crash.
    const splitAt = new Map<string, number>();
    for (const l of legs) if (l.split) splitAt.set(l.markDate, l.split);
    let factor = 1;
    const adjusted = new Map<string, number>();
    for (let i = out.length - 1; i >= 0; i--) {
      adjusted.set(out[i]!.markDate, factor);
      factor *= splitAt.get(out[i]!.markDate) ?? 1;
    }
    return out.map(f => ({ ...f, factor: adjusted.get(f.markDate) ?? 1 }));
  }, [legs]);
  const hasSplit = legs.some(l => l.split);
  const totals = useMemo(
    () =>
      legs.reduce((t, l) => ({ pos: t.pos + l.positionEffect + l.otherEffect, mark: t.mark + l.markEffect }), {
        pos: 0,
        mark: 0,
      }),
    [legs]
  );

  const build = useCallback(
    (t: ChartTheme) => {
      const b = baseOption(t);
      return {
        ...b,
        legend: { ...b.legend, data: ['Value', hasSplit ? 'Mark per share (split-adjusted)' : 'Mark per share'] },
        tooltip: { ...b.tooltip, valueFormatter: (v: number) => (v > 100000 ? moneyC(v) : money(v)) },
        xAxis: { type: 'category', data: filings.map(f => f.markDate), ...b.xAxisDefaults },
        yAxis: [
          { type: 'value', ...b.yAxisDefaults, axisLabel: { ...b.yAxisDefaults.axisLabel, formatter: moneyC } },
          { type: 'value', scale: true, ...b.yAxisDefaults, splitLine: { show: false } },
        ],
        series: [
          { name: 'Value', type: 'bar', data: filings.map(f => f.value), itemStyle: { color: t.series[0] } },
          {
            name: hasSplit ? 'Mark per share (split-adjusted)' : 'Mark per share',
            type: 'line',
            yAxisIndex: 1,
            data: filings.map(f => (f.shares ? f.shareValue / f.shares / f.factor : null)),
            itemStyle: { color: t.series[1] },
            connectNulls: true,
          },
        ],
      };
    },
    [filings, hasSplit]
  );

  const columns: Column<FactLeg>[] = [
    {
      id: 'markDate',
      header: 'Mark date',
      value: l => l.markDate,
      render: l => (
        <div>
          <FilingRef cik={hist.data?.fund.cik} accession={l.accession} date={l.markDate} />
          <div class="muted small">prior {l.prevMarkDate ?? '—'}</div>
        </div>
      ),
      exportAs: [
        { header: 'Accession', value: l => l.accession },
        { header: 'Prior accession', value: l => l.prevAccession },
      ],
    },
    {
      id: 'event',
      header: 'Filing',
      // An unchanged filing whose mark moved reads "mark moved" (as the Changes ledger words it).
      value: l =>
        l.event === 'unchanged' && l.prevPrice != null && l.price != null && Math.abs(l.price / l.prevPrice - 1) > 1e-6
          ? 'mark moved'
          : l.label,
    },
    {
      id: 'class',
      header: 'Class · change',
      value: l => `${l.classLabel} ${l.change}`,
      render: l => (
        <span class="small">
          {l.classLabel} · {l.change}
          {l.rekeyedFrom && <div class="muted">re-keyed from {l.rekeyedFrom}</div>}
          {l.mergedKeys && <div class="muted">one class with {l.mergedKeys.join(', ')}</div>}
        </span>
      ),
      exportAs: [
        { header: 'Instrument key', value: l => l.instrumentKey },
        { header: 'Title', value: l => l.title },
      ],
      wrap: true,
    },
    {
      id: 'shares',
      header: 'Shares',
      value: l => l.balance,
      num: true,
      render: l => (
        <span class="small">
          {l.prevBalance != null && l.prevBalance !== l.balance ? `${num(l.prevBalance)} → ` : ''}
          {num(l.balance)}
          {l.split ? ` (split ${l.split}:1)` : ''}
        </span>
      ),
      exportAs: [{ header: 'Prior shares', value: l => l.prevBalance }],
    },
    {
      id: 'mark',
      header: 'Mark',
      value: l => l.price,
      num: true,
      render: l => (
        <span class="small">
          {l.prevPrice != null && l.price != null && Math.abs(l.prevPrice - l.price) > 1e-9
            ? `${price(l.prevPrice, l.perShare ? 'NS' : l.unit)} → `
            : ''}
          {price(l.price, l.perShare ? 'NS' : l.unit)}
        </span>
      ),
      exportAs: [{ header: 'Prior mark', value: l => l.prevPrice }],
    },
    { id: 'value', header: 'Value', value: l => l.value, num: true, render: l => moneyC(l.value) },
    {
      id: 'pos',
      header: 'Position Δ',
      value: l => l.positionEffect + l.otherEffect,
      num: true,
      render: l => (
        <span class={tone(l.positionEffect + l.otherEffect)}>{moneyDelta(l.positionEffect + l.otherEffect)}</span>
      ),
    },
    {
      id: 'markD',
      header: 'Mark Δ',
      value: l => l.markEffect,
      num: true,
      render: l => <span class={tone(l.markEffect)}>{moneyDelta(l.markEffect)}</span>,
    },
  ];

  const f = hist.data?.fund;
  return (
    <div class="overlay" onClick={onClose}>
      <aside
        class="drawer"
        role="dialog"
        aria-modal="true"
        aria-label={`Position history: ${f?.label ?? fundKey} in ${name}`}
        onClick={e => e.stopPropagation()}
      >
        <div class="drawer-head">
          <div style={{ minWidth: 0 }}>
            <div class="eyebrow">Position history · {name}</div>
            <strong>{f ? <a href={fundPath(f.fundKey)}>{f.label}</a> : fundKey}</strong>
          </div>
          <span class="spacer" />
          <button ref={close} class="btn sm" type="button" onClick={onClose} aria-label="Close position history">
            Close
          </button>
        </div>
        <div class="drawer-body stack">
          <ErrorBox error={hist.error} />
          {hist.loading && !hist.data && <Loading rows={6} />}
          {hist.data && (
            <>
              <div class="kpis">
                <Kpi
                  label="Filings"
                  value={num(filings.length)}
                  sub={`${filings[0]?.markDate ?? ''} → ${filings[filings.length - 1]?.markDate ?? ''}`}
                />
                <Kpi label="Latest value" value={moneyC(filings[filings.length - 1]?.value)} />
                <Kpi
                  label="From positions"
                  value={<span class={tone(totals.pos)}>{moneyDelta(totals.pos)}</span>}
                  sub="whole history"
                />
                <Kpi
                  label="From marks"
                  value={<span class={tone(totals.mark)}>{moneyDelta(totals.mark)}</span>}
                  sub="whole history"
                />
              </div>
              {filings.length > 1 ? (
                <Chart build={build} height={220} label={`${f?.label}: value and per-share mark by filing`} />
              ) : (
                <Empty>One filing.</Empty>
              )}
              <Card title="Every leg, filing by filing" flush>
                <DataTable
                  columns={columns}
                  rows={legs}
                  rowKey={l => `${l.accession}:${l.instrumentKey}`}
                  sort={{ id: 'markDate', desc: true }}
                  exportName={`${name}-${f?.label ?? fundKey}-position`}
                  maxHeight={480}
                />
              </Card>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}
