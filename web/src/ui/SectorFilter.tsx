import { useApi } from '../api/client';
import type { RowLabels, SectorLevel, TaxonomyAnswer } from '../api/types';
import { sectorPath } from '../lib/format';
import { useParam, useSetParams } from '../scope/scope';

// One sector, industry or theme to narrow a list (Market, movers, newly
// reported): ?sector=tech, ?industry=hc.biotech or ?theme=ai, one at a time
// (ADR 0010). The URL holds it, so a filtered view can be shared.
export function useSectorFilter() {
  const [sector] = useParam('sector');
  const [industry] = useParam('industry');
  const [theme] = useParam('theme');
  const level: SectorLevel | null = sector ? 'sector' : industry ? 'industry' : theme ? 'theme' : null;
  const key = sector || industry || theme || '';
  return {
    level,
    key,
    /** the API params: pass through qs() */
    params: level ? { [level]: key } : {},
  };
}

export function SectorFilter() {
  const t = useApi<TaxonomyAnswer>('/api/sectors/taxonomy');
  const f = useSectorFilter();
  const setParams = useSetParams();
  if (!t.data?.version) return null;
  const value = f.level ? `${f.level}:${f.key}` : '';
  return (
    <select
      class="input"
      aria-label="Sector, industry or theme"
      value={value}
      onChange={e => {
        const [level, key] = (e.target as HTMLSelectElement).value.split(':');
        setParams({ sector: '', industry: '', theme: '', ...(level && key ? { [level]: key } : {}) });
      }}
    >
      <option value="">All sectors</option>
      <optgroup label="Sectors">
        {t.data.sectors.map(s => (
          <option key={s.code} value={`sector:${s.code}`}>
            {s.name}
          </option>
        ))}
      </optgroup>
      {t.data.sectors.map(s => (
        <optgroup key={s.code} label={`${s.name}: industries`}>
          {s.industries.map(i => (
            <option key={i.code} value={`industry:${i.code}`}>
              {i.name}
            </option>
          ))}
        </optgroup>
      ))}
      <optgroup label="Themes">
        {t.data.themes.map(th => (
          <option key={th.code} value={`theme:${th.code}`}>
            {th.name}
          </option>
        ))}
      </optgroup>
    </select>
  );
}

/** An "Industry" table column (value, cell link and export). */
export function industryColumn<T extends RowLabels>() {
  return {
    id: 'industry',
    header: 'Industry',
    title: "Vantage's label: N-PORT filings have no industry field",
    value: (r: T) => r.industryLabel ?? null,
    render: (r: T) =>
      r.industry ? (
        <a href={sectorPath('industry', r.industry)} class="small">
          {r.industryLabel}
        </a>
      ) : (
        <span class="muted small">—</span>
      ),
    exportAs: [
      { header: 'Sector code', value: (r: T) => r.sector ?? '' },
      { header: 'Themes', value: (r: T) => (r.themes ?? []).join('|') },
    ],
    wrap: true,
  };
}
