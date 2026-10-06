import { effect, signal } from '@preact/signals';
import type { WatchKind } from '../api/types';

// The viewer's watchlist (P6b W4): companies, firms and funds they follow,
// by identity (company id, firm id, fund key; trap 48), with the name as a
// label only. Kept in this browser's localStorage first, per the plan; the
// numbers come from the server (/api/watchlist). Without storage the list
// lasts for this page only.

export interface WatchItem {
  kind: WatchKind;
  key: string;
  label: string;
}

const KEY = 'vantage.watchlist';
const V1_KEY = 'nportWatchlist';

function load(): WatchItem[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(raw)
      ? raw.filter(
          (x): x is WatchItem =>
            x && ['company', 'firm', 'fund'].includes(x.kind) && typeof x.key === 'string' && !!x.key
        )
      : [];
  } catch {
    return [];
  }
}

export const watchlist = signal<WatchItem[]>(load());
effect(() => {
  try {
    localStorage.setItem(KEY, JSON.stringify(watchlist.value));
  } catch {
    // storage blocked: the list lasts for this page only
  }
});

const same = (a: Pick<WatchItem, 'kind' | 'key'>, b: Pick<WatchItem, 'kind' | 'key'>) =>
  a.kind === b.kind && a.key === b.key;

export const isWatched = (kind: WatchKind, key: string | number) =>
  watchlist.value.some(x => same(x, { kind, key: String(key) }));

export function toggleWatch(item: { kind: WatchKind; key: string | number; label: string }) {
  const it = { ...item, key: String(item.key) };
  watchlist.value = isWatched(it.kind, it.key) ? watchlist.value.filter(x => !same(x, it)) : [...watchlist.value, it];
}

export function removeWatch(kind: WatchKind, key: string) {
  watchlist.value = watchlist.value.filter(x => !same(x, { kind, key }));
}

/**
 * v1's watchlist (same origin, key "nportWatchlist"): entries v1 already
 * resolved to a reviewed company come across; names it never matched, or
 * matched only to an unreviewed name, are counted and left in v1.
 */
export function v1Entries(): { companies: WatchItem[]; skipped: number } {
  try {
    const raw = JSON.parse(localStorage.getItem(V1_KEY) || '[]');
    if (!Array.isArray(raw)) return { companies: [], skipped: 0 };
    const companies: WatchItem[] = [];
    let skipped = 0;
    for (const e of raw) {
      if (e && typeof e === 'object' && e.kind === 'company' && e.ref != null)
        companies.push({ kind: 'company', key: String(e.ref), label: String(e.matched || e.name || e.ref) });
      else skipped++;
    }
    return { companies, skipped };
  } catch {
    return { companies: [], skipped: 0 };
  }
}

export function importV1(): { added: number; skipped: number } {
  const { companies, skipped } = v1Entries();
  const fresh = companies.filter(c => !isWatched(c.kind, c.key));
  if (fresh.length) watchlist.value = [...watchlist.value, ...fresh];
  return { added: fresh.length, skipped };
}
