import { describe, expect, it } from 'vitest';
import { addYears, EMPTY_SCOPE, isRange, parseScope, scopeParams, scopeQuery, windowOf } from '../src/scope/scope';

describe('scope <-> URL', () => {
  it('round-trips every field and keeps other params', () => {
    const s = {
      ...EMPTY_SCOPE,
      from: '2025-11-30',
      to: '2026-05-31',
      firms: [9, 3],
      funds: ['S000009228'],
      classes: ['Common B', 'Preferred I'],
      kind: 'direct' as const,
    };
    const q = scopeQuery(s, new URLSearchParams('tab=changes'));
    expect(q).toContain('tab=changes');
    const back = parseScope(q);
    expect(back).toEqual({ ...s, asof: '' });
    expect(isRange(back)).toBe(true);
  });

  it('a range wins over asof; asof alone is not a range', () => {
    expect(scopeQuery({ ...EMPTY_SCOPE, asof: '2026-03-31', from: '2025-01-01', to: '2026-01-01' })).not.toContain(
      'asof'
    );
    const a = parseScope('?asof=2026-03-31');
    expect(a.asof).toBe('2026-03-31');
    expect(isRange(a)).toBe(false);
  });

  it('drops malformed values instead of guessing', () => {
    const s = parseScope('?asof=03/31/2026&firm=abc&firm=-2&firm=9&kind=both&from=2026-01-01');
    expect(s.asof).toBe('');
    expect(s.firms).toEqual([9]);
    expect(s.kind).toBe('');
    expect(isRange(s)).toBe(false);
  });
});

describe('scope as API params', () => {
  it('sends every filter a view applies, and only those', () => {
    const s = parseScope('?firm=9&firm=3&fund=S000009228&class=Series+G&kind=indirect&asof=2026-03-31');
    expect(scopeParams(s)).toEqual({ firm: ['9', '3'], fund: ['S000009228'], class: ['Series G'], kind: 'indirect' });
    expect(scopeParams(s, ['firm', 'kind'])).toEqual({ firm: ['9', '3'], kind: 'indirect' });
    expect(scopeParams(parseScope(''))).toEqual({});
  });
});

// UI audit: a date picked on an as-of view (Market's Top tab) was dropped by the
// range views next to it (Movers, Newly reported), which read the newest year.
describe('the window a range view reads', () => {
  const newest = '2026-08-31';
  it('is the range when the URL has one', () => {
    expect(windowOf(parseScope('from=2024-01-31&to=2024-06-30&asof=2025-12-31'), newest, 1)).toEqual({
      from: '2024-01-31',
      to: '2024-06-30',
    });
  });
  it('ends at the as-of date when one was picked', () => {
    expect(windowOf(parseScope('asof=2025-12-31'), newest, 1)).toEqual({ from: '2024-12-31', to: '2025-12-31' });
    expect(windowOf(parseScope('asof=2025-12-31'), newest, 3)).toEqual({ from: '2022-12-31', to: '2025-12-31' });
  });
  it('ends at the newest filing otherwise, and is empty before freshness loads', () => {
    expect(windowOf(EMPTY_SCOPE, newest, 2)).toEqual({ from: '2024-08-31', to: newest });
    expect(windowOf(EMPTY_SCOPE, null, 2)).toEqual({ from: '', to: '' });
  });
  it('moves whole years, Feb 29 included', () => {
    expect(addYears('2024-02-29', -1)).toBe('2023-03-01');
    expect(addYears('2025-06-30', 1)).toBe('2026-06-30');
  });
});
