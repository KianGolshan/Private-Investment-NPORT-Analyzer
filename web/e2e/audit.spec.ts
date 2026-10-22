import { expect, test, type Page } from '@playwright/test';
import { chartProblems, pageProblems } from './audit';

// The audit's own test: each rule flags the chart or text it is written for,
// and passes a good one, so a green coverage run means something. The first
// case is the sector page's old band (an invisible helper series that showed
// in the tooltip, drawn a period behind the line).

const Q = ['start', '2025Q1', '2025Q2', '2025Q3'];
const line = (name: string, data: unknown[], extra: Record<string, unknown> = {}) => ({
  name,
  type: 'line',
  data,
  ...extra,
});
const option = (series: unknown[], extra: Record<string, unknown> = {}) => ({
  xAxis: [{ type: 'category', data: Q }],
  yAxis: [{ type: 'value' }],
  legend: [{ data: series.map(s => (s as { name: string }).name) }],
  series,
  ...extra,
});

async function chartsWith(page: Page, options: unknown[]) {
  await page.setContent('<main></main>');
  await page.evaluate(opts => {
    const main = document.querySelector('main')!;
    opts.forEach((o, i) => {
      const el = document.createElement('div');
      el.className = 'chart';
      el.setAttribute('aria-label', `case ${i}`);
      el.style.cssText = 'width:400px;height:200px';
      (el as unknown as { __chart: unknown }).__chart = { getOption: () => o };
      main.append(el);
    });
  }, options);
  return chartProblems(page);
}

test('the chart rules flag what they are written for', async ({ page }) => {
  const cases: [string, unknown, RegExp][] = [
    [
      'old band',
      option([
        line('25th percentile', [null, 100, 101, 103], { lineStyle: { opacity: 0 }, stack: 'band' }),
        line('AI', [100, 101, 104, 110]),
      ]),
      /invisible helper series shows in the tooltip/,
    ],
    ['short series', option([line('A', [100, 101])]), /2 points for 4 periods/],
    ['not a number', option([line('A', [100, 'x', 1, 2])]), /point 1 is "x"/],
    ['infinite', option([line('A', [100, Infinity, 1, 2])]), /point 1 is/],
    [
      'stack below zero',
      option([line('A', [1, -5, 2, 3], { stack: 'v', areaStyle: {} })]),
      /stacked area goes below zero/,
    ],
    ['stack hole', option([line('A', [1, null, 2, 3], { stack: 'v', areaStyle: {} })]), /a hole in a stacked area/],
    [
      'skipped quarter',
      option([line('A', [1, 2, 3])], { xAxis: [{ type: 'category', data: ['2025Q1', '2025Q2', '2025Q4'] }] }),
      /periods skip from 2025Q2 to 2025Q4/,
    ],
    [
      'unsorted',
      option([line('A', [1, 2, 3])], { xAxis: [{ type: 'category', data: ['2025Q2', '2025Q1', '2025Q3'] }] }),
      /out of order/,
    ],
    [
      'repeated period',
      option([line('A', [1, 2, 3])], { xAxis: [{ type: 'category', data: ['2025Q1', '2025Q1', '2025Q2'] }] }),
      /twice on the axis/,
    ],
    ['legend', option([line('A', [1, 2, 3, 4])], { legend: [{ data: ['A', 'B'] }] }), /legend names "B"/],
    ['log zero', option([line('A', [1, 0, 3, 4])], { yAxis: [{ type: 'log' }] }), /at or below zero on a log axis/],
    ['all zero', option([line('A', [0, 0, 0, 0])]), /every point is zero/],
    ['empty', option([line('A', [null, null, null, null])]), /no points at all/],
    ['lone point', option([line('A', [null, 5, null, null], { showSymbol: false })]), /no neighbour and no symbol/],
  ];
  for (const [what, opt, re] of cases) {
    const found = await chartsWith(page, [opt]);
    expect(found.join('\n'), what).toMatch(re);
  }
  // a good chart: a line from 100 and a stacked area, one partial period
  const good = option([line('AI', [100, 101, null, 110]), line('B', [1, 2, 3, 4], { stack: 'v', areaStyle: {} })]);
  expect(await chartsWith(page, [good])).toEqual([]);
});

test('the text rules flag numbers that never should be shown, not names', async ({ page }) => {
  const bad = ['NaN%', 'value undefined', '+Infinity%', '[object Object]', 'Invalid Date', '$-5.0M'];
  for (const t of bad) {
    await page.setContent(`<main><p>Mark ${t} here</p></main>`);
    expect((await pageProblems(page)).length, t).toBeGreaterThan(0);
  }
  for (const t of ['Infinity Fincorp', 'Nullify Inc', '−$5.0M', '+$3.2B', 'Infinity Fincorp Digital banking']) {
    await page.setContent(`<main><p>${t}</p></main>`);
    expect(await pageProblems(page), t).toEqual([]);
  }
  await page.setContent('<main><div style="width:5000px">wide</div></main>');
  expect((await pageProblems(page)).join()).toMatch(/scrolls sideways/);
});
