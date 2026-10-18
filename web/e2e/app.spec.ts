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
  expect((await page.request.get('/legacy')).status()).toBe(404); // v1 removed (git tag v1-archive)
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

// Copy and UX review 2026-10-15, W1: dates that say what they mean, ranks with no
// gaps, and a tab title that follows the page.
test('freshness names the newest mark, Market ranks 1..n, and the tab title follows the page', async ({ page }) => {
  const errors = errorsOf(page);
  const f = await page.request.get('/api/freshness').then(r => r.json());
  expect(f.newestPrivateMark <= f.newestReportDate).toBe(true);
  await page.goto('/');
  const chip = page.locator('.topbar').getByText(/^Filings to /);
  await expect(chip).toContainText('newest mark');
  await expect(chip).not.toContainText('marks to');
  await expect(page.getByText('Data as of', { exact: true })).toBeVisible();
  await expect(page.getByText(/newest mark [A-Z][a-z]{2} \d{1,2}, \d{4}/).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Operating companies' })).toBeVisible();
  const ranks = await page.evaluate(() => {
    const table = [...document.querySelectorAll('table')].find(t =>
      t.querySelector('th')?.textContent?.trim().startsWith('#')
    );
    return [...(table?.querySelectorAll('tbody tr') ?? [])]
      .slice(0, 30)
      .map(r => r.querySelector('td')?.textContent?.trim());
  });
  // the golden warehouse holds a handful of operating companies: every one is listed, ranked 1..n
  const top = await page.request.get('/api/market/top?category=company&limit=300').then(r => r.json());
  expect(top.companies).toBeGreaterThan(1);
  expect(ranks.length).toBe(Math.min(30, top.companies));
  expect(ranks).toEqual(ranks.map((_, i) => String(i + 1)));
  await expect(page).toHaveTitle('Vantage: private-company holdings and marks from SEC fund filings');
  await page.getByRole('navigation', { name: 'Main' }).first().getByRole('link', { name: 'Firms' }).click();
  await expect(page).toHaveTitle('Firms by private value · Vantage');
  await page.goto(`/firm/9`);
  await expect(page).toHaveTitle(/: private-company book · Vantage$/);
  await page.goto('/status');
  await expect(page.getByText('Newest mark', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

// Copy and UX review 2026-10-15, W2: navigation and names.
test('the nav starts at Market, the watchlist never opens empty, and old links still land', async ({ page }) => {
  const errors = errorsOf(page);
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Main' }).first();
  await expect(nav.getByRole('link')).toHaveText([
    'Market',
    'Firms',
    "What's new",
    'Explore',
    'Compare',
    'Watchlist',
    'About',
    'Status',
  ]);
  // a first visit (empty watchlist) opens on the tracked companies, with what "tracked" means
  await nav.getByRole('link', { name: 'Watchlist' }).click();
  await expect(page).toHaveURL(/\/watchlist$/);
  await expect(page.getByRole('heading', { name: 'Watchlist and tracked companies' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Tracked companies' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText(/Tracked companies are [\d,]+ private companies picked by hand/)).toBeVisible();
  await expect(page.getByText('Your watchlist is empty.', { exact: false })).toHaveCount(0);
  // the old address redirects with its query
  const res = await page.goto('/tracked?view=watchlist');
  expect(res?.url()).toMatch(/\/watchlist\?view=watchlist$/);
  await expect(page.getByText('Your watchlist is empty.', { exact: false })).toBeVisible();
  // old tab ids open the renamed tabs
  await page.goto('/fund/S000009228?tab=xray');
  await expect(page.getByRole('tab', { name: 'Private book' })).toHaveAttribute('aria-selected', 'true');
  await page.goto(`/company/${ANTHROPIC}?tab=positions`);
  await expect(page.getByRole('tab', { name: 'Over time' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('link', { name: 'Follow (RSS)' })).toHaveAttribute('rel', /noopener/);
  // the date control says what it shows by default
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'As of: latest' })).toBeVisible();
  await expect(page.getByLabel('As of date')).toHaveCount(0);
  // Activity says its default scope
  await page.goto('/activity');
  await expect(page.getByRole('button', { name: 'Tracked companies' })).toHaveAttribute('aria-pressed', 'true');
  expect(errors).toEqual([]);
});

// Copy and UX review 2026-10-15, W3: words defined in place, one position definition, plain Status.
test('terms open their definition, the change tables use one wording, and Status keeps internals folded', async ({
  page,
}) => {
  const errors = errorsOf(page);
  await page.goto('/');
  // the first Tab reaches the skip link
  await page.keyboard.press('Tab');
  await expect(page.locator(':focus')).toHaveText('Skip to content');
  const term = page.getByRole('button', { name: 'N-PORT' });
  await term.click();
  await expect(page.getByRole('note')).toContainText('holdings report SEC-registered funds');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('note')).toHaveCount(0);
  await page.goto(`/company/${ANTHROPIC}`);
  for (const h of ['From positions', 'From marks', 'Other changes'])
    await expect(page.getByRole('columnheader', { name: h })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: /Position Δ|Mark Δ/ })).toHaveCount(0);
  await page.goto(`/company/${ANTHROPIC}?tab=changes`);
  await expect(page.getByText('From positions', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/the steps add up exactly to the closing value/)).toBeVisible();
  await page.goto('/status');
  const tech = page.locator('details', { hasText: 'Technical details' });
  await expect(tech).toBeVisible();
  await expect(tech).not.toHaveAttribute('open', '');
  await expect(page.getByText(/sha256/)).toBeHidden();
  expect(errors).toEqual([]);
});

// Copy and UX review 2026-10-15, W4: positioning, About, the author line, phones.
test('Market says what Vantage is with live numbers, About and the footer credit the author, phones fit', async ({
  page,
}) => {
  const errors = errorsOf(page);
  await page.goto('/');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Private-company holdings and marks, straight from SEC fund filings' })
  ).toBeVisible();
  // the summary line is the API's answer, never a number written into the copy
  const top = await page.request.get('/api/market/top?limit=300&category=company').then(r => r.json());
  const proof = page.locator('.proof');
  await expect(proof).toContainText(
    `${top.companies.toLocaleString('en-US')} private companies held by registered funds`
  );
  await expect(proof).toContainText('Refreshed every night from SEC EDGAR');
  // the footer credit: his site and LinkedIn, opening safely in a new tab
  const foot = page.locator('footer.site-foot');
  for (const [name, href] of <[string, string][]>[
    ["Kian Golshan's website", 'https://kiangolshan.com'],
    ['Kian Golshan on LinkedIn', 'https://www.linkedin.com/in/kian-golshan-058b32144/'],
    ['Source code on GitHub', 'https://github.com/KianGolshan/Private-Investment-NPORT-Analyzer'],
  ]) {
    const a = foot.getByRole('link', { name });
    await expect(a).toHaveAttribute('href', href);
    await expect(a).toHaveAttribute('rel', /noopener/);
    await expect(a).toHaveAttribute('target', '_blank');
  }
  await page.goto('/about');
  await expect(page.getByRole('heading', { name: 'About Vantage' })).toBeVisible();
  for (const h of ['What it is', 'Questions it answers', 'Sources and method', 'Words used on this site', 'Author'])
    await expect(page.getByRole('heading', { level: 2, name: h })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Kian Golshan on LinkedIn' })).toHaveAttribute('rel', /noopener/);
  await expect(page.getByRole('link', { name: 'Who holds Anthropic, and at what mark?' })).toHaveAttribute(
    'href',
    '/company/1-anthropic?tab=holders'
  );
  await expect(page.locator('#term-fromPositions dt')).toHaveText('From positions');
  // phones: the freshness line shows, nothing scrolls sideways
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/');
  await expect(page.locator('.fresh-sm')).toBeVisible();
  await expect(page.locator('.fresh-sm')).toContainText('newest mark');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await page.goto(`/company/${ANTHROPIC}`);
  await expect(page.getByRole('tab', { name: 'Overview' })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await page.setViewportSize({ width: 1280, height: 800 });
  expect(errors).toEqual([]);
});

test('About and Status read the warehouse; the nav links them', async ({ page }) => {
  const errors = errorsOf(page);
  await page.goto('/');
  await page
    .getByRole('navigation', { name: 'Main' })
    .first()
    .getByRole('link', { name: 'About', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'About Vantage' })).toBeVisible();
  await expect(page.getByText(/N-PORT filings from [\d,]+ funds/)).toBeVisible();
  await expect(page.locator('main strong', { hasText: 'not investment advice' })).toBeVisible();
  await page.goto('/status');
  await expect(page.getByRole('heading', { name: 'Data status' })).toBeVisible();
  await expect(page.getByText('Filings through', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('cell', {
      name: /[\d,]+ private companies, [\d,]+ tracked; plus [\d,]+ fund interests, [\d,]+ CLOs and [\d,]+ insurance vehicles/,
    })
  ).toBeVisible();
  // the last scheduled checks (review F-06): a fresh warehouse has none yet
  await expect(page.getByRole('row', { name: /Monthly EDGAR check/ })).toBeVisible();
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
  await page.getByRole('button', { name: /Search companies, funds, firms/ }).click();
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
  const trigger = page.getByRole('button', { name: /Search companies, funds, firms/ });
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
