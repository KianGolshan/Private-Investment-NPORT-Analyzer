/* eslint-disable @typescript-eslint/no-explicit-any -- ECharts options are read back as plain data */
import { expect, test, type Page } from '@playwright/test';
import { audit, chartProblems, discover, type Ids, settle, watch } from './audit';

// Every route, tab and control in the workspace (docs/UI-COVERAGE.md). Each
// page is opened, then every tab and every segmented control on it is
// clicked in turn; after each step the page and its charts are audited
// (e2e/audit.ts). Sorting, exports and the chart-versus-table checks follow.
// Runs on the golden warehouse in CI; `E2E_BASE_URL=http://localhost:3000`
// runs it against a server over the full warehouse.

test.setTimeout(180_000);

let ids: Ids;
test.beforeAll(async ({ request }) => {
  ids = await discover(request);
});

// Routes as templates: {company}, {fund} and the rest are filled from the
// warehouse the server reads (audit.ts discover).
const ROUTES = [
  '/',
  '/?show=all',
  '/?view=movers',
  '/?view=movers&tracked=1',
  '/?view=new',
  '/?sector={sector}',
  '/?industry={industry}',
  '/?theme={theme}',
  '/?asof=2025-12-31',
  '/company/{company}',
  '/company/{company}?pos={fund}',
  '/company/{company}?asof=2025-06-30',
  '/name/{entity}',
  '/firms',
  '/firms?asof=2025-06-30',
  '/firm/{firm}',
  '/fund/{fund}',
  '/activity',
  '/activity?all=1',
  '/explore',
  '/explore?rows=company&from=2024-06-30&to=2026-06-30',
  '/sectors',
  '/sectors?level=industry',
  '/sectors?level=theme',
  '/sectors?tab=trends&from=2023-01-01&to=2026-06-30',
  '/sectors?tab=marks&from=2020-01-01&to=2026-06-30',
  '/sectors/sector/{sector}',
  '/sectors/industry/{industry}',
  '/sectors/theme/{theme}',
  '/sectors/theme/{theme}?from=2021-01-01&to=2026-06-30',
  '/compare',
  '/compare?key={company}&key={company2}',
  '/compare?rows=firm&key={firm}',
  '/compare?rows=fund&key={fund}',
  '/watchlist',
  '/watchlist?view=watchlist',
  '/about',
  '/status',
];
const fill = (route: string) =>
  route.replace(/\{(\w+)\}/g, (_, k: keyof Ids) => encodeURIComponent(String(ids[k] ?? '')));

type Step = { where: string; problems: string[] };

/** Clicks every tab, then every option of every segmented control under it, auditing each state. */
async function walk(page: Page, url: string, errors: string[]): Promise<Step[]> {
  const steps: Step[] = [];
  const check = async (where: string) => steps.push({ where, problems: await audit(page, errors) });
  await page.goto(url);
  await check(url);
  if (await page.locator('.overlay').isVisible()) {
    await page.keyboard.press('Escape'); // a drawer opened by the URL (?pos=)
    await expect(page.locator('.overlay')).toHaveCount(0);
  }
  const tabs = await page.locator('main [role="tab"]').allTextContents();
  for (const tab of tabs.length ? tabs : [null]) {
    if (tab) {
      await page.locator('main [role="tab"]', { hasText: tab }).first().click();
      await check(`${url} › ${tab}`);
    }
    const groups = await page
      .locator('main .seg[role="group"]')
      .evaluateAll(gs =>
        gs.map(g => ({ label: g.getAttribute('aria-label') ?? '', n: g.querySelectorAll('button').length }))
      );
    for (const g of groups) {
      const group = page.locator(`main .seg[role="group"][aria-label="${g.label}"]`).first();
      const start = await group
        .locator('button')
        .evaluateAll(bs => bs.findIndex(b => b.getAttribute('aria-pressed') === 'true'));
      for (let k = 0; k < g.n; k++) {
        const btn = group.locator('button').nth(k);
        if (!(await btn.isVisible())) break; // an earlier option hid this control
        if ((await btn.getAttribute('aria-pressed', { timeout: 5_000 })) === 'true') continue;
        const name = (await btn.textContent())?.trim();
        await btn.click({ timeout: 5_000 });
        await check(`${url} › ${tab ?? ''} › ${g.label}: ${name}`);
      }
      // back to where it started, so the next control is walked from the page's default
      if (start >= 0 && (await group.isVisible())) await group.locator('button').nth(start).click({ timeout: 5_000 });
    }
    // drop-downs: every option of a short list, the first few and the last of a long one
    const selects = await page.locator('main select').evaluateAll(ss =>
      ss.map(sel => ({
        label: sel.getAttribute('aria-label') ?? '',
        values: [...(sel as HTMLSelectElement).options].map(o => o.value),
        start: (sel as HTMLSelectElement).value,
      }))
    );
    for (const sel of selects) {
      const box = page.locator(`main select[aria-label="${sel.label}"]`).first();
      const pick = sel.values.length > 8 ? [...sel.values.slice(0, 5), sel.values[sel.values.length - 1]] : sel.values;
      for (const v of pick) {
        if (v === sel.start || !(await box.isVisible())) continue;
        await box.selectOption(v ?? '', { timeout: 5_000 });
        await check(`${url} › ${tab ?? ''} › ${sel.label}: ${v || '(none)'}`);
      }
      if (await box.isVisible()) await box.selectOption(sel.start, { timeout: 5_000 });
    }
    // switches: each on and back
    const boxes = await page.locator('main input[type="checkbox"]').count();
    for (let k = 0; k < boxes; k++) {
      const cb = page.locator('main input[type="checkbox"]').nth(k);
      if (!(await cb.isVisible())) continue;
      const name =
        (await cb.getAttribute('aria-label')) ?? (await cb.evaluate(e => e.closest('label')?.textContent ?? ''));
      await cb.click({ timeout: 5_000 });
      await check(`${url} › ${tab ?? ''} › switch ${name.trim()}`);
      if (await cb.isVisible()) await cb.click({ timeout: 5_000 });
    }
  }
  return steps;
}

for (const route of ROUTES)
  test(`${route}: every tab and control renders without errors, odd text or broken charts`, async ({ page }) => {
    test.skip(route.includes('{entity}') && !ids.entity, 'no unreviewed name in this warehouse');
    const errors = watch(page);
    const bad: string[] = [];
    const steps = await walk(page, fill(route), errors);
    for (const s of steps) for (const p of s.problems) bad.push(`${s.where}: ${p}`);
    test.info().annotations.push({ type: 'states', description: steps.map(s => s.where).join('\n') });
    console.log(`${route}: ${steps.length} states`);
    expect(bad).toEqual([]);
  });

test('every route fits a phone without sideways scrolling', async ({ page }) => {
  const errors = watch(page);
  await page.setViewportSize({ width: 375, height: 800 });
  const bad: string[] = [];
  for (const route of ROUTES) {
    if (route.includes('{entity}') && !ids.entity) continue;
    await page.goto(fill(route));
    for (const p of await audit(page, errors)) bad.push(`${route}: ${p}`);
  }
  expect(bad).toEqual([]);
});

/** The numbers in one column of a table's visible body. */
const columnNumbers = (page: Page, table: number, col: number) =>
  page
    .locator('main table')
    .nth(table)
    .evaluate((t, c) => {
      const read = (s: string) => {
        const m = /([−-])?\$?([\d,.]+)\s*([KMBT]?)/.exec(s.replace(/−/g, '−'));
        if (!m) return null;
        const unit: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };
        const n = Number((m[2] ?? '').replace(/,/g, '')) * (unit[m[3] ?? ''] ?? 1);
        return m[1] ? -n : n;
      };
      return [...t.querySelectorAll('tbody tr')]
        .map(r => r.querySelectorAll('td')[c]?.textContent?.trim() ?? '')
        .filter(s => s && s !== '—')
        .map(read)
        .filter((v): v is number => v != null && Number.isFinite(v));
    }, col);

test('sorting a number column orders it, both ways, on every main table', async ({ page }) => {
  const pages = ['/', '/firms', `/company/${ids.company}?tab=holders`, '/sectors', `/sectors/industry/${ids.industry}`];
  const bad: string[] = [];
  for (const url of pages) {
    await page.goto(url);
    await settle(page);
    const table = page.locator('main table').first();
    const heads = await table
      .locator('thead th')
      .evaluateAll(ths =>
        ths.map((th, i) => ({ i, num: th.classList.contains('num'), sortable: !!th.querySelector('button') }))
      );
    for (const h of heads.filter(x => x.num && x.sortable)) {
      const btn = table.locator('thead th').nth(h.i).locator('button');
      for (const pass of [1, 2]) {
        await btn.click();
        const dir = await table.locator('thead th').nth(h.i).getAttribute('aria-sort');
        const xs = await columnNumbers(page, 0, h.i);
        const ok = xs.every((v, k) => k === 0 || (dir === 'ascending' ? v >= xs[k - 1]! : v <= xs[k - 1]!));
        if (!ok || !dir || dir === 'none')
          bad.push(`${url} column ${h.i} pass ${pass} (${dir}): ${xs.slice(0, 8).join(', ')}`);
      }
    }
  }
  expect(bad).toEqual([]);
});

test('each table exports a CSV with its rows and a provenance header', async ({ page }) => {
  const pages = [
    '/',
    '/firms',
    `/firm/${ids.firm}`,
    `/fund/${ids.fund}`,
    `/company/${ids.company}?tab=holders`,
    '/sectors',
    '/sectors?tab=trends',
    '/sectors?tab=marks',
    `/sectors/theme/${ids.theme}`,
    '/explore',
    '/activity',
  ];
  const bad: string[] = [];
  for (const url of pages) {
    await page.goto(url);
    await settle(page);
    const btn = page.getByRole('button', { name: /as CSV$/ }).first();
    const [dl] = await Promise.all([page.waitForEvent('download'), btn.click()]);
    const text = await dl.createReadStream().then(
      s =>
        new Promise<string>(res => {
          let b = '';
          s.on('data', d => (b += d)).on('end', () => res(b));
        })
    );
    const lines = text.split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) bad.push(`${url}: ${lines.length} lines`);
    if (!/Source|Generated|warehouse/i.test(text)) bad.push(`${url}: no provenance`);
    if (/NaN|undefined|\[object Object\]/.test(text)) bad.push(`${url}: odd text in the CSV`);
  }
  expect(bad).toEqual([]);
});

/** One chart's series as {name: values}, read from what ECharts draws. */
const seriesOf = (page: Page, chart = 0) =>
  page
    .locator('main .chart')
    .nth(chart)
    .evaluate(el => {
      const o = (el as HTMLElement & { __chart: { getOption(): Record<string, any> } }).__chart.getOption();
      const val = (v: any): number | null => (v == null ? null : typeof v === 'object' ? val(v.value) : Number(v));
      return {
        categories: ((o.xAxis?.[0]?.type === 'category' ? o.xAxis[0] : o.yAxis?.[0])?.data ?? []) as string[],
        series: (o.series as Record<string, any>[]).map(s => ({
          name: String(s.name ?? ''),
          stack: s.stack as string | undefined,
          values: (s.data as unknown[]).map(val),
        })),
      };
    });

test('Sectors: the holdings bars are the API groups, and the groups add up to Market', async ({ page, request }) => {
  for (const level of ['sector', 'industry', 'theme']) {
    const api = await request.get(`/api/sectors?level=${level}`).then(r => r.json());
    await page.goto(`/sectors${level === 'sector' ? '' : `?level=${level}`}`);
    await settle(page);
    const s = await seriesOf(page);
    const shown = api.groups.slice(0, 16).reverse();
    expect(s.categories).toEqual(shown.map((g: { label: string }) => g.label));
    expect(s.series[0]?.values).toEqual(shown.map((g: { value: number }) => g.value));
    if (level !== 'theme') {
      const top = await request.get(`/api/market/top?category=company&limit=1&date=${api.date}`).then(r => r.json());
      const sum = api.groups.reduce((t: number, g: { value: number }) => t + g.value, 0);
      expect(Math.abs(sum - top.totalValue)).toBeLessThan(0.01);
    }
  }
});

test('Sectors over time: the stacked areas add up to the total in every quarter, with no negative band', async ({
  page,
}) => {
  const [res] = await Promise.all([
    page.waitForResponse(r => r.url().includes('/api/analysis/pivot')),
    page.goto('/sectors?tab=trends'),
  ]);
  const pivot = await res.json();
  await settle(page);
  const s = await seriesOf(page);
  const stacked = s.series.filter(x => x.stack);
  expect(stacked.length).toBeGreaterThan(0);
  for (const x of stacked)
    expect(
      x.values.every(v => v == null || v >= -0.5),
      x.name
    ).toBe(true);
  pivot.total.value.forEach((total: number, i: number) => {
    const sum = stacked.reduce((t, x) => t + (x.values[i] ?? 0), 0);
    expect(Math.abs(sum - total), `${pivot.periods[i].label}`).toBeLessThan(1);
  });
  expect(await chartProblems(page)).toEqual([]);
});

/** Whether an index answer has anything to draw (a period after the start with a value). */
const drawable = (idx: { groups: { points: { index: number | null }[] }[] }) =>
  idx.groups.some(g => g.points.some((p, i) => i > 0 && p.index != null));

test('per-share mark index: every line starts at 100 and the chart is the table', async ({ page, request }) => {
  const cases: [string, string][] = [
    ['/sectors?tab=marks', '/api/sectors/index?level=sector'],
    ['/sectors?tab=marks&view=value', '/api/sectors/index?level=sector'],
    [`/sectors/theme/${ids.theme}`, `/api/sectors/index?level=theme&keys=${ids.theme}`],
  ];
  for (const [url, api] of cases) {
    const idx = await request.get(api).then(r => r.json());
    await page.goto(url);
    await settle(page);
    if (!drawable(idx)) {
      // too few companies marked: the page says so instead of drawing an empty chart
      await expect(page.locator('main')).toContainText('No index to draw');
      await expect(page.locator('main .chart')).toHaveCount(0);
      continue;
    }
    const s = await seriesOf(page);
    const lines = s.series.filter(x => !x.stack);
    expect(lines.length, url).toBeGreaterThan(0);
    for (const l of lines) {
      const first = l.values.find(v => v != null);
      if (first != null) expect(first, `${url} ${l.name}`).toBeCloseTo(100, 6);
    }
    expect(s.categories[0]).toBe('start');
    if (url.startsWith('/sectors/')) {
      // the detail page's chart equals the API's index, point for point
      const line = s.series.find(x => x.name === idx.groups[0].label)!;
      expect(line.values).toEqual(idx.groups[0].points.map((p: { index: number | null }) => p.index));
    }
  }
});

test('Market: the top-15 chart is the table’s first 15 rows', async ({ page, request }) => {
  const top = await request.get('/api/market/top?category=company&limit=15').then(r => r.json());
  await page.goto('/');
  await settle(page);
  const s = await seriesOf(page);
  // direct and indirect (SPV) stack to each company's value
  const totals = s.categories.map((_, i) => s.series.reduce((t, x) => t + (x.values[i] ?? 0), 0));
  const want = top.results.map((r: { value: number }) => r.value).sort((x: number, y: number) => x - y);
  expect(
    totals
      .slice()
      .sort((x, y) => x - y)
      .map(v => Math.round(v))
  ).toEqual(want.map((v: number) => Math.round(v)));
});
