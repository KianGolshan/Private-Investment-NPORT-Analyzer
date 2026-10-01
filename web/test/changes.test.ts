import { describe, expect, it } from 'vitest';
import type { Leg } from '../src/api/types';
import { legLines } from '../src/ui/ChangesTable';

// Growth Fund of America, Stripe, 2026-02-28 -> 2026-05-31 (the warehouse's
// activity legs): CL B (physical) 1,123,404 -> 3,504,356 sh at a flat $63.00,
// six other classes unchanged at $63.00.
const leg = (instrument: string, prevBalance: number, balance: number, change: string): Leg => ({
  instrumentKey: instrument,
  instrument,
  title: instrument,
  unit: 'NS',
  viaSpv: false,
  prevBalance,
  balance,
  prevValue: prevBalance * 63,
  value: balance * 63,
  prevPrice: 63,
  price: 63,
  perShare: true,
  split: null,
  priceChangePct: 0,
  balanceChange: balance - prevBalance,
  change,
});

describe('change rows', () => {
  it('lists the class that changed and folds the unchanged ones', () => {
    const lines = legLines({
      type: 'added',
      instruments: [
        leg('Common B', 1_123_404, 3_504_356, 'added'),
        leg('Preferred H', 376_444, 376_444, 'unchanged'),
        leg('Preferred I', 7_098_300, 7_098_300, 'unchanged'),
        leg('Common B (DRS)', 30_538, 30_538, 'unchanged'),
        leg('Preferred BB-1', 604_130, 604_130, 'unchanged'),
        leg('Preferred BB', 214_287, 214_287, 'unchanged'),
        leg('Preferred G', 396_250, 396_250, 'unchanged'),
      ],
    });
    expect(lines.map(l => l.text)).toEqual([
      'Common B: 1,123,404 → 3,504,356 · $63.00/sh → $63.00/sh (0.0%)',
      '6 classes, shares unchanged · $63.00/sh → $63.00/sh (0.0%)',
    ]);
  });
  it('keeps a lone unchanged class on its own line', () => {
    const lines = legLines({ type: 'unchanged', instruments: [leg('Common', 10, 10, 'unchanged')] });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).toMatch(/^Common: 10 → 10/);
  });
});
