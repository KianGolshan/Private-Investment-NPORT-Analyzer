import { useApi } from '../api/client';
import type { Freshness } from '../api/types';

// How cross-company views read history (staff review F14): which companies
// count as private, and which firm a fund belongs to, are today's reviewed
// list and each fund's current N-CEN adviser, applied to every period. Shown
// on the market, explore, compare, firm and watchlist views and written into
// their exports (DataTable `basis`).

export const BASIS =
  "Private companies are today's reviewed list and a firm is each fund's current N-CEN adviser, applied to every period";

/** Which data and which reviewed files an answer came from, for notes and exports (review R18). */
export function provenance(f: Freshness | null | undefined): string {
  const g = f?.generation;
  if (!g) return '';
  const cur = g.curationDigest
    ? `curation sha256 ${g.curationDigest.slice(0, 12)}`
    : g.curationRev
      ? `curation ${g.curationRev.slice(0, 7)}${g.curationRev.endsWith('+dirty') ? ' with unsaved edits' : ''}`
      : '';
  return [`generation ${g.id}`, cur].filter(Boolean).join(', ');
}

export function useProvenance(on = true): string {
  return provenance(useApi<Freshness>(on ? '/api/freshness' : null).data);
}

export function BasisNote() {
  const p = useProvenance();
  return (
    <p class="muted small" style={{ margin: 0 }}>
      {BASIS}
      {p ? ` (${p})` : ''}. A company that has since listed is not counted in earlier periods.
    </p>
  );
}
