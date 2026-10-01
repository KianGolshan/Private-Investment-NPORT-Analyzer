// Number, date and link formatting. One copy for the whole app (v1 had three
// versions of the signed-percent formatter).

const usd2 = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const int = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

const bad = (v: number | null | undefined): v is null | undefined => v == null || Number.isNaN(v);

/** Full dollars and cents: per-share prices and exact values. */
export const money = (v: number | null | undefined) => (bad(v) ? '—' : usd2.format(v));

/** Compact dollars for totals: $1.32B, $45.4M, $820.1K. */
export function moneyC(v: number | null | undefined): string {
  if (bad(v)) return '—';
  const sign = v < 0 ? '−' : '';
  const a = Math.abs(v);
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(1)}K`;
  return `${sign}$${a.toFixed(0)}`;
}

/** Signed compact dollars for changes: +$150.0M, −$2.1M. */
export const moneyDelta = (v: number | null | undefined) =>
  bad(v) ? '—' : v === 0 ? '$0' : (v > 0 ? '+' : '') + moneyC(v);

export const num = (v: number | null | undefined) => (bad(v) ? '—' : int.format(v));

export const signedNum = (v: number | null | undefined) =>
  bad(v) ? '—' : v === 0 ? '0' : (v > 0 ? '+' : '−') + int.format(Math.abs(v));

export const pct = (v: number | null | undefined, digits = 1) =>
  bad(v) ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(digits)}%`;

/** A share of a whole, unsigned: 0.0611716221 -> "6.12%" (pctNav is a fraction). */
export const share = (fraction: number | null | undefined, digits = 2) =>
  bad(fraction) ? '—' : `${(fraction * 100).toFixed(digits)}%`;

/** Per-share mark from share rows only; units and contracts are per unit (trap 40). */
export function price(v: number | null | undefined, unit: string | null | undefined): string {
  if (bad(v)) return '—';
  return `${money(v)}${unit === 'NS' ? '/sh' : '/unit'}`;
}

/** Class of a value change for color (always shown with its sign, never color alone). */
export const tone = (v: number | null | undefined) => (bad(v) || v === 0 ? '' : v > 0 ? 'pos' : 'neg');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 2026-05-31 -> "May 31, 2026". ISO dates stay ISO in tables and exports. */
export function longDate(isoDate: string | null | undefined): string {
  if (!isoDate) return '—';
  const [y, m, d] = isoDate.split('-').map(Number);
  return `${MONTHS[(m ?? 1) - 1]} ${d}, ${y}`;
}

export const slugOf = (name: string) =>
  String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

export const companyPath = (id: number, name: string) => `/company/${id}-${slugOf(name)}`;
export const entityPath = (key: string) => `/name/${encodeURIComponent(key)}`;
export const fundPath = (key: string) => `/fund/${encodeURIComponent(key)}`;
export const firmPath = (id: number) => `/firm/${id}`;

/** The filing's EDGAR index page (the source of truth for every number). */
export function edgarUrl(cik: string | number | null | undefined, accession: string | null | undefined) {
  if (!cik || !accession) return null;
  const c = String(cik).replace(/^0+/, '');
  return `https://www.sec.gov/Archives/edgar/data/${c}/${accession.replace(/-/g, '')}/${accession}-index.htm`;
}

export const todayIso = () => new Date().toISOString().slice(0, 10);
