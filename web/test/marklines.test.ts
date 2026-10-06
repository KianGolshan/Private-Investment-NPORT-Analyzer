// Staff review F15: the position drawer draws each class's own mark; a change in
// the mix of classes never moves a line, and a split restates only its class.
import { describe, expect, it } from 'vitest';
import { markLines } from '../src/pages/company/markLines';

const leg = (markDate: string, classLabel: string, balance: number, value: number, split: number | null = null) => ({
  markDate,
  classLabel,
  perShare: true,
  balance,
  value,
  split,
});

describe('markLines', () => {
  it('two classes with unchanged marks and a changing mix: two flat lines, no blend', () => {
    // Series A $10, Common $2; the fund moves from mostly A to mostly Common.
    // A pooled line would read $9.20 (1,000 A + 100 C) then $3.60 (100 A + 1,000 C).
    const lines = markLines([
      leg('2025-03-31', 'Series A', 1000, 10000),
      leg('2025-03-31', 'Common', 100, 200),
      leg('2025-06-30', 'Series A', 100, 1000),
      leg('2025-06-30', 'Common', 1000, 2000),
    ]);
    const byClass = Object.fromEntries(lines.map(l => [l.classLabel, Object.fromEntries(l.points)]));
    expect(byClass).toEqual({
      'Series A': { '2025-03-31': 10, '2025-06-30': 10 },
      Common: { '2025-03-31': 2, '2025-06-30': 2 },
    });
  });

  it('a split in one class restates only that class, along its own history', () => {
    // Common splits 4:1 at 2025-06-30 ($40 -> $10 a share); Series A stays $5.
    const lines = markLines([
      leg('2025-03-31', 'Common', 100, 4000),
      leg('2025-03-31', 'Series A', 100, 500),
      leg('2025-06-30', 'Common', 400, 4000, 4),
      leg('2025-06-30', 'Series A', 100, 500),
    ]);
    const c = lines.find(l => l.classLabel === 'Common')!;
    const a = lines.find(l => l.classLabel === 'Series A')!;
    expect(Object.fromEntries(c.points)).toEqual({ '2025-03-31': 10, '2025-06-30': 10 });
    expect(c.split).toBe(true);
    expect(Object.fromEntries(a.points)).toEqual({ '2025-03-31': 5, '2025-06-30': 5 });
    expect(a.split).toBe(false);
  });

  it('lots of one class at one filing are one position; rows without shares or value are left out', () => {
    const [l] = markLines([
      leg('2025-03-31', 'Series B', 100, 1000),
      leg('2025-03-31', 'Series B', 300, 3600),
      { ...leg('2025-03-31', 'Series B', 0, 50), balance: null },
      leg('2025-06-30', 'Series B', 400, 0),
    ]);
    expect(Object.fromEntries(l!.points)).toEqual({ '2025-03-31': 11.5 });
  });
});
