import { beforeEach, describe, expect, it } from 'vitest';
import {
  followRedirects,
  importV1,
  isWatched,
  removeWatch,
  toggleWatch,
  v1Entries,
  watchlist,
} from '../src/lib/watchlist';

// The watchlist keys by identity (company id, firm id, fund key), never by
// name (trap 48), and imports only what v1 had resolved to a reviewed company.

describe('watchlist', () => {
  beforeEach(() => {
    localStorage.clear();
    watchlist.value = [];
  });

  it('toggles by kind and key, and persists to localStorage', () => {
    toggleWatch({ kind: 'company', key: 5, label: 'Stripe' });
    toggleWatch({ kind: 'firm', key: 5, label: 'Some firm' });
    expect(isWatched('company', '5')).toBe(true);
    expect(isWatched('firm', 5)).toBe(true);
    expect(isWatched('fund', 5)).toBe(false);
    expect(JSON.parse(localStorage.getItem('vantage.watchlist')!)).toHaveLength(2);
    toggleWatch({ kind: 'company', key: '5', label: 'Stripe' });
    expect(isWatched('company', 5)).toBe(false);
    removeWatch('firm', '5');
    expect(watchlist.value).toEqual([]);
  });

  it('two funds with one name stay two items', () => {
    toggleWatch({ kind: 'fund', key: 'S000006037', label: 'Contrafund' });
    toggleWatch({ kind: 'fund', key: 'S000099999', label: 'Contrafund' });
    expect(watchlist.value).toHaveLength(2);
  });

  it('imports v1 entries resolved to a company, once; counts the rest', () => {
    localStorage.setItem(
      'nportWatchlist',
      JSON.stringify([
        { name: 'anthropic', kind: 'company', ref: 1, matched: 'Anthropic' },
        { name: 'some spv', kind: 'unreviewed', ref: 'SOME SPV' },
        'plain name',
      ])
    );
    expect(v1Entries().companies).toEqual([{ kind: 'company', key: '1', label: 'Anthropic' }]);
    expect(importV1()).toEqual({ added: 1, skipped: 2 });
    expect(importV1()).toEqual({ added: 0, skipped: 2 });
    expect(isWatched('company', 1)).toBe(true);
  });

  it('a merged firm or company id moves to its successor, once; dropped ones stay (F08)', () => {
    toggleWatch({ kind: 'firm', key: 3, label: 'Old firm' });
    toggleWatch({ kind: 'firm', key: 7, label: 'Gone firm' });
    toggleWatch({ kind: 'company', key: 40, label: 'Old co' });
    toggleWatch({ kind: 'company', key: 5, label: 'Stripe' });
    const moved = followRedirects([
      { kind: 'firm', key: 3, status: { state: 'merged', successor: 9 } },
      { kind: 'firm', key: 7, status: { state: 'dropped' } },
      { kind: 'company', key: 40, status: { state: 'merged', successor: 5 } }, // already saved as 5
    ]);
    expect(moved).toBe(2);
    expect(watchlist.value.map(x => `${x.kind}:${x.key}`)).toEqual(['firm:9', 'firm:7', 'company:5']);
    expect(followRedirects([{ kind: 'firm', key: 3, status: { state: 'merged', successor: 9 } }])).toBe(0);
  });
});
