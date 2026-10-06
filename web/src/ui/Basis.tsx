import { useApi } from '../api/client';
import type { Freshness } from '../api/types';

// How cross-company views read history (staff review F14): which companies
// count as private, and which firm a fund belongs to, are today's reviewed
// list and each fund's current N-CEN adviser, applied to every period. Shown
// on the market, explore, compare, firm and watchlist views and written into
// their exports (DataTable `basis`).

export const BASIS =
  "Private companies are today's reviewed list and a firm is each fund's current N-CEN adviser, applied to every period";

export function BasisNote() {
  const fresh = useApi<Freshness>('/api/freshness');
  const rev = fresh.data?.generation?.curationRev;
  return (
    <p class="muted small" style={{ margin: 0 }}>
      {BASIS}
      {rev ? ` (curation ${rev.slice(0, 7)}${rev.endsWith('+dirty') ? ', with unsaved edits' : ''})` : ''}. A company
      that has since listed is not counted in earlier periods.
    </p>
  );
}
