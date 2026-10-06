import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { getJSON, qs } from '../api/client';
import { useDialog } from './useDialog';
import type { Envelope, SearchHit, UnifiedHit } from '../api/types';
import { companyPath, entityPath, firmPath, fundPath, moneyC } from '../lib/format';

// One search box for everything (⌘K or /): one call to the unified search,
// which ranks private companies, unreviewed names (with the match reason),
// firms, funds and share classes ("Anthropic Series G"). Enter opens the
// highlighted result.

export interface PaletteItem {
  kind: 'Company' | 'Name' | 'Fund' | 'Firm' | 'Class';
  title: string;
  detail: string;
  href: string;
  strong?: boolean;
  /** 0 exact, 1 starts with, 2 other: ranks across kinds before kind order. */
  tier?: number;
}

const MATCH_TEXT: Record<string, string> = {
  exact: 'exact',
  normalized: 'same name, different spelling',
  prefix: 'starts with',
  substring: 'contains',
  similar: 'similar spelling',
};

const RECENT_KEY = 'vantage.recent';
function recent(): PaletteItem[] {
  try {
    // stored by an older build or edited by hand: keep only well-formed in-app links
    const list: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return (Array.isArray(list) ? list : [])
      .filter(
        (r): r is PaletteItem =>
          !!r && typeof r.title === 'string' && typeof r.href === 'string' && /^\/(?!\/)/.test(r.href)
      )
      .slice(0, 8);
  } catch {
    return [];
  }
}
export function remember(item: PaletteItem) {
  try {
    const list = [item, ...recent().filter(r => r.href !== item.href)].slice(0, 8);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    // storage blocked: no recents
  }
}

export function hitToItem(h: SearchHit): PaletteItem {
  const ev = h.evidence;
  const how = MATCH_TEXT[h.match.how] || h.match.how;
  const via = h.match.via === 'name' ? '' : ` "${h.match.text}"`;
  const held = ev
    ? `${ev.currentFunds} funds · ${moneyC(ev.currentValueUsd)} · ${ev.firstMarkDate ?? '—'} → ${ev.lastMarkDate ?? '—'}`
    : '';
  return {
    kind: h.type === 'company' ? 'Company' : 'Name',
    title: h.name,
    detail: [held, `${how}${via}`, h.status === 'public' ? 'listed' : '', h.type === 'unreviewed' ? 'unreviewed' : '']
      .filter(Boolean)
      .join(' · '),
    href: h.type === 'company' ? companyPath(h.id!, h.name) : entityPath(h.key!),
    strong: h.strong,
    tier: h.match.how === 'exact' || h.match.how === 'normalized' ? 0 : h.match.how === 'prefix' ? 1 : 2,
  };
}

const SEARCH_KINDS = 'company,entity,firm,fund,class';

/** One ranked list from the server; tier keeps its order (byKind sorts by tier first). */
export function unifiedToItem(h: UnifiedHit, rank: number): PaletteItem {
  if (h.type === 'firm')
    return {
      kind: 'Firm',
      title: h.name,
      tier: rank,
      strong: h.strong,
      detail: `${h.evidence.fundsHolding} of ${h.evidence.fundsManaged} funds hold private companies · ${h.evidence.companies} companies · ${moneyC(h.evidence.value)}`,
      href: firmPath(h.id),
    };
  if (h.type === 'fund') {
    const f = h.fund;
    return {
      kind: 'Fund',
      title: h.name,
      tier: rank,
      strong: h.strong,
      detail: `${f.registrant !== f.seriesName ? f.registrant + ' · ' : ''}${f.firstReportDate} → ${f.lastReportDate}${f.inactive ? ' · inactive' : ''}`,
      href: fundPath(f.fundKey),
    };
  }
  if (h.type === 'class')
    return {
      kind: 'Class',
      title: h.name,
      tier: rank,
      strong: h.strong,
      detail: `${h.evidence.currentFunds} funds · ${moneyC(h.evidence.currentValueUsd)}${h.evidence.asOf ? ` as of ${h.evidence.asOf}` : ''}`,
      href: `${companyPath(h.companyId, h.company)}${qs({ class: h.classLabel })}`,
    };
  return { ...hitToItem(h), tier: rank };
}

/** Throws when the search fails: an outage is never shown as "no match" (staff review F13). */
export async function searchAll(q: string, signal?: AbortSignal): Promise<PaletteItem[]> {
  const r = await getJSON<Envelope & { results: UnifiedHit[] }>(
    `/api/search${qs({ q, kinds: SEARCH_KINDS, limit: 20 })}`,
    signal
  );
  return (r.results ?? []).map(unifiedToItem);
}

const KIND_ORDER: PaletteItem['kind'][] = ['Company', 'Firm', 'Class', 'Name', 'Fund'];
/** Best match first: how exactly it matched, then companies, firms, unreviewed names, funds. */
export const byKind = (items: PaletteItem[]) =>
  [...items].sort((a, b) => (a.tier ?? 0) - (b.tier ?? 0) || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { route } = useLocation();
  const [q, setQ] = useState('');
  const [items, setItems] = useState<PaletteItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  useDialog(box, onClose, open);
  // Enter pressed while a search is in flight opens that search's best result
  // when it arrives, never a stale row from the previous list.
  const pendingEnter = useRef<string | null>(null);
  const searched = useRef('');

  // Focus as soon as the dialog is in the DOM, so keys typed right after ⌘K land.
  useLayoutEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  // Reset on close, never on open: an effect that cleared the box after it
  // opened wiped keys typed in that first frame.
  useEffect(() => {
    if (!open) {
      searched.current = '';
      pendingEnter.current = null;
      setQ('');
      setItems(recent());
      setSel(0);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const term = q.trim();
    setFailed(null);
    if (term.length < 2) {
      setItems(recent());
      setBusy(false);
      return;
    }
    const ctl = new AbortController();
    setBusy(true);
    const t = setTimeout(() => {
      searchAll(term, ctl.signal).then(
        r => {
          if (ctl.signal.aborted) return;
          searched.current = term;
          setItems(r);
          setSel(0);
          setBusy(false);
          if (pendingEnter.current === term) {
            pendingEnter.current = null;
            go(byKind(r)[0]);
          }
        },
        err => {
          if (ctl.signal.aborted) return;
          pendingEnter.current = null;
          setItems([]);
          setFailed(String(err?.message || err));
          setBusy(false);
        }
      );
    }, 120);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [q, open, attempt]);

  const go = (it: PaletteItem | undefined) => {
    if (!it) return;
    remember(it);
    onClose();
    route(it.href);
  };

  const grouped = useMemo(() => byKind(items), [items]);

  if (!open) return null;
  return (
    <div class="overlay" onClick={onClose}>
      <div
        ref={box}
        class="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Search companies, funds and firms"
        onClick={e => e.stopPropagation()}
      >
        <input
          ref={input}
          autoFocus
          value={q}
          placeholder="Search a private company, fund or firm…"
          aria-label="Search"
          aria-controls="palette-list"
          aria-activedescendant={grouped[sel] ? `pi-${sel}` : undefined}
          onInput={e => setQ((e.target as HTMLInputElement).value)}
          onKeyDown={e => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setSel(s => Math.min(s + 1, grouped.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setSel(s => Math.max(s - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              // the live value: this render's `q` can lag fast typing
              const live = (e.currentTarget as HTMLInputElement).value.trim();
              if (live.length >= 2 && searched.current !== live) pendingEnter.current = live;
              else if (live === q.trim()) go(grouped[sel]);
            }
          }}
        />
        <ul id="palette-list" role="listbox">
          {q.trim().length < 2 && grouped.length > 0 && <li class="muted small">Recent</li>}
          {grouped.map((it, i) => (
            <li
              key={it.href}
              id={`pi-${i}`}
              role="option"
              aria-selected={i === sel}
              onMouseEnter={() => setSel(i)}
              onClick={() => go(it)}
            >
              <span class="kind">{it.kind}</span>
              <span style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>
                  {it.title} {it.strong && <span class="badge info">best match</span>}
                </div>
                <div class="muted small" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {it.detail}
                </div>
              </span>
            </li>
          ))}
          {!busy && failed && (
            <li class="muted" role="alert">
              Search failed ({failed}).{' '}
              <button class="btn sm" type="button" onClick={() => setAttempt(a => a + 1)}>
                Retry
              </button>
            </li>
          )}
          {!busy && !failed && q.trim().length >= 2 && grouped.length === 0 && (
            <li class="muted">No private company, fund or firm in the warehouse matches “{q.trim()}”.</li>
          )}
          {busy && <li class="muted">Searching…</li>}
        </ul>
        <div class="foot">
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> move
          </span>
          <span>
            <kbd>Enter</kbd> open
          </span>
          <span>
            <kbd>Esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  );
}
