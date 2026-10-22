/* eslint-disable @typescript-eslint/no-explicit-any -- ECharts options and API answers are read back as plain data */
import { expect, type APIRequestContext, type Page } from '@playwright/test';

// The UI audit's checks (UI coverage plan, docs/UI-COVERAGE.md): what every
// page and every chart must satisfy whatever the data. The coverage spec runs
// them on each route, tab and control; `E2E_BASE_URL` points it at a running
// server over the full warehouse, where odd charts actually show.

/** Console errors and failed API calls while a page is open. */
export function watch(page: Page) {
  const errors: string[] = [];
  page.on('console', m => {
    if (m.type() === 'error' && !/status of 404/.test(m.text())) errors.push(m.text());
  });
  page.on('pageerror', e => errors.push(String(e)));
  page.on('response', r => {
    if (r.url().includes('/api/') && r.status() >= 400 && r.status() !== 404)
      errors.push(`${r.status()} ${new URL(r.url()).pathname}`);
  });
  return errors;
}

/** Waits until the page's data has loaded and every chart has drawn. */
export async function settle(page: Page) {
  await expect(page.locator('h1').first()).toBeVisible();
  // a click's request starts after the next render: give it that moment before waiting for the network
  await page.waitForTimeout(250);
  await page.waitForLoadState('networkidle');
  await expect(page.locator('.skeleton, [aria-busy="true"]')).toHaveCount(0, { timeout: 20_000 });
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('.chart')].every(el => {
        const c = (el as HTMLElement & { __chart?: { getOption(): { series?: unknown[] } | undefined } }).__chart;
        return Array.isArray(c?.getOption()?.series);
      }),
    undefined,
    { timeout: 20_000 }
  );
}

/**
 * Problems in the charts on the page, read from what ECharts draws: series
 * that do not line up with their axis, values that are not numbers, stacked
 * areas below zero, unsorted or repeated periods, a legend naming series that
 * do not exist, helper series that show in the tooltip, and empty charts.
 */
export async function chartProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    type Opt = Record<string, any>;
    const out: string[] = [];
    const num = (v: unknown): number | null | undefined => {
      if (v == null || v === '-') return null;
      if (typeof v === 'number') return v;
      if (Array.isArray(v)) return num(v[v.length - 1]);
      if (typeof v === 'object' && 'value' in (v as Opt)) return num((v as Opt).value);
      return undefined; // a string or something else: not a number
    };
    const PERIOD = /^(\d{4}(Q[1-4]|-\d{2}(-\d{2})?)?|[A-Z][a-z]{2} \d{4})$/;
    const order = (s: string) => {
      const q = /^(\d{4})Q([1-4])$/.exec(s);
      if (q) return `${q[1]}-${String(Number(q[2]) * 3).padStart(2, '0')}`;
      const m = /^([A-Z][a-z]{2}) (\d{4})$/.exec(s);
      if (m)
        return `${m[2]}-${String('JanFebMarAprMayJunJulAugSepOctNovDec'.indexOf(m[1] ?? '') / 3 + 1).padStart(2, '0')}`;
      return s;
    };
    document.querySelectorAll('.chart').forEach((el, ci) => {
      const label = `chart ${ci + 1} "${(el.getAttribute('aria-label') ?? '').replace('. The table has the same numbers.', '').slice(0, 90)}"`;
      const c = (el as HTMLElement & { __chart?: { getOption(): Opt } }).__chart;
      if (!c) return void out.push(`${label}: never drew`);
      const box = el.getBoundingClientRect();
      if (box.width < 50 || box.height < 30) out.push(`${label}: ${box.width}×${box.height} px`);
      const o = c.getOption();
      if (!o) return void out.push(`${label}: no option set`);
      const series: Opt[] = o.series ?? [];
      const xs: Opt[] = o.xAxis ?? [];
      const ys: Opt[] = o.yAxis ?? [];
      const cat = (s: Opt) => {
        const x = xs[s.xAxisIndex ?? 0];
        const y = ys[s.yAxisIndex ?? 0];
        return x?.type === 'category' ? x : y?.type === 'category' ? y : null;
      };
      for (const ax of [...xs, ...ys]) {
        if (ax?.type !== 'category' || !Array.isArray(ax.data)) continue;
        const names = ax.data.map((d: unknown) => String(typeof d === 'object' && d ? (d as Opt).value : d));
        const dup = names.find((n: string, i: number) => names.indexOf(n) !== i);
        if (dup && PERIOD.test(dup)) out.push(`${label}: period "${dup}" twice on the axis`);
        const periods = names.filter((n: string) => PERIOD.test(n)).map(order);
        if (periods.length === names.length && periods.some((p: string, i: number) => i > 0 && p < periods[i - 1]!))
          out.push(`${label}: periods out of order (${names.join(', ')})`);
        // quarters and months follow each other with none skipped
        const step = (a: string, b: string) => {
          const q = /^(\d{4})Q([1-4])$/;
          const qa = q.exec(a);
          const qb = q.exec(b);
          if (qa && qb) return (Number(qb[1]) - Number(qa[1])) * 4 + Number(qb[2]) - Number(qa[2]);
          const m = /^(\d{4})-(\d{2})$/;
          const ma = m.exec(a);
          const mb = m.exec(b);
          if (ma && mb) return (Number(mb[1]) - Number(ma[1])) * 12 + Number(mb[2]) - Number(ma[2]);
          return 1;
        };
        const gap = names.findIndex((n: string, i: number) => i > 0 && step(names[i - 1]!, n) > 1);
        if (gap > 0) out.push(`${label}: periods skip from ${names[gap - 1]} to ${names[gap]}`);
      }
      let points = 0;
      let nonzero = 0;
      for (const s of series) {
        const name = `${label} series "${s.name ?? s.type}"`;
        const data: unknown[] = Array.isArray(s.data) ? s.data : [];
        const axis = cat(s);
        if ((s.type === 'line' || s.type === 'bar') && axis && Array.isArray(axis.data) && !s.encode)
          if (data.length !== axis.data.length)
            out.push(`${name}: ${data.length} points for ${axis.data.length} periods`);
        const vals = data.map(num);
        const bad = vals.findIndex(v => v === undefined || (v != null && !Number.isFinite(v)));
        if (bad >= 0) out.push(`${name}: point ${bad} is ${JSON.stringify(data[bad])}`);
        points += vals.filter(v => v != null).length;
        nonzero += vals.filter(v => v != null && v !== 0).length;
        const first = vals.findIndex(v => v != null);
        const last = vals.length - 1 - [...vals].reverse().findIndex(v => v != null);
        if (s.stack && s.areaStyle && first >= 0 && vals.slice(first, last).some(v => v == null))
          out.push(`${name}: a hole in a stacked area`);
        if (s.type === 'line' && s.showSymbol === false && !s.areaStyle)
          vals.forEach((v, i) => {
            if (v != null && vals[i - 1] == null && vals[i + 1] == null)
              out.push(`${name}: the point at ${i} has no neighbour and no symbol, so it is not drawn`);
          });
        const axisOf = ys[s.yAxisIndex ?? 0]?.type === 'log' ? ys[s.yAxisIndex ?? 0] : xs[s.xAxisIndex ?? 0];
        if (axisOf?.type === 'log' && vals.some(v => v != null && v <= 0))
          out.push(`${name}: a value at or below zero on a log axis`);
        if (s.stack && s.areaStyle && s.type === 'line' && vals.some(v => v != null && v < -0.5))
          out.push(
            `${name}: a stacked area goes below zero (${Math.min(...(vals as number[]).filter(v => v != null))})`
          );
        const invisible = s.lineStyle?.opacity === 0 && !s.areaStyle;
        if (invisible && s.tooltip?.show !== false)
          out.push(`${name}: an invisible helper series shows in the tooltip`);
      }
      const legend: Opt | undefined = (o.legend ?? [])[0];
      if (legend?.show !== false && Array.isArray(legend?.data)) {
        const have = new Set(series.map(s => s.name));
        for (const d of legend.data) {
          const n = typeof d === 'object' ? d?.name : d;
          if (!have.has(n)) out.push(`${label}: legend names "${n}", which is not drawn`);
        }
      }
      if (series.length && points === 0) out.push(`${label}: no points at all`);
      else if (series.length && nonzero === 0 && o.series[0]?.type !== 'heatmap')
        out.push(`${label}: every point is zero`);
    });
    return out;
  });
}

/** Text that should never reach a reader, overflow at the page's width. */
export async function pageProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const main = document.querySelector('main') ?? document.body;
    const text = (main as HTMLElement).innerText;
    for (const [re, what] of [
      [/\bNaN\b/, 'NaN'],
      [/\bundefined\b/, 'undefined'],
      // a number, never a name (Infinity Fincorp is a company)
      [/(^|[\s$(+−-])Infinity(?![ \t]+[A-Z])|∞/m, 'Infinity'],
      [/\[object Object\]/, '[object Object]'],
      [/Invalid Date/, 'Invalid Date'],
      [/\bnull\b(?! ?hypothesis)/, 'null'],
      [/\$-|[+−-]{2}\$|\+−|−\+/, 'a doubled or misplaced sign'],
    ] as const) {
      const m = re.exec(text);
      if (m) out.push(`shows ${what}: "…${text.slice(Math.max(0, m.index - 40), m.index + 30).replace(/\s+/g, ' ')}…"`);
    }
    const wide = document.documentElement.scrollWidth - window.innerWidth;
    if (wide > 1) out.push(`the page scrolls sideways by ${wide}px`);
    return out;
  });
}

/** Both kinds of problem, with the page's own errors. */
export async function audit(page: Page, errors: string[]) {
  await settle(page);
  return [...(await chartProblems(page)), ...(await pageProblems(page)), ...errors.splice(0)];
}

/** Ids that exist in whichever warehouse the server reads (golden or full). */
export interface Ids {
  company: number;
  company2: number;
  firm: number;
  fund: string;
  sector: string;
  industry: string;
  theme: string;
  entity: string | null;
}
export async function discover(request: APIRequestContext): Promise<Ids> {
  const get = (p: string) => request.get(p).then(r => r.json());
  const top = await get('/api/market/top?category=company&limit=5');
  const company = top.results[0].companyId;
  const company2 = top.results[1]?.companyId ?? company;
  const firms = await get('/api/firms?limit=5');
  const firm = firms.results[0].id;
  const exp = await get(`/api/companies/${company}/exposure`);
  const fund = exp.holdings[0].fundKey;
  const sec = await get('/api/sectors');
  const ind = await get('/api/sectors?level=industry');
  const th = await get('/api/sectors?level=theme');
  let ent: { key: string } | undefined;
  for (const q of ['inc', 'llc', 'corp', 'ltd', 'pjsc', 'a']) {
    ent ??= (await get(`/api/search?q=${q}&kinds=entity&limit=5`)).results?.[0];
  }
  return {
    company,
    company2,
    firm,
    fund,
    sector: sec.groups[0].key,
    industry: ind.groups[0].key,
    theme: th.groups[0]?.key ?? 'ai',
    entity: ent?.key ?? null,
  };
}
