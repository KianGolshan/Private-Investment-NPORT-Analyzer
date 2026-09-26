// Tests for the mark analytics in public/app.js: mark velocity, peer-outlier
// flagging, the repricing-episode ledger, and the Fund X-Ray capital-structure
// / mark-implied-returns renderers. Real app in jsdom (test/helpers/loadApp.js).
//
// Run with: npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./helpers/loadApp');

const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

function series(company, points, baseLabel = 'Preferred') {
  return {
    company,
    key: company + '-k',
    baseLabel,
    shortLabel: baseLabel,
    fullLabel: company,
    holdings: points.map(([reportDate, chartValue]) => ({ reportDate, chartValue })),
  };
}

test('computeMarkVelocity: latest change vs the filing >=30 days earlier; annualized only over a 180+ day trailing window', async () => {
  const { window } = await loadApp();
  const q = window.computeMarkVelocity(
    series('A', [
      ['2024-03-31', 10],
      ['2024-06-30', 12],
    ])
  );
  assert.ok(close(q.latestPct, 20));
  assert.equal(q.days, 91);
  assert.equal(q.annualizedPct, null, 'one quarter is too short to annualize honestly');

  const long = window.computeMarkVelocity(
    series('L', [
      ['2023-12-31', 10],
      ['2024-03-31', 11],
      ['2024-06-30', 12],
    ])
  );
  assert.ok(close(long.latestPct, (12 / 11 - 1) * 100));
  assert.equal(long.annualizedDays, 182);
  assert.ok(close(long.annualizedPct, (Math.pow(1.2, 365 / 182) - 1) * 100, 1e-6));

  assert.equal(
    window.computeMarkVelocity(
      series('B', [
        ['2024-06-01', 10],
        ['2024-06-15', 12],
      ])
    ),
    null,
    'gap under 30 days → no reading'
  );
  assert.equal(window.computeMarkVelocity(series('C', [['2024-06-01', 10]])), null);
});

test('computeOutlierFlags: flags the one fund far from same-class peers; leaves the pack alone', async () => {
  const { window } = await loadApp();
  const list = [
    series('F1', [['2024-06-30', 100]]),
    series('F2', [['2024-06-30', 101]]),
    series('F3', [['2024-06-30', 99]]),
    series('F4', [['2024-06-30', 100]]),
    series('F5', [['2024-06-30', 102]]),
    series('Out', [['2024-06-30', 160]]),
  ];
  const flags = window.computeOutlierFlags(list);
  assert.deepEqual(Object.keys(flags), ['Out||Out-k']);
  assert.equal(flags['Out||Out-k'].direction, 'high');
  assert.equal(flags['Out||Out-k'].peerCount, 5);
});

test('computeOutlierFlags: a large gap is NOT an outlier when peers themselves are widely dispersed', async () => {
  const { window } = await loadApp();
  const list = [60, 80, 100, 120, 140].map((v, i) => series('F' + i, [['2024-06-30', v]]));
  list.push(series('Far', [['2024-06-30', 130]])); // 30% above the median, but well inside the spread
  assert.deepEqual(Object.keys(window.computeOutlierFlags(list)), []);
});

test('computeOutlierFlags: a statistically extreme but immaterial (<15%) gap among near-identical peers is not flagged', async () => {
  const { window } = await loadApp();
  const list = [100, 100, 100, 100, 100].map((v, i) => series('F' + i, [['2024-06-30', v]]));
  list.push(series('Near', [['2024-06-30', 108]]));
  assert.deepEqual(Object.keys(window.computeOutlierFlags(list)), []);
});

test('computeOutlierFlags: peers too stale to compare (different fiscal calendars) or too few → no flag', async () => {
  const { window } = await loadApp();
  const stale = [
    series('F1', [['2023-06-30', 100]]),
    series('F2', [['2023-06-30', 101]]),
    series('F3', [['2023-06-30', 99]]),
    series('F4', [['2023-06-30', 100]]),
    series('Out', [['2024-06-30', 160]]),
  ];
  assert.deepEqual(Object.keys(window.computeOutlierFlags(stale)), [], 'peer marks a year old are not comparable');

  const few = [
    series('F1', [['2024-06-30', 100]]),
    series('F2', [['2024-06-30', 101]]),
    series('Out', [['2024-06-30', 160]]),
  ];
  assert.deepEqual(
    Object.keys(window.computeOutlierFlags(few)),
    [],
    'under 4 peers is too thin to call anyone an outlier'
  );
});

test('computeOutlierFlags: different class labels are never compared with each other', async () => {
  const { window } = await loadApp();
  const list = [
    series('F1', [['2024-06-30', 100]]),
    series('F2', [['2024-06-30', 101]]),
    series('F3', [['2024-06-30', 99]]),
    series('F4', [['2024-06-30', 100]]),
    series('Common1', [['2024-06-30', 20]], 'Common'),
  ];
  assert.deepEqual(Object.keys(window.computeOutlierFlags(list)), []);
});

test('buildMarkEventLedger: groups same-direction repricings across 3+ funds in order of first appearance, and scores leaders', async () => {
  const { window } = await loadApp();
  const list = [
    series('A', [
      ['2023-01-31', 10],
      ['2023-02-28', 12],
      ['2024-01-31', 12],
      ['2024-02-29', 14.4],
    ]),
    series('B', [
      ['2023-03-31', 10],
      ['2023-04-30', 12],
      ['2024-03-31', 12],
      ['2024-04-30', 14.4],
    ]),
    series('C', [
      ['2023-05-31', 10],
      ['2023-06-30', 12],
      ['2024-05-31', 12],
      ['2024-06-30', 14.4],
    ]),
  ];
  const ledger = window.buildMarkEventLedger(list);
  assert.equal(ledger.episodes.length, 2, 'two separate repricing waves ~8 months apart');
  ledger.episodes.forEach(ep => {
    assert.equal(ep.dir, 'up');
    assert.deepEqual(
      Array.from(ep.events, e => e.company),
      ['A', 'B', 'C']
    );
  });
  const byCompany = Object.fromEntries(ledger.leaders.map(l => [l.company, l.leadScore]));
  assert.ok(close(byCompany.A, 1));
  assert.ok(close(byCompany.B, 0.5));
  assert.ok(close(byCompany.C, 0));
});

test('buildMarkEventLedger: two funds moving is not an episode; sub-5% drift is not an event', async () => {
  const { window } = await loadApp();
  const two = window.buildMarkEventLedger([
    series('A', [
      ['2024-01-31', 10],
      ['2024-02-29', 12],
    ]),
    series('B', [
      ['2024-01-31', 10],
      ['2024-03-31', 12],
    ]),
  ]);
  assert.equal(two.episodes.length, 0);
  const drift = window.buildMarkEventLedger(
    ['A', 'B', 'C'].map(c =>
      series(c, [
        ['2024-01-31', 10],
        ['2024-02-29', 10.3],
      ])
    )
  );
  assert.equal(drift.episodes.length, 0);
});

test('capitalStructureHTML: lists multi-tranche issuers senior-first, escapes issuer text, skips single-tranche issuers', async () => {
  const { window } = await loadApp();
  const xray = {
    capitalStructure: [
      {
        issuer: '<img src=x onerror=alert(1)>',
        totalValueUSD: 7150000,
        pctOfNetAssets: 2.5,
        debtPctOfExposure: 84.6,
        weightedDebtCouponPct: 7,
        multiTranche: true,
        instruments: [
          {
            title: 'TL 7.0% 03-31-26',
            instrumentType: 'debt',
            instrumentLabel: 'Term Loan',
            marketValue: 6050000,
            couponPct: 7,
            maturity: '03-31-26',
          },
          { title: 'PFD SER D', instrumentType: 'equity', instrumentLabel: 'Preferred D', marketValue: 1100000 },
        ],
      },
      { issuer: 'Solo Co', totalValueUSD: 5, multiTranche: false, instruments: [] },
    ],
  };
  const html = window.capitalStructureHTML(xray);
  assert.ok(html.includes('Capital Structure by Private Issuer'));
  assert.ok(!html.includes('<img'), 'issuer name must be escaped');
  assert.ok(!html.includes('Solo Co'));
  assert.ok(html.indexOf('Term Loan') < html.indexOf('Preferred D'));
  assert.ok(html.includes('7% due 03-31-26'));
  assert.equal(window.capitalStructureHTML({ capitalStructure: [] }), '');
  assert.equal(window.capitalStructureHTML({}), '');
});

test('returnsResultHTML: shows the proxy caveat, MOIC, and flags window-start / converted positions', async () => {
  const { window } = await loadApp();
  const html = window.returnsResultHTML({
    summary: {
      moic: 1.5,
      irr: 0.2,
      invested: 2000,
      realized: 1000,
      currentValue: 2000,
      positionCount: 1,
      periodCount: 4,
      firstDate: '2024-03-31',
      lastDate: '2024-12-31',
      excludedCount: 1,
    },
    positions: [
      {
        title: 'ACME <b>PFD</b>',
        name: 'ACME',
        firstDate: '2024-03-31',
        lastDate: '2024-12-31',
        status: 'open',
        invested: 2000,
        realized: 1000,
        currentValue: 2000,
        moic: 1.5,
        irr: 0.2,
        entryIsWindowStart: true,
        lotsUnavailable: false,
        chainedFrom: 'ACME OLD',
        events: [{ type: 'addon' }, { type: 'partial_realization' }],
      },
    ],
  });
  assert.ok(html.includes('proxies built from the fund'));
  assert.ok(html.includes('1.50×'));
  assert.ok(html.includes('held before oldest filing'));
  assert.ok(html.includes('converted from ACME OLD'));
  assert.ok(html.includes('1 add-on'));
  assert.ok(html.includes('excluded from the totals'));
  assert.ok(!html.includes('<b>PFD'), 'position title must be escaped');
});

test('buildMarkEventLedger: waves by different funds far apart in time are separate episodes, not one merged wave', async () => {
  const { window } = await loadApp();
  const wave = (names, base) =>
    names.map((n, i) =>
      series(n, [
        [base(i, 0), 10],
        [base(i, 1), 12],
      ])
    );
  const early = wave(['A', 'B', 'C'], (i, k) => (k ? `2023-0${2 + i}-28` : `2023-0${1 + i}-28`));
  const late = wave(['D', 'E', 'F'], (i, k) => (k ? `2024-0${2 + i}-28` : `2024-0${1 + i}-28`));
  const ledger = window.buildMarkEventLedger([...early, ...late]);
  assert.equal(ledger.episodes.length, 2);
  assert.deepEqual(
    Array.from(ledger.episodes[0].events, e => e.company),
    ['D', 'E', 'F']
  );
  assert.deepEqual(
    Array.from(ledger.episodes[1].events, e => e.company),
    ['A', 'B', 'C']
  );
});

test("computeOutlierFlags: a fund's own other series never count as its peers", async () => {
  const { window } = await loadApp();
  const list = [
    series('F1', [['2024-06-30', 100]]),
    series('F2', [['2024-06-30', 101]]),
    series('F3', [['2024-06-30', 99]]),
    { ...series('Out', [['2024-06-30', 160]]), key: 'Out-k1' },
    { ...series('Out', [['2024-06-30', 160]]), key: 'Out-k2' },
  ];
  // Only 3 independent peers: not enough to call an outlier (the sibling series must not pad the count).
  assert.deepEqual(Object.keys(window.computeOutlierFlags(list)), []);
});

// ── stock splits inside the mark analytics (real Destiny Tech100 SpaceX SPVs) ──

function realSeries(company, points) {
  return {
    company,
    key: company + '-k',
    baseLabel: 'Indirect',
    shortLabel: 'Indirect',
    fullLabel: company,
    holdings: points.map(([reportDate, shares, pricePerShare]) => ({
      reportDate,
      shares,
      pricePerShare,
      chartValue: pricePerShare,
      instrumentType: 'indirect',
    })),
  };
}

test('mark velocity restates prices across a real 5-for-1 split: DXYZ SpaceX I LLC $529.10 → $170.86 is +61.5%, not −67.7%', async () => {
  const { window } = await loadApp();
  const v = window.computeMarkVelocity(
    realSeries('DXYZ SpaceX I LLC', [
      ['2025-12-31', 135135, 403.3],
      ['2026-03-31', 135135, 529.1],
      ['2026-06-30', 675675, 170.86],
    ])
  );
  assert.ok(close(v.latestPct, (170.86 / (529.1 / 5) - 1) * 100, 1e-9), `latest ${v.latestPct}`);
  assert.ok(v.latestPct > 61 && v.latestPct < 62);
  assert.equal(v.splitAdjusted, true);
  // Trailing window (2025-12-31 → 2026-06-30, 181 days) is under 180 days? 2025-12-31→2026-06-30 = 181 days → annualized present and split-adjusted too.
  assert.ok(close(v.sinceFirstPct, (170.86 / (403.3 / 5) - 1) * 100, 1e-9));
});

test('no split, no adjustment: the same fund’s earlier real quarters are read at face value', async () => {
  const { window } = await loadApp();
  const v = window.computeMarkVelocity(
    realSeries('DXYZ SpaceX I LLC', [
      ['2025-12-31', 135135, 403.3],
      ['2026-03-31', 135135, 529.1],
    ])
  );
  assert.ok(close(v.latestPct, (529.1 / 403.3 - 1) * 100, 1e-9));
  assert.equal(v.splitAdjusted, false);
});

test('a real split is not an outlier or a repricing event: the ledger and outlier flags see the split-adjusted marks', async () => {
  const { window } = await loadApp();
  // Three real SpaceX SPVs across Destiny Tech100 / Private Shares Fund on 2026-06-30, all split 5-for-1 that quarter.
  const list = [
    realSeries('DXYZ SpaceX I LLC', [
      ['2026-03-31', 135135, 529.1],
      ['2026-06-30', 675675, 170.86],
    ]),
    realSeries('MWAM VC SpaceX-II', [
      ['2026-03-31', 42857, 483.89],
      ['2026-06-30', 214285, 155.31],
    ]),
    realSeries('SC JAL, LLC', [
      ['2026-03-31', 21086, 526.59],
      ['2026-06-30', 105430, 170.86],
    ]),
    realSeries('HOF Capital WH', [
      ['2026-03-31', 38310, 526.59],
      ['2026-06-30', 191550, 170.86],
    ]),
    realSeries('MVP Opportunity VI', [
      ['2026-03-31', 6133, 526.5899],
      ['2026-06-30', 30665, 170.86],
    ]),
  ];
  const ledger = window.buildMarkEventLedger(list);
  // Raw prices fell ~68% for all five; adjusted they rose ~62%, all in the same direction — one markup episode, never a markdown.
  assert.equal(ledger.episodes.length, 1);
  assert.equal(ledger.episodes[0].dir, 'up');
  assert.ok(
    ledger.episodes[0].events.every(e => e.pct > 55 && e.pct < 65),
    JSON.stringify(Array.from(ledger.episodes[0].events, e => e.pct))
  );
});
