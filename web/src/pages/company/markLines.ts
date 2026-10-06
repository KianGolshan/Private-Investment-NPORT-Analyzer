import type { FactLeg } from '../../api/types';

// One fund's per-share mark in each class it holds, filing by filing (staff
// review F15). Classes are never pooled: a preferred and a common class carry
// different marks, so a blend of the two would move whenever the mix of shares
// changed, with no class re-marked. Lots of one class at one filing are one
// position (value over shares). Each class is split-adjusted along its own
// history (trap 9): a split in one class restates only that class's earlier
// marks.

type Leg = Pick<FactLeg, 'markDate' | 'classLabel' | 'perShare' | 'balance' | 'value' | 'split'>;

export interface MarkLine {
  classLabel: string;
  /** mark date -> split-adjusted price per share */
  points: Map<string, number>;
  split: boolean;
}

export function markLines(legs: Leg[]): MarkLine[] {
  const byClass = new Map<string, Map<string, { value: number; shares: number; split: number }>>();
  for (const l of legs) {
    if (!l.perShare || !(l.balance && l.balance > 0) || !(l.value > 0)) continue;
    const dates = byClass.get(l.classLabel) ?? byClass.set(l.classLabel, new Map()).get(l.classLabel)!;
    const x = dates.get(l.markDate) ?? dates.set(l.markDate, { value: 0, shares: 0, split: 1 }).get(l.markDate)!;
    x.value += l.value;
    x.shares += l.balance;
    if (l.split) x.split = l.split;
  }
  const out: MarkLine[] = [];
  for (const [classLabel, dates] of byClass) {
    const sorted = [...dates].sort((a, b) => b[0].localeCompare(a[0]));
    const points = new Map<string, number>();
    let factor = 1;
    for (const [d, x] of sorted) {
      points.set(d, x.value / x.shares / factor);
      factor *= x.split;
    }
    out.push({ classLabel, points, split: sorted.some(([, x]) => x.split !== 1) });
  }
  // the class worth most at its latest filing first
  const latest = (m: MarkLine) => {
    const d = [...m.points.keys()].sort().at(-1)!;
    const x = byClass.get(m.classLabel)!.get(d)!;
    return x.value;
  };
  return out.sort((a, b) => latest(b) - latest(a));
}
