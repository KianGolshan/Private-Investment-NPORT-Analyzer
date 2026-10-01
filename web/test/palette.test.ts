import { describe, expect, it } from 'vitest';
import { byKind, hitToItem, unifiedToItem, type PaletteItem } from '../src/ui/CommandPalette';

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

describe('unified search', () => {
  it('keeps the server ranking and links a class to its company page filtered to it', () => {
    const items = [
      {
        type: 'class' as const,
        companyId: 1,
        company: 'Anthropic',
        classLabel: 'Series G',
        name: 'Anthropic · Series G',
        strong: true,
        evidence: { currentFunds: 41, currentValueUsd: 879e6, asOf: '2026-07-31' },
      },
      {
        type: 'company' as const,
        id: 1,
        name: 'Anthropic',
        match: { how: 'normalized', via: 'name', text: 'ANTHROPIC' },
        strong: false,
      },
    ].map(unifiedToItem);
    expect(byKind(items).map(i => i.kind)).toEqual(['Class', 'Company']);
    expect(items[0]!.href).toBe('/company/1-anthropic?class=Series+G');
    expect(items[0]!.strong).toBe(true);
  });
  it('labels an unreviewed name as unreviewed', () => {
    const it = unifiedToItem(
      { type: 'unreviewed', key: 'RIPPLE', name: 'Ripple Labs', match: { how: 'prefix', via: 'name', text: 'RIPPLE' } },
      0
    );
    expect(it.kind).toBe('Name');
    expect(it.href).toBe('/name/RIPPLE');
    expect(it.detail).toContain('unreviewed');
  });
});
