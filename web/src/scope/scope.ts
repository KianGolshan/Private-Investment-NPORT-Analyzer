import { useLocation } from 'preact-iso';

// The global scope: one date (as of D) or a range (from..to), plus filters by
// firm, fund, share class and kind. It lives in the URL only, so every view is
// a permalink and Back/Forward walk the analyst's steps. Pages read it with
// useScope() and change it with setScope(); nothing else holds a copy.

export interface Scope {
  /** As-of date (ISO). Empty = the newest data. Ignored when a range is set. */
  asof: string;
  /** Range start and end (ISO, mark dates). Both set = range mode. */
  from: string;
  to: string;
  /** Firm ids (managers), fund keys, class labels (e.g. "Preferred G-1"). */
  firms: number[];
  funds: string[];
  classes: string[];
  /** direct = held by the fund; indirect = through an SPV. Empty = both. */
  kind: '' | 'direct' | 'indirect';
}

export const EMPTY_SCOPE: Scope = { asof: '', from: '', to: '', firms: [], funds: [], classes: [], kind: '' };

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const iso = (v: string | null) => (v && ISO.test(v) ? v : '');

export function parseScope(search: string): Scope {
  const sp = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const kind = sp.get('kind');
  return {
    asof: iso(sp.get('asof')),
    from: iso(sp.get('from')),
    to: iso(sp.get('to')),
    firms: sp
      .getAll('firm')
      .map(Number)
      .filter(n => Number.isInteger(n) && n > 0),
    funds: sp.getAll('fund').filter(Boolean),
    classes: sp.getAll('class').filter(Boolean),
    kind: kind === 'direct' || kind === 'indirect' ? kind : '',
  };
}

export const isRange = (s: Scope) => !!(s.from && s.to);

/** Scope as URL params, merged over the URL's other params (e.g. a page's tab). */
export function scopeQuery(s: Scope, others: URLSearchParams = new URLSearchParams()): string {
  const sp = new URLSearchParams(others);
  for (const k of ['asof', 'from', 'to', 'firm', 'fund', 'class', 'kind']) sp.delete(k);
  if (isRange(s)) {
    sp.set('from', s.from);
    sp.set('to', s.to);
  } else if (s.asof) sp.set('asof', s.asof);
  s.firms.forEach(f => sp.append('firm', String(f)));
  s.funds.forEach(f => sp.append('fund', f));
  s.classes.forEach(c => sp.append('class', c));
  if (s.kind) sp.set('kind', s.kind);
  const q = sp.toString();
  return q ? `?${q}` : '';
}

export function hasFilters(s: Scope): boolean {
  return s.firms.length + s.funds.length + s.classes.length > 0 || !!s.kind;
}

/** The current scope and a setter that pushes a new URL (Back undoes it). */
export function useScope(): [Scope, (patch: Partial<Scope>, opts?: { replace?: boolean }) => void] {
  const loc = useLocation();
  const search = loc.url.includes('?') ? loc.url.slice(loc.url.indexOf('?')) : '';
  const scope = parseScope(search);
  const set = (patch: Partial<Scope>, opts: { replace?: boolean } = {}) => {
    const next = { ...scope, ...patch };
    const others = new URLSearchParams(search.slice(1));
    loc.route(loc.path + scopeQuery(next, others), opts.replace);
  };
  return [scope, set];
}

/** A URL param other than the scope (e.g. ?tab=), read and set the same way. */
export function useParam(name: string): [string, (v: string, opts?: { replace?: boolean }) => void] {
  const loc = useLocation();
  const search = loc.url.includes('?') ? loc.url.slice(loc.url.indexOf('?') + 1) : '';
  const sp = new URLSearchParams(search);
  const value = sp.get(name) || '';
  const set = (v: string, opts: { replace?: boolean } = {}) => {
    const next = new URLSearchParams(search);
    if (v) next.set(name, v);
    else next.delete(name);
    const q = next.toString();
    loc.route(loc.path + (q ? `?${q}` : ''), opts.replace);
  };
  return [value, set];
}

/**
 * The scope's filters as API query params (P6b W1: every company route takes
 * firm, fund, class and kind). `only` limits them to the filters a view applies.
 */
export function scopeParams(
  s: Scope,
  only: ('firm' | 'fund' | 'class' | 'kind')[] = ['firm', 'fund', 'class', 'kind']
): Record<string, string | string[]> {
  const on = new Set(only);
  const out: Record<string, string | string[]> = {};
  if (on.has('firm') && s.firms.length) out.firm = s.firms.map(String);
  if (on.has('fund') && s.funds.length) out.fund = s.funds;
  if (on.has('class') && s.classes.length) out.class = s.classes;
  if (on.has('kind') && s.kind) out.kind = s.kind;
  return out;
}

/** Sets several URL params in one step (two useParam setters in a row would each start from the old URL). */
export function useSetParams(): (patch: Record<string, string>, opts?: { replace?: boolean }) => void {
  const loc = useLocation();
  const search = loc.url.includes('?') ? loc.url.slice(loc.url.indexOf('?') + 1) : '';
  return (patch, opts = {}) => {
    const next = new URLSearchParams(search);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    const q = next.toString();
    loc.route(loc.path + (q ? `?${q}` : ''), opts.replace);
  };
}
