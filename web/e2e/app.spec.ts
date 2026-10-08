import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

// The analyst workspace in a real browser (P6c R3; staff review F01, F02, F09,
// F13, F17, F18), on the golden warehouse. The tests run in order: the last
// ones rename a company through a real warehouse job.

const HERE = dirname(fileURLToPath(import.meta.url));
const ANTHROPIC = 1;
const HOSTILE = '=HYPERLINK("http://x")<img src=x onerror="window.__xss=1">Anthropic';

const errorsOf = (page: Page) => {
  const errors: string[] = [];
  page.on('console', m => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', e => errors.push(String(e)));
  return errors;
};

test.describe.configure({ mode: 'serial' });

// The renamed company the last tests read; renamed here if a test runs alone.
async function ensureRenamed(page: Page) {
  const c = await page.request.get(`/api/companies/${ANTHROPIC}`).then(r => r.json());
  if (c.company?.name !== HOSTILE && c.name !== HOSTILE)
    execFileSync(process.execPath, [join(HERE, 'rename.cjs'), String(ANTHROPIC), HOSTILE], { stdio: 'pipe' });
}

test('the workspace is served with a strict script policy and its main routes load without errors (F01)', async ({
  page,
}) => {
  const errors = errorsOf(page);
  const res = await page.goto('/');
  expect(res?.headers()['content-security-policy']).toMatch(/script-src 'self';/);
  for (const path of ['/', '/explore?rows=company', `/company/${ANTHROPIC}`, '/firms', '/activity', '/tracked']) {
    await page.goto(path);
    await expect(page.locator('h1').first()).toBeVisible();
  }
  const legacy = await page.request.get('/legacy');
  expect(legacy.headers()['content-security-policy']).toMatch(/'unsafe-inline'/);
  expect(errors).toEqual([]);
});

// P9 W2: what a link crawler and a visitor get on the public site's pages.
test('each page has its own title, description and Open Graph tags; unknown pages and ids are 404s with the app', async ({
  page,
}) => {
  const errors = errorsOf(page);
  const html = await (await page.request.get(`/company/${ANTHROPIC}-anthropic`)).text();
  expect(html).toMatch(/<title>[^<]+: fund holdings and marks · Vantage<\/title>/);
  expect(html).toMatch(/<meta property="og:image" content="http:\/\/127\.0\.0\.1:\d+\/og\.png" \/>/);
  expect(html.match(/<title>/g)).toHaveLength(1);
  expect((await page.request.get('/og.png')).headers()['content-type']).toBe('image/png');
  for (const path of ['/no-such-page', '/company/424242', '/fund/NO-SUCH-FUND']) {
    const res = await page.goto(path);
    expect(res?.status(), path).toBe(404);
    expect(await res?.text()).toContain('<meta name="robots" content="noindex" />');
  }
  await page.goto('/no-such-page');
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  expect((await page.request.get('/assets/missing.js')).status()).toBe(404);
  const robots = await (await page.request.get('/robots.txt')).text();
  expect(robots).toContain('Sitemap: http://127.0.0.1');
  const sitemap = await (await page.request.get('/sitemap.xml')).text();
  expect(sitemap).toMatch(/<loc>http:\/\/127\.0\.0\.1:\d+\/company\/\d+-[a-z0-9-]+<\/loc>/);
  expect(errors.filter(e => !/404/.test(e))).toEqual([]);
});

test('About and Status read the warehouse; the nav links them', async ({ page }) => {
  const errors = errorsOf(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Main' }).first().getByRole('link', { name: 'About the data' }).click();
  await expect(page.getByRole('heading', { name: 'About the data and methodology' })).toBeVisible();
  await expect(page.getByText(/N-PORT filings from [\d,]+ funds/)).toBeVisible();
  await expect(page.locator('main strong', { hasText: 'not investment advice' })).toBeVisible();
  await page.goto('/status');
  await expect(page.getByRole('heading', { name: 'Data status' })).toBeVisible();
  await expect(page.getByText('Filings through', { exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: /[\d,]+ private, [\d,]+ tracked/ })).toBeVisible();
  expect(errors).toEqual([]);
});

test('an open tab offers a reload when the server is deployed again', async ({ page }) => {
  await page.goto('/firms');
  await expect(page.locator('h1').first()).toBeVisible();
  await page.route('**/api/config', r => r.fulfill({ json: { public: false, build: 'a-newer-build' } }));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByText('A new version of Vantage is available.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reload' })).toBeVisible();
});

test('a failed search says so and can be retried; it is never "no match" (F13)', async ({ page }) => {
  await page.goto('/firms');
  await page.route('**/api/search?*', r => r.fulfill({ status: 503, json: { error: 'warehouse is busy' } }));
  await page.getByRole('button', { name: 'Search (⌘K)' }).click();
  await page.getByRole('dialog').getByLabel('Search', { exact: true }).fill('stripe');
  await expect(page.getByRole('alert')).toContainText('Search failed (warehouse is busy)');
  await expect(page.getByText(/matches “stripe”/)).toHaveCount(0);
  await page.unroute('**/api/search?*');
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByRole('option').filter({ hasText: 'Stripe' }).first()).toBeVisible();
});

test('the position drawer takes focus, closes on Escape and draws one mark line per class (F15, F18)', async ({
  page,
}) => {
  await page.goto(`/company/${ANTHROPIC}?pos=S000006037`);
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close position history' })).toBeFocused();
  const chart = dialog.locator('.chart');
  await expect(chart).toHaveAttribute('aria-label', /Series E per share/);
  expect((await chart.boundingBox())!.height).toBeGreaterThan(200);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('dialogs keep focus and give it back; clickable rows open from the keyboard (F18)', async ({ page }) => {
  await page.goto('/firms');
  const trigger = page.getByRole('button', { name: 'Search (⌘K)' });
  await trigger.click();
  const palette = page.getByRole('dialog');
  await expect(palette.getByLabel('Search', { exact: true })).toBeFocused();
  for (let i = 0; i < 6; i++) await page.keyboard.press('Tab');
  expect(await palette.evaluate(el => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(palette).toHaveCount(0);
  await expect(trigger).toBeFocused();
  // a holder row opens its position history from the keyboard; Escape gives focus back to the row
  await page.goto(`/company/${ANTHROPIC}?tab=holders`);
  const row = page.locator('tbody tr[tabindex="0"]').first();
  await row.focus();
  await page.keyboard.press('Enter');
  const drawer = page.getByRole('dialog');
  await expect(drawer).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close position history' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  expect(await drawer.evaluate(el => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  await expect(row).toBeFocused();
});

test('a session left open sees a newly published generation without a reload (F02)', async ({ page }) => {
  await page.goto(`/company/${ANTHROPIC}`);
  await expect(page.locator('h1')).toHaveText('Anthropic');
  const before = await page.evaluate(() => fetch('/api/freshness').then(r => r.json()));
  execFileSync(process.execPath, [join(HERE, 'rename.cjs'), String(ANTHROPIC), HOSTILE], { stdio: 'pipe' });
  // the tab regains focus: the app re-checks the generation and every view refetches
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('h1')).toHaveText(HOSTILE);
  const after = await page.evaluate(() => fetch('/api/freshness').then(r => r.json()));
  expect(after.refreshId).toBeGreaterThan(before.refreshId);
  expect(await page.locator('h1 img').count()).toBe(0);
});

test('a filing-derived name in a chart tooltip is inert text (F01)', async ({ page }) => {
  const errors = errorsOf(page);
  await ensureRenamed(page);
  await page.goto('/explore?rows=company&n=10');
  const chart = page.locator('.chart').first();
  await expect(chart).toBeVisible();
  const box = (await chart.boundingBox())!;
  let html = '';
  // sweep the heatmap until the renamed company's tooltip shows
  for (let y = box.y + 10; y < box.y + box.height && !html.includes('HYPERLINK'); y += 12)
    for (let x = box.x + box.width * 0.4; x < box.x + box.width - 10 && !html.includes('HYPERLINK'); x += 40) {
      await page.mouse.move(x, y);
      html = await chart.evaluate(el => {
        const tip = [...el.querySelectorAll('div')].find(d => d.innerHTML.includes('<br'));
        return tip ? tip.innerHTML : '';
      });
    }
  expect(html).toContain('HYPERLINK');
  expect(html).toContain('&lt;img');
  expect(await chart.locator('img').count()).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  expect(errors).toEqual([]);
});

test('a CSV export opens a formula-like name as text and says how it reads history (F09, F14)', async ({ page }) => {
  await ensureRenamed(page);
  await page.goto('/');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'CSV' }).first().click(),
  ]);
  const csv = readFileSync((await download.path())!, 'utf8');
  const [header, ...rows] = csv.trim().split('\n');
  expect(header).toContain('Basis');
  const row = rows.find(r => r.includes('HYPERLINK'));
  expect(row, 'the renamed company is in the top list').toBeTruthy();
  // the cell starts with an apostrophe inside its quotes: text, not a formula
  expect(row).toContain(`"'=HYPERLINK(""http://x"")`);
  expect(row).not.toMatch(/(^|,)=HYPERLINK/);
});
