import type { Classification } from '../api/types';
import { sectorPath } from '../lib/format';
import { Badge } from './bits';

// A company's sector, industry and themes (ADR 0010), each a link to its
// sector page. These are reviewed labels, not facts the filings report: the
// title says so, and a "not yet classified" decision is shown as such.
export function ClassificationBadges({ c }: { c: Classification | null | undefined }) {
  if (!c) return null;
  const note = `Vantage's classification (taxonomy ${c.taxonomyVersion}); N-PORT filings have no industry field`;
  if (!c.industry)
    return (
      <Badge tone="warn" title={note}>
        Not yet classified
      </Badge>
    );
  return (
    <>
      <a href={sectorPath('industry', c.industry.code)} title={note} class="badge-link">
        <Badge tone="info">
          {c.sector ? `${c.sector.name} · ` : ''}
          {c.industry.name}
        </Badge>
      </a>
      {c.themes.map(t => (
        <a key={t.code} href={sectorPath('theme', t.code)} title={`Theme: ${t.name}. ${note}`} class="badge-link">
          <Badge>{t.name}</Badge>
        </a>
      ))}
    </>
  );
}
