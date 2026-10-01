import { describe, expect, it } from 'vitest';
import { byKind, hitToItem, type PaletteItem } from '../src/ui/CommandPalette';

const item = (kind: PaletteItem['kind'], title: string, tier: number): PaletteItem => ({
  kind,
  title,
  tier,
  detail: '',
  href: `/${kind}/${title}`,
});

describe('search ranking', () => {
  it('an exact firm beats prefix-matched unreviewed names; kind breaks ties', () => {
    const ranked = byKind([
      item('Name', 'Fidelity Private Credit Central Fund LLC', 1),
      item('Fund', 'Fidelity Contrafund', 1),
      item('Firm', 'Fidelity', 0),
      item('Company', 'Fidelity Something', 1),
    ]);
    expect(ranked.map(r => r.kind)).toEqual(['Firm', 'Company', 'Name', 'Fund']);
  });
  it('a codename alias resolves to its company with the alias as the reason', () => {
    const it = hitToItem({
      type: 'company',
      id: 2,
      name: 'Databricks',
      status: 'private',
      match: { how: 'exact', via: 'alias', text: 'PROJECT DEBUSSY' },
      strong: true,
    });
    expect(it.href).toBe('/company/2-databricks');
    expect(it.tier).toBe(0);
    expect(it.detail).toContain('PROJECT DEBUSSY');
  });
});
