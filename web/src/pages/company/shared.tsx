import { useMemo } from 'preact/hooks';
import { qs, useApi } from '../../api/client';
import type { Exposure, FirmRef, Position } from '../../api/types';
import { useScope } from '../../scope/scope';
import { Badge } from '../../ui/bits';

// Shared by the company workbench's tabs (P6b W2). Every tab asks the server
// for its answer within the scope (firm, fund, class, kind; services/scope.js),
// so a filtered number is the server's, never a client-side guess.

export interface ViewProps {
  /** /api/companies/:id or /api/entities/:key */
  base: string;
  /** ?stored=1 for a listed company's stored rows */
  sq: Record<string, number>;
  /** The subject for /api/analysis/* routes: { company: id } or { entity: key } (+ stored). */
  subject: Record<string, string | number>;
  name: string;
  newest: string | null;
  /** Opens the position drawer for one fund. */
  openPosition: (fundKey: string) => void;
}

export const firmNames = (firms: FirmRef[] | undefined) => (firms?.length ? firms.map(f => f.name).join(' / ') : '—');

const KIND_TEXT = { direct: 'directly', spv: 'through a named SPV', fund: 'as a fund interest' } as const;
export const kindText = (k: Position['kind']) => KIND_TEXT[k];

/** Indirect holdings, in the filing's terms: a named SPV, or a row the filer files as a fund interest. */
export function KindBadge({ kind }: { kind: Position['kind'] }) {
  if (kind === 'spv')
    return (
      <Badge tone="info" title="Held through a named SPV">
        through SPV
      </Badge>
    );
  if (kind === 'fund')
    return (
      <Badge tone="info" title="The filer files this row as a fund interest (asset category OTHER)">
        fund interest
      </Badge>
    );
  return null;
}

/** Distinct firms across funds, largest first by how often they appear. */
function firmOptions(lists: (FirmRef[] | undefined)[]): FirmRef[] {
  const m = new Map<number, { f: FirmRef; n: number }>();
  for (const l of lists) for (const f of l ?? []) m.set(f.id, { f, n: (m.get(f.id)?.n ?? 0) + 1 });
  return [...m.values()].sort((a, b) => b.n - a.n || a.f.name.localeCompare(b.f.name)).map(x => x.f);
}

/**
 * Filter choices from the company's unfiltered holders at the newest date
 * (and the funds that left), so a picker never shrinks to the filter already
 * applied. Cached per refresh like every answer.
 */
export function useFilterOptions(base: string, sq: Record<string, number>) {
  const exp = useApi<Exposure>(`${base}/exposure${qs(sq)}`);
  return useMemo(() => {
    const d = exp.data;
    const all = [...(d?.holdings ?? []), ...(d?.zeroValue ?? []), ...(d?.exited ?? []), ...(d?.inactive ?? [])];
    const positions = (d?.holdings ?? []).flatMap(h => h.positions ?? []);
    return {
      firms: firmOptions(all.map(h => h.firms)),
      classes: [...new Set(positions.map(p => p.classLabel))].sort(),
      indirect: positions.some(p => p.kind !== 'direct'),
      fundName: (k: string) => all.find(h => h.fundKey === k)?.fundLabel ?? undefined,
    };
  }, [exp.data]);
}

/** Pickers that add a firm, class or kind to the scope (the chips in the scope bar remove them). */
export function FilterPickers({ firms, classes, kinds }: { firms?: FirmRef[]; classes?: string[]; kinds?: boolean }) {
  const [scope, setScope] = useScope();
  return (
    <>
      {kinds && !scope.kind && (
        <select
          class="input"
          aria-label="Filter by how it is held"
          value=""
          onChange={e => setScope({ kind: (e.target as HTMLSelectElement).value as 'direct' | 'indirect' })}
        >
          <option value="">+ Held</option>
          <option value="direct">Directly</option>
          <option value="indirect">Indirectly (SPV or fund interest)</option>
        </select>
      )}
      {firms && firms.length > 0 && (
        <select
          class="input"
          aria-label="Filter by firm"
          value=""
          onChange={e => {
            const id = Number((e.target as HTMLSelectElement).value);
            if (id && !scope.firms.includes(id)) setScope({ firms: [...scope.firms, id] });
          }}
        >
          <option value="">+ Firm</option>
          {firms.map(f => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      )}
      {classes && classes.length > 0 && (
        <select
          class="input"
          aria-label="Filter by share class"
          value=""
          onChange={e => {
            const c = (e.target as HTMLSelectElement).value;
            if (c && !scope.classes.includes(c)) setScope({ classes: [...scope.classes, c] });
          }}
        >
          <option value="">+ Class</option>
          {classes.map(c => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      )}
    </>
  );
}

const DAY = 86400000;
export const addDays = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
export const addYears = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + n);
  return d.toISOString().slice(0, 10);
};
