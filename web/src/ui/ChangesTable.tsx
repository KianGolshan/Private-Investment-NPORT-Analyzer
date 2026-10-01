import type { ChangeEvent, Leg } from '../api/types';
import { companyPath, fundPath, moneyC, moneyDelta, num, pct, price, tone } from '../lib/format';
import { Badge, FilingRef } from './bits';
import { DataTable, type Column } from './DataTable';

// Position changes, filing by filing, worded as the filings allow: first
// reported, added, reduced, no longer reported, reported at $0, mark moved.
// Never a guessed cause (DATA-QUALITY display rules).

const TONE: Record<string, '' | 'pos' | 'warn' | 'info'> = {
  new: 'pos',
  added: 'pos',
  reduced: 'warn',
  exited: 'warn',
  zeroed: 'warn',
  mixed: 'info',
};

export function ChangeBadge({ e }: { e: Pick<ChangeEvent, 'type' | 'label'> }) {
  return <Badge tone={TONE[e.type] ?? ''}>{e.label}</Badge>;
}

function markText(l: Leg): string {
  const unit = l.perShare ? 'NS' : l.unit;
  return l.prevPrice != null && l.price != null
    ? `${price(l.prevPrice, unit)} → ${price(l.price, unit)} (${pct(l.priceChangePct)})`
    : price(l.price ?? l.prevPrice, unit);
}

/**
 * The lines shown for one event: every class whose shares changed on its own
 * line; classes whose shares did not change folded into one line per mark
 * move ("7 classes, shares unchanged · $41.42/sh → $63.00/sh"). Exports keep
 * every class (legText).
 */
export function legLines(e: Pick<ChangeEvent, 'type' | 'instruments'>): { key: string; text: string; note?: string }[] {
  const out: { key: string; text: string; note?: string }[] = [];
  const same = new Map<string, Leg[]>();
  for (const l of e.instruments) {
    if (l.change === 'unchanged') {
      const k = markText(l);
      const list = same.get(k);
      if (list) list.push(l);
      else same.set(k, [l]);
    } else out.push({ key: l.instrumentKey, text: legText(l), note: l.change !== e.type ? l.change : undefined });
  }
  for (const [mark, legs] of same) {
    out.push(
      legs.length === 1
        ? { key: legs[0]!.instrumentKey, text: legText(legs[0]!) }
        : { key: `same:${mark}`, text: `${legs.length} classes, shares unchanged · ${mark}` }
    );
  }
  return out;
}

export function legText(l: Leg): string {
  const shares =
    l.prevBalance != null && l.balance != null
      ? `${num(l.prevBalance)} → ${num(l.balance)}${l.split ? ` (split ${l.split}:1)` : ''}`
      : l.balance != null
        ? num(l.balance)
        : l.prevBalance != null
          ? `${num(l.prevBalance)} → none`
          : 'no share count';
  return `${l.instrument || l.title}: ${shares} · ${markText(l)}`;
}

export function ChangesTable({
  events,
  withCompany,
  withFund = true,
  exportName,
  maxHeight = 640,
}: {
  events: ChangeEvent[];
  withCompany?: boolean;
  withFund?: boolean;
  exportName: string;
  maxHeight?: number;
}) {
  const columns: Column<ChangeEvent>[] = [
    {
      id: 'markDate',
      header: 'Mark date',
      value: e => e.markDate,
      render: e => (
        <div>
          <FilingRef cik={e.cik} accession={e.accession} date={e.markDate} />
          <div class="muted small">prior {e.prevMarkDate ?? '—'}</div>
        </div>
      ),
      exportAs: [
        { header: 'Accession', value: e => e.accession },
        { header: 'Prior mark date', value: e => e.prevMarkDate },
        { header: 'Prior accession', value: e => e.prevAccession },
        { header: 'Filing date', value: e => e.filingDate },
      ],
    },
    ...(withCompany
      ? [
          {
            id: 'company',
            header: 'Company',
            value: (e: ChangeEvent) => e.company,
            render: (e: ChangeEvent) =>
              e.companyId ? <a href={companyPath(e.companyId, e.company || '')}>{e.company}</a> : e.company,
          } as Column<ChangeEvent>,
        ]
      : []),
    ...(withFund
      ? [
          {
            id: 'fund',
            header: 'Fund',
            value: (e: ChangeEvent) => e.fundLabel || e.seriesName || e.registrant,
            render: (e: ChangeEvent) => (
              <div>
                <a href={fundPath(e.fundKey)}>{e.fundLabel || e.seriesName || e.registrant}</a>
                {e.registrant !== (e.fundLabel || e.seriesName) && <div class="muted small">{e.registrant}</div>}
              </div>
            ),
            exportAs: [{ header: 'Fund key', value: (e: ChangeEvent) => e.fundKey }],
            wrap: true,
          } as Column<ChangeEvent>,
        ]
      : []),
    { id: 'type', header: 'Change', value: e => e.label, render: e => <ChangeBadge e={e} /> },
    {
      id: 'value',
      header: 'Value',
      num: true,
      value: e => e.value,
      render: e => (
        <span>
          <span class="muted">{moneyC(e.prevValue)} → </span>
          {moneyC(e.value)}
        </span>
      ),
      exportAs: [{ header: 'Prior value', value: e => e.prevValue }],
    },
    {
      id: 'delta',
      header: 'Δ value',
      num: true,
      value: e => e.valueChange,
      render: e => <span class={tone(e.valueChange)}>{moneyDelta(e.valueChange)}</span>,
    },
    {
      id: 'position',
      header: 'Position Δ',
      num: true,
      value: e => e.positionEffect + e.otherEffect,
      render: e => (
        <span
          class={tone(e.positionEffect)}
          title={e.otherEffect ? `${moneyDelta(e.otherEffect)} from rows with no share count` : undefined}
        >
          {moneyDelta(e.positionEffect + e.otherEffect)}
          {e.otherEffect !== 0 && <span class="muted">*</span>}
        </span>
      ),
      title: 'Shares added or removed, valued at the prior mark (new and dropped classes at their value)',
      exportAs: [{ header: 'No-share-count change', value: e => e.otherEffect }],
    },
    {
      id: 'mark',
      header: 'Mark Δ',
      num: true,
      value: e => e.markEffect,
      render: e => <span class={tone(e.markEffect)}>{moneyDelta(e.markEffect)}</span>,
      title: 'The change in mark on the shares held now',
    },
    {
      id: 'legs',
      header: 'Classes: shares · mark',
      value: e => e.instruments.map(legText).join(' | '),
      title:
        'Classes whose share count did not change are folded into one line per mark move; exports list every class',
      render: e => (
        <div class="small">
          {legLines(e).map(l => (
            <div key={l.key}>
              {l.text}
              {l.note && <span class="muted"> · {l.note}</span>}
            </div>
          ))}
          {e.instruments.some(l => l.rekeyedFrom) && (
            <div class="muted" title="Same holding under a new instrument id: the share count or mark carried over">
              the filer changed its instrument id (
              {e.instruments
                .filter(l => l.rekeyedFrom)
                .map(l => `${l.rekeyedFrom} → ${l.instrumentKey}`)
                .join(', ')}
              )
            </div>
          )}
        </div>
      ),
      wrap: true,
      noSort: true,
    },
  ];
  return (
    <DataTable
      columns={columns}
      rows={events}
      rowKey={(e, i) => `${e.fundKey}:${e.accession}:${e.companyId ?? ''}:${i}`}
      sort={{ id: 'markDate', desc: true }}
      exportName={exportName}
      filterPlaceholder="Filter changes…"
      maxHeight={maxHeight}
      empty="No position changes in this window."
    />
  );
}
