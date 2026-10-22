import { expect, test } from '@playwright/test';
import { audit, discover, type Ids, settle, watch } from './audit';

// The clicks the route walk (coverage.spec.ts) cannot make by itself:
// search, drill-downs, the watchlist, Compare's picker, the date picker,
// paging, the theme and density toggles and the XLSX export
// (docs/UI-COVERAGE.md, part B). Each ends with the page audit.

let ids: Ids;
let names: { company: string; company2: string };
test.beforeAll(async ({ request }) => {
  ids = await discover(request);
  const top = await request.get('/api/market/top?category=company&limit=5').then(r => r.json());
  names = { company: top.results[0].name, company2: top.results[1]?.name ?? top.results[0].name };
});

test('a date picked on one tab carries to the range views next to it', async ({ page }) => {
  const cases: [string, string][] = [
    ['/?asof=2025-12-31&view=movers', '/api/market/movers'],
    ['/?asof=2025-12-31&view=new', '/api/market/new'],
    ['/sectors?asof=2025-12-31&tab=trends', '/api/analysis/pivot'],
    ['/explore?asof=2025-12-31', '/api/analysis/pivot'],
  ];
  for (const [url, api] of cases) {
    const [res] = await Promise.all([page.waitForResponse(r => r.url().includes(api)), page.goto(url)]);
    expect(new URL(res.url()).searchParams.get('to'), url).toBe('2025-12-31');
  }
  // and Top → Movers by clicking, the way a visitor gets there
  await page.goto('/?asof=2025-12-31');
  await settle(page);
  const [res] = await Promise.all([
    page.waitForResponse(r => r.url().includes('/api/market/movers')),
    page.getByRole('tab', { name: 'Movers' }).click(),
  ]);
  expect(new URL(res.url()).searchParams.get('to')).toBe('2025-12-31');
});

test('the as-of picker sets the date, and Latest clears it', async ({ page }) => {
  const errors = watch(page);
  await page.goto('/firms');
  await settle(page);
  await page.getByRole('button', { name: 'As of: latest' }).click();
  const [res] = await Promise.all([
    page.waitForResponse(r => r.url().includes('/api/firms') && r.url().includes('2025-06-30')),
    page.getByLabel('As of date').fill('2025-06-30'),
  ]);
  expect(res.status()).toBe(200);
  await expect(page).toHaveURL(/asof=2025-06-30/);
  expect(await audit(page, errors)).toEqual([]);
  await page.getByRole('button', { name: 'Latest' }).click();
  await expect(page).not.toHaveURL(/asof=/);
});

test('search opens from the keyboard and Enter goes to the company', async ({ page }) => {
  await page.goto('/firms');
  await settle(page);
  await page.keyboard.press('ControlOrMeta+k');
  const box = page.getByRole('dialog').getByLabel('Search');
  await expect(box).toBeFocused();
  await box.fill(names.company);
  await expect(page.getByRole('dialog').getByRole('option').first()).toContainText(names.company);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/company/${ids.company}\\b`));
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('an Explore cell opens the filings behind it, and they add up to the cell', async ({ page }) => {
  const errors = watch(page);
  await page.goto('/explore?rows=company');
  await settle(page);
  const cell = page.locator('main table .cell-link').filter({ hasText: /\$/ }).first();
  const text = (await cell.textContent())?.trim() ?? '';
  await cell.click();
  const drill = page.locator('main .card').filter({ hasText: 'The legs sum to the cell' });
  await expect(drill).toBeVisible();
  await expect(drill.locator('strong').first()).toHaveText(text);
  expect(await audit(page, errors)).toEqual([]);
  await drill.getByRole('button', { name: 'Close' }).click();
  await expect(drill).toHaveCount(0);
});

test('the watchlist adds and removes a company', async ({ page }) => {
  await page.goto(`/company/${ids.company}`);
  await settle(page);
  const btn = page.getByRole('button', { name: /Watch(ing)?$/ }).first();
  if ((await btn.getAttribute('aria-pressed')) === 'true') await btn.click();
  await btn.click();
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
  await page.goto('/watchlist?view=watchlist');
  await settle(page);
  const row = page.locator('main table tbody tr', { hasText: names.company });
  await expect(row.first()).toBeVisible();
  await page.goto(`/company/${ids.company}`);
  await settle(page);
  await page
    .getByRole('button', { name: /Watch(ing)?$/ })
    .first()
    .click();
  await page.goto('/watchlist?view=watchlist');
  await settle(page);
  await expect(row).toHaveCount(0);
});

test('Compare adds a company from its search, draws both, and removes one', async ({ page }) => {
  const errors = watch(page);
  await page.goto(`/compare?key=${ids.company}`);
  await settle(page);
  await page.getByLabel('Add a company').fill(names.company2.slice(0, 6));
  await page
    .getByRole('button', { name: `+ ${names.company2}` })
    .first()
    .click();
  await expect(page).toHaveURL(new RegExp(`key=${ids.company2}`));
  expect(await audit(page, errors)).toEqual([]);
  await expect(page.locator('main .chart').first()).toBeVisible();
  await page.getByRole('button', { name: `Remove ${names.company2}` }).click();
  await expect(page).not.toHaveURL(new RegExp(`key=${ids.company2}\\b`));
});

test('holders: a row opens the position drawer with its marks chart; Escape closes it', async ({ page }) => {
  const errors = watch(page);
  await page.goto(`/company/${ids.company}?tab=holders`);
  await settle(page);
  await page
    .getByRole('button', { name: /^Position history of / })
    .first()
    .click();
  const drawer = page.getByRole('dialog');
  await expect(drawer).toBeVisible();
  await expect(page).toHaveURL(/pos=/);
  expect(await audit(page, errors)).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
});

test('paging: What’s new moves page by page and keeps the counts', async ({ page }) => {
  await page.goto('/activity?all=1');
  await settle(page);
  const nav = page.getByRole('navigation', { name: 'Pages of changes' });
  test.skip(!(await nav.isVisible()), 'one page of changes in this warehouse');
  const first = await page.locator('main table tbody tr').first().textContent();
  await nav.getByRole('button', { name: 'Next' }).click();
  await expect(page).toHaveURL(/page=2/);
  await settle(page);
  await expect(nav).toContainText('Page 2 of');
  expect(await page.locator('main table tbody tr').first().textContent()).not.toBe(first);
  await nav.getByRole('button', { name: 'Previous' }).click();
  await expect(nav).toContainText('Page 1 of');
});

test('theme and compact rows switch, and every chart redraws without problems', async ({ page }) => {
  const errors = watch(page);
  await page.goto('/sectors?tab=marks');
  await settle(page);
  const theme = page.getByRole('button', { name: /^Theme:/ });
  for (let i = 0; i < 3; i++) {
    await theme.click();
    expect(await audit(page, errors)).toEqual([]);
  }
  const compact = page.getByRole('button', { name: 'Compact rows' });
  const before = await compact.getAttribute('aria-pressed');
  await compact.click();
  await expect(compact).not.toHaveAttribute('aria-pressed', String(before));
  await compact.click();
});

test('XLSX export downloads a workbook', async ({ page }) => {
  await page.goto('/sectors');
  await settle(page);
  const [dl] = await Promise.all([
    page.waitForEvent('download'),
    page
      .getByRole('button', { name: /as XLSX$/ })
      .first()
      .click(),
  ]);
  expect(dl.suggestedFilename()).toMatch(/\.xlsx$/);
  const path = await dl.path();
  const { statSync, readFileSync } = await import('node:fs');
  expect(statSync(path).size).toBeGreaterThan(1000);
  expect(readFileSync(path).subarray(0, 2).toString()).toBe('PK'); // a zip, as every .xlsx is
});

test('a sector page dates its index from where it is 100, and has no band in the chart', async ({ page, request }) => {
  const errors = watch(page);
  for (const [level, key] of [
    ['sector', ids.sector],
    ['industry', ids.industry],
    ['theme', ids.theme],
  ]) {
    const idx = await request.get(`/api/sectors/index?level=${level}&keys=${key}`).then(r => r.json());
    const base = idx.groups[0]?.points.find((p: { index: number | null }) => p.index != null);
    await page.goto(`/sectors/${level}/${key}`);
    await settle(page);
    if (base) {
      const when = new Date(`${base.date}T00:00:00Z`).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        timeZone: 'UTC',
      });
      await expect(page.locator('.kpis')).toContainText(`since ${when}`);
    }
    if (!(await page.locator('main .chart').count())) {
      await expect(page.locator('main')).toContainText('No index to draw');
      expect(await audit(page, errors)).toEqual([]);
      continue;
    }
    const names = await page
      .locator('main .chart')
      .first()
      .evaluate(el =>
        (
          (el as HTMLElement & { __chart: { getOption(): { series: { name: string }[] } } }).__chart.getOption()
            .series ?? []
        ).map(s => s.name)
      );
    expect(names.some(n => /percentile/.test(n))).toBe(false);
    expect(await audit(page, errors)).toEqual([]);
  }
});
