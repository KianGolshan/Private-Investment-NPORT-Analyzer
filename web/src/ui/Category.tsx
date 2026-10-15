import type { CompanyCategory } from '../api/types';
import { useParam } from '../scope/scope';
import { Badge, Segmented } from './bits';

// What a reviewed company is (migration 0022, review F-03). Funds report
// private-equity fund stakes, co-investment vehicles, CLO notes and reinsurance
// sidecars beside operating companies, and all of them are private. Market's
// views list operating companies by default; ?show=all includes the rest.

export const CATEGORY_LABEL: Record<CompanyCategory, string> = {
  company: 'Operating company',
  fund: 'Fund interest',
  clo: 'CLO',
  insurance: 'Insurance vehicle',
};

const CATEGORY_TITLE: Record<CompanyCategory, string> = {
  company: 'An operating company, or the holding company of one',
  fund: 'An interest in a private fund, co-investment or continuation vehicle, or a named SPV',
  clo: "A collateralized loan obligation's notes or equity",
  insurance: 'A reinsurance sidecar, segregated account or catastrophe vehicle',
};

/** A badge for anything that is not an operating company; nothing for a company. */
export function CategoryBadge({ category }: { category?: CompanyCategory | null }) {
  if (!category || category === 'company') return null;
  return (
    <Badge tone="info" title={CATEGORY_TITLE[category]}>
      {CATEGORY_LABEL[category]}
    </Badge>
  );
}

/** The ?show= switch: operating companies (default) or every private holding. */
export function useCategoryFilter(): { all: boolean; category: string | undefined; set: (all: boolean) => void } {
  const [show, setShow] = useParam('show');
  const all = show === 'all';
  return { all, category: all ? undefined : 'company', set: v => setShow(v ? 'all' : '') };
}

export function CategorySwitch() {
  const f = useCategoryFilter();
  return (
    <Segmented
      label="Which private holdings"
      options={[
        { id: 'company', label: 'Operating companies' },
        { id: 'all', label: 'All private holdings' },
      ]}
      value={f.all ? 'all' : 'company'}
      onChange={v => f.set(v === 'all')}
    />
  );
}
