import type { Cost, CostTotal, RoundPrice } from '../api/types';
import { money, moneyC } from '../lib/format';
import type { Column } from './DataTable';
import { Term } from './Term';

// Cost basis in the tables (P15, ADR 0011). One place decides how a cost reads, what its
// tooltip says and which columns it exports, so the holders table, the drawer, the X-Ray
// and the firm book read and export it the same way (LESSONS 39). Columns are added only
// when a row has a cost: a table without one looks exactly as it did.

export const multiple = (v: number | null | undefined) =>
  v == null || !Number.isFinite(v) ? '—' : `${v >= 10 ? v.toFixed(1) : v.toFixed(2)}×`;

const acquired = (c: Cost) =>
  c.acquiredFirst === c.acquiredLast ? c.acquiredFirst : `${c.acquiredFirst} to ${c.acquiredLast}`;

export function costTitle(c: Cost): string {
  return [
    `Cost reported by the fund in its N-CSR for ${c.asOf} (${c.ncsrAccession}), acquired ${acquired(c)}.`,
    c.perShare != null ? `${money(c.perShare)} a share.` : 'Bought over several dates: no single entry price.',
    c.carried ? `Held with the same shares and no split since ${c.asOf}.` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

export function CostCell({ cost }: { cost: Cost | CostTotal | undefined | null }) {
  if (!cost) return <span class="muted">—</span>;
  const one = 'asOf' in cost;
  return (
    <span title={one ? costTitle(cost as Cost) : `Sum of ${cost.positions} positions, each with its cost`}>
      {moneyC(cost.usd)}
    </span>
  );
}

/** "Cost" and "Value ÷ cost" columns, or none when no row has a cost. */
export function costColumns<T>(rows: T[], costOf: (r: T) => Cost | CostTotal | undefined | null): Column<T>[] {
  if (!rows.some(r => costOf(r))) return [];
  const per = (r: T) => {
    const c = costOf(r);
    return c && 'asOf' in c ? (c as Cost) : null;
  };
  return [
    {
      id: 'cost',
      header: 'Cost',
      value: r => costOf(r)?.usd ?? null,
      num: true,
      render: r => <CostCell cost={costOf(r)} />,
      title: 'Cost reported by the fund in its N-CSR, shown only where it checks out exactly (see “Cost (N-CSR)”)',
      exportAs: [
        { header: 'Cost as of', value: r => per(r)?.asOf ?? null },
        { header: 'Acquired from', value: r => per(r)?.acquiredFirst ?? null },
        { header: 'Acquired to', value: r => per(r)?.acquiredLast ?? null },
        { header: 'Cost per share', value: r => per(r)?.perShare ?? null },
        { header: 'Cost carried (same shares)', value: r => (per(r) ? (per(r)!.carried ? 'yes' : 'no') : null) },
        { header: 'N-CSR accession', value: r => per(r)?.ncsrAccession ?? null },
      ],
    },
    {
      id: 'valueToCost',
      header: 'Value ÷ cost',
      value: r => costOf(r)?.valueToCost ?? null,
      num: true,
      render: r => {
        const c = costOf(r);
        return c ? (
          <span class={c.valueToCost != null && c.valueToCost < 1 ? 'neg' : ''}>{multiple(c.valueToCost)}</span>
        ) : (
          <span class="muted">—</span>
        );
      },
      title: 'The value shown divided by the cost: not a return (no dividends, no sales)',
    },
  ];
}

/** The company header's tile: the newest confirmed round prices. */
export function roundPriceTile(prices: RoundPrice[] | undefined) {
  if (!prices || !prices.length) return null;
  const shown = prices.slice(0, 2);
  const first = prices[0]!;
  return {
    label: 'Confirmed round price',
    value: (
      <span class="small" style={{ display: 'block', lineHeight: 1.5 }}>
        {shown.map(p => (
          <span
            key={`${p.classLabel}|${p.acquiredOn}`}
            style={{ display: 'block' }}
            title={`${p.funds} funds at ${p.firms} firms report paying ${money(p.price)} a share on ${p.acquiredOn} (N-CSR cost tables)`}
          >
            {p.classLabel}: {money(p.price)}
          </span>
        ))}
      </span>
    ),
    sub: (
      <>
        bought {first.acquiredOn} · {first.firms} firms · <Term id="roundPrice" />
      </>
    ),
  };
}
