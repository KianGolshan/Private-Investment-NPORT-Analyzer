import { longDate } from '../lib/format';
import { useParam } from '../scope/scope';
import { Segmented } from './bits';

// "As of" a past date counts each fund's latest report on or before it, even a
// report filed later: at 2026-06-30, $53.8B of $62.2B came from filings made
// after that day (review 2026-10-18 #2). ?known=1 counts only the filings made
// by the as-of date ("what was public then"; the API's ?known=1, the same rule
// as a company's knownAsOf). Only for a past as-of date: at the newest date
// every filing so far is all there is.

/** The ?known= switch; `on` only when an as-of date is picked. */
export function useKnown(asof: string | null | undefined): { on: boolean; set: (on: boolean) => void } {
  const [known, setKnown] = useParam('known');
  return { on: !!asof && known === '1', set: v => setKnown(v ? '1' : '') };
}

export function KnownSwitch({ asof }: { asof: string | null | undefined }) {
  const k = useKnown(asof);
  if (!asof) return null;
  return (
    <Segmented
      label="Which reports count"
      options={[
        {
          id: 'all',
          label: 'All reports',
          title: 'Every report for a date on or before this one, whenever it was filed',
        },
        {
          id: 'known',
          label: `Filed by ${longDate(asof)}`,
          title: 'Only reports filed with the SEC on or before this date: what was public then',
        },
      ]}
      value={k.on ? 'known' : 'all'}
      onChange={v => k.set(v === 'known')}
    />
  );
}

/** The sentence that says which reports an as-of answer counts. */
export function knownNote(asof: string | null | undefined, on: boolean): string {
  if (!asof) return 'Each fund counts with its newest report.';
  return on
    ? `Only reports filed with the SEC by ${longDate(asof)} count: what was public that day.`
    : `Reports filed after ${longDate(asof)} still count when they report a date on or before it.`;
}
