import { useApi } from '../api/client';
import type { Envelope, Firm } from '../api/types';
import { useScope } from './scope';

// Adds a firm to the scope (the scope bar's chips remove it). The firms that
// hold private companies now, largest first: the same list as the Firms page.

export function FirmPicker({ max = 200 }: { max?: number }) {
  const [scope, setScope] = useScope();
  const firms = useApi<Envelope & { results: Firm[] }>('/api/firms');
  const list = (firms.data?.results ?? [])
    .filter(f => f.value > 0 && !scope.firms.includes(f.id))
    .sort((a, b) => b.value - a.value)
    .slice(0, max);
  if (!list.length) return null;
  return (
    <select
      class="input"
      aria-label="Filter by firm"
      value=""
      onChange={e => {
        const id = Number((e.target as HTMLSelectElement).value);
        if (id) setScope({ firms: [...scope.firms, id] });
      }}
    >
      <option value="">+ Firm</option>
      {list.map(f => (
        <option key={f.id} value={f.id}>
          {f.name}
        </option>
      ))}
    </select>
  );
}
