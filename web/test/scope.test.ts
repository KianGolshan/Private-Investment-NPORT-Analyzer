import { describe, expect, it } from 'vitest';
import { EMPTY_SCOPE, isRange, parseScope, scopeQuery } from '../src/scope/scope';

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
