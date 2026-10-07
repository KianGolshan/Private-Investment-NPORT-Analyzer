import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

// The W5 accessibility audit (axe-core, WCAG 2.1 A/AA rules) on the main
// views, in light and dark. Serious and critical findings fail the run;
// the rest are printed for review.

const PAGES = [
  '/',
  '/explore?rows=company',
  '/company/1',
  '/company/1?tab=holders',
  '/company/1?tab=marks',
  '/firm/3',
  '/firms',
  '/activity',
  '/compare?rows=company&key=1&key=5',
  '/tracked',
];

for (const scheme of ['light', 'dark'] as const)
  test.describe(`a11y (${scheme})`, () => {
    test.use({ colorScheme: scheme });
    for (const path of PAGES)
      test(path, async ({ page }) => {
        await page.goto(path);
        await expect(page.locator('h1').first()).toBeVisible();
        await page.waitForLoadState('networkidle');
        const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
        const bad = r.violations.filter(v => v.impact === 'serious' || v.impact === 'critical');
        for (const v of r.violations)
          console.log(
            `${scheme} ${path} ${v.impact} ${v.id}: ${v.nodes.length} node(s), e.g. ${v.nodes[0]?.target.join(' ')}`
          );
        expect(
          bad.map(
            v => `${v.id} (${v.nodes.length}): ${v.nodes[0]?.target.join(' ')} ${v.nodes[0]?.failureSummary ?? ''}`
          )
        ).toEqual([]);
      });
  });
