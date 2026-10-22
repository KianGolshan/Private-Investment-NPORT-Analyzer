/* eslint-disable @typescript-eslint/no-explicit-any -- API answers are read as plain JSON */
import { expect, test, type APIRequestContext } from '@playwright/test';

// Every view's numbers agree with the others (docs/UI-COVERAGE.md, part C):
// the answers behind Market, Sectors, firm and company pages, the bridge,
// movers and the mark index, read through the same API the pages use, at the
// newest date and two earlier ones. Runs on the golden warehouse in CI and on
// the full warehouse with E2E_BASE_URL.

type Json = Record<string, any>;
const get = async (request: APIRequestContext, path: string): Promise<Json> => {
  const r = await request.get(path);
  expect(r.status(), path).toBe(200);
  return r.json();
};
const sum = (xs: number[]) => xs.reduce((t, v) => t + v, 0);
const near = (a: number, b: number, what: string, cents = 0.05) =>
  expect(Math.abs(a - b), `${what}: ${a} vs ${b}`).toBeLessThanOrEqual(cents);

let dates: string[] = [];
test.beforeAll(async ({ request }) => {
  const f = await get(request, '/api/freshness');
  dates = [f.newestReportDate, '2025-12-31', '2024-06-30'];
});

test('Market, sectors, industries and each sector’s company list are one total at every date', async ({ request }) => {
  for (const date of dates) {
    const top = await get(request, `/api/market/top?category=company&limit=1&date=${date}`);
    for (const level of ['sector', 'industry']) {
      const t = await get(request, `/api/sectors?level=${level}&date=${date}`);
      near(sum(t.groups.map((g: Json) => g.value)), top.totalValue, `${level} sum at ${date}`);
      expect(sum(t.groups.map((g: Json) => g.companies)), `${level} companies at ${date}`).toBe(top.companies);
      for (const g of t.groups.slice(0, 4)) {
        const c = await get(request, `/api/sectors/companies?level=${level}&key=${g.key}&date=${date}`);
        near(c.totalValue, g.value, `${level} ${g.key} page total at ${date}`);
        near(sum(c.results.map((r: Json) => r.value)), c.totalValue, `${level} ${g.key} rows at ${date}`);
        expect(c.results.length).toBe(g.companies);
      }
    }
  }
});

test('a company’s value is its holdings’ sum and its Market row, at every date', async ({ request }) => {
  for (const date of dates) {
    const top = await get(request, `/api/market/top?category=company&limit=8&date=${date}`);
    for (const row of top.results) {
      const e = await get(request, `/api/companies/${row.companyId}/exposure?date=${date}`);
      near(e.total.value ?? e.total, row.value, `${row.name} Market vs company at ${date}`);
      near(sum(e.holdings.map((h: Json) => h.value)), row.value, `${row.name} holdings at ${date}`);
      expect(e.holdings.length, `${row.name} funds at ${date}`).toBe(row.funds);
    }
  }
});

test('a firm’s book is the sum of its companies and of its funds', async ({ request }) => {
  const firms = await get(request, '/api/firms?limit=6');
  for (const f of firms.results) {
    const b = await get(request, `/api/firms/${f.id}`);
    near(b.value, f.value, `${f.name} list vs page`, 1);
    near(sum(b.byCompany.map((c: Json) => c.value)), b.value, `${f.name} by company`, 1);
    near(sum(b.byFund.map((c: Json) => c.value)), b.value, `${f.name} by fund`, 1);
  }
});

test('the bridge reconciles: start + every step = end, for the market and a company', async ({ request }) => {
  const top = await get(request, '/api/market/top?category=company&limit=1');
  for (const q of ['', `&company=${top.results[0].companyId}`]) {
    const b = await get(request, `/api/analysis/bridge?from=2025-06-30&to=${dates[0]}${q}`);
    near(b.start.value + sum(b.steps.map((s: Json) => s.value)), b.end.value, `bridge${q}`, 1);
  }
});

test('movers: each company’s start + positions + marks + other = end', async ({ request }) => {
  const m = await get(request, '/api/market/movers?limit=20');
  for (const list of ['markUp', 'markDown', 'flowIn', 'flowOut'])
    for (const r of m[list] ?? []) {
      const other = r.otherEffect ?? r.otherChanges ?? 0;
      const rest = r.endValue - r.startValue - r.markEffect - r.positionEffect - other;
      // without a separate "other" field the rest is the funds that started or stopped filing: it may be any size,
      // but the parts must be numbers
      for (const v of [r.startValue, r.endValue, r.markEffect, r.positionEffect]) expect(Number.isFinite(v)).toBe(true);
      if (r.otherEffect != null || r.otherChanges != null) near(rest, 0, `${list} ${r.name}`, 1);
    }
});

test('the mark index chains: each point is the last one times one plus the period’s change, both indexes', async ({
  request,
}) => {
  for (const q of ['level=sector', 'level=industry', 'level=theme', 'level=sector&from=2020-01-01&to=2026-06-30']) {
    const idx = await get(request, `/api/sectors/index?${q}`);
    for (const g of idx.groups) {
      // 100 at the window's start, or (too few companies there) at the first period it can be measured
      const base = g.points.findIndex((p: Json) => p.index != null);
      if (base >= 0) expect(g.points[base].index, `${q} ${g.key} base`).toBe(100);
      for (let i = 1; i < g.points.length; i++) {
        const [a, b] = [g.points[i - 1], g.points[i]];
        for (const [lvl, chg] of [
          ['index', 'change'],
          ['valueIndex', 'valueChange'],
        ] as const) {
          if (b[lvl] == null) continue;
          if (a[lvl] == null || b[chg] == null) {
            expect(b[lvl], `${q} ${g.key} ${b.label}: a level with no chain is the base`).toBe(100);
            continue;
          }
          near(b[lvl], a[lvl] * (1 + b[chg]), `${q} ${g.key} ${b.label} ${lvl}`, 1e-6);
        }
        if (b.p25 != null && b.p75 != null) expect(b.p25 <= b.p75, `${q} ${g.key} ${b.label} p25<=p75`).toBe(true);
        if (b.sufficient) expect(b.companies, `${q} ${g.key} ${b.label} minimum`).toBeGreaterThanOrEqual(5);
        else expect([null, 100], `${q} ${g.key} ${b.label} insufficient`).toContain(b.index);
      }
    }
  }
});

test('Explore: additive rows add up to the total in every period', async ({ request }) => {
  for (const rows of ['sector', 'industry', 'company']) {
    const p = await get(
      request,
      `/api/analysis/pivot?rows=${rows}&period=quarter&from=2024-06-30&to=${dates[0]}&limit=5000&category=company`
    );
    if (p.additive === false) continue;
    expect(p.count, `${rows}: more rows than the answer lists`).toBeGreaterThanOrEqual(p.results.length);
    if (p.count > p.results.length) continue; // the page says "top N shown"; the sum is checked where all are listed
    p.periods.forEach((per: Json, i: number) => {
      near(sum(p.results.map((r: Json) => r.value[i])), p.total.value[i], `${rows} ${per.label}`, 1);
    });
  }
});
