// Private Credit parser against REAL BDC 10-Q tables. Fixtures are verbatim
// <table> elements (trimmed to the header rows + the issuer's rows) from live
// filings — each a different real layout that broke the parser before:
//
//   agl_anaplan               AGL Private Credit Income Fund, 2026-06-30 (Anaplan). Header says
//                             "Investments", "Par ($) / Shares", "Cost/Amortized Cost"; figures sit one
//                             cell to the right of their header.
//   senior_credit_west_star   Senior Credit Investments, LLC, 2026-06-30 (West Star Aviation). "Principal /
//                             Shares"; a bare footnote "8" trails the row and was read as fair value.
//   bxsl_fastener             Blackstone Secured Lending, 2026-06-30 (Fastener Distribution). "% of Net
//                             Assets" printed as a bare number; every cell repeated by colspan.
//   owl_rock_tech_income_zendesk  Owl Rock Technology Income Corp, 2023-03-31 (Zendesk). Unfunded
//                             commitments (negative cost/FV), company total rows, unit-denominated equity.
//   onex_medallia             Onex Direct Lending BDC Fund, 2026-06-30 (Medallia). Whole dollars; deeply
//                             marked-down loans.
//   ocsl_pluralsight          Oaktree Specialty Lending, 2026-06-30 (Pluralsight). Genuinely distressed
//                             tranches at ~5% of par next to par-marked ones; unfunded commitments.
//   otf_pluralsight           Blue Owl Technology Finance, 2026-03-31 (Pluralsight). A $12.6M unfunded
//                             delayed-draw commitment with cost 12,649 and fair value -253.
//
// Run with: npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cheerio = require('cheerio');
const { extractCreditHoldings, tryBuildCreditColumnMap } = require('../parsers');

const load = name => cheerio.load(fs.readFileSync(path.join(__dirname, 'fixtures', `bdc_10q_${name}.html`), 'utf8'));
const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const summarize = rows =>
  rows.map(h => [
    h.principal,
    h.cost,
    h.fairValue,
    h.fairValueMark === null ? null : Math.round(h.fairValueMark * 100) / 100,
  ]);

test('AGL Private Credit Income Fund — Anaplan: three real term loans, marked at par, SOFR + 4.50% split into index and spread', () => {
  const rows = extractCreditHoldings(load('agl_anaplan'), 'Anaplan', '2026-06-30');
  assert.deepEqual(summarize(rows), [
    [39798, 39798, 39798, 100],
    [46057, 46057, 46057, 100],
    [6027, 6027, 6027, 100],
  ]);
  assert.deepEqual(
    rows.map(r => [r.index, r.spread, r.cashInterestRate, r.maturityDate, r.investmentType]),
    [
      ['SOFR', '4.50%', '8.17%', '6/21/2029', 'First Lien Term Loan'],
      ['SOFR', '4.50%', '8.32%', '6/21/2029', 'First Lien Term Loan'],
      ['SOFR', '4.50%', '8.17%', '6/21/2029', 'First Lien Term Loan'],
    ]
  );
  assert.ok(
    !rows.some(r => /^\d+(\.\d+)?%$/.test(r.pik) && r.pik === '8.6%'),
    '"% of Net Assets" (8.6%) is not read as a rate'
  );
});

test('Senior Credit Investments — West Star Aviation: the trailing footnote "8" is not the fair value; every tranche is at par', () => {
  const rows = extractCreditHoldings(load('senior_credit_west_star'), 'West Star Aviation', '2026-06-30');
  assert.equal(rows.length, 6, 'six tranches; the company total row (21,412 / 21,500) is not a holding');
  assert.deepEqual(summarize(rows), [
    [7006, 6960, 7006, 100],
    [1128, 1119, 1128, 100],
    [18, 17, 18, 100],
    [7041, 6992, 7041, 100],
    [689, 682, 690, 100.15],
    [18, 17, 18, 100],
  ]);
  assert.ok(rows.every(r => r.index === 'S' && r.spread === '4.50%' && r.maturityDate === '5/20/2032'));
});

test('Blackstone Secured Lending — Fastener Distribution: colspan-repeated cells and a bare-number % of net assets still give par/cost/fair value', () => {
  const rows = extractCreditHoldings(load('bxsl_fastener'), 'Fastener Distribution', '2026-06-30');
  assert.deepEqual(summarize(rows), [
    [30550, 30317, 30550, 100],
    [4436, 4375, 4436, 100],
    [30705, 30449, 30705, 100],
    [4458, 4392, 4458, 100],
  ]);
  assert.deepEqual(
    rows.map(r => r.cashInterestRate),
    ['8.48%', '8.48%', '8.42%', '8.42%']
  );
});

test('Owl Rock Technology Income — Zendesk: unfunded commitments and the company total row are dropped; units are never turned into a mark', () => {
  const rows = extractCreditHoldings(load('owl_rock_tech_income_zendesk'), 'Zendesk', '2023-03-31');
  assert.equal(
    rows.length,
    4,
    'two funded term loans + the two real equity positions; no unfunded delayed-draw/revolver rows'
  );
  assert.ok(
    rows.every(r => r.fairValue > 0),
    'no negative fair values (unfunded commitments) among holdings'
  );
  assert.ok(!rows.some(r => r.cost === 404651), 'the company total row is not a holding');
  assert.deepEqual(summarize(rows.slice(0, 2)), [
    [58534, 57415, 57509, 98.25],
    [58534, 57379, 57070, 97.5],
  ]);
  const units = rows.find(r => /Common Units/.test(r.investmentType));
  assert.equal(units.principal, 671414, 'the "par" column holds units here');
  assert.equal(units.fairValueMark, null, '6,714 / 671,414 units is not a 1% mark');
});

test('Onex Direct Lending — Medallia: whole-dollar figures and deeply marked-down loans (39% and 79% of par)', () => {
  const rows = extractCreditHoldings(load('onex_medallia'), 'Medallia', '2026-06-30');
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map(r => [r.principal, r.fairValue]),
    [
      [27420073, 10696571],
      [27476462, 21761358],
    ]
  );
  assert.ok(close(rows[0].fairValueMark, (10696571 / 27420073) * 100, 1e-9));
  assert.ok(close(rows[1].fairValueMark, (21761358 / 27476462) * 100, 1e-9));
  assert.ok(rows.every(r => r.maturityDate === '10/29/2028'));
});

test('Oaktree Specialty Lending — Pluralsight: a real ~5%-of-par tranche is kept as a mark, unfunded commitments are not holdings', () => {
  const rows = extractCreditHoldings(load('ocsl_pluralsight'), 'Pluralsight', '2026-06-30');
  const loans = rows.filter(r => /Term Loan/.test(r.investmentType));
  const distressed = loans.filter(r => r.fairValueMark !== null && r.fairValueMark < 10);
  assert.ok(distressed.length >= 3, 'the 7.50% second tranches marked at 5 cents');
  const first = rows[2];
  assert.deepEqual([first.principal, first.cost, first.fairValue], [16046, 14423, 802]);
  assert.ok(close(first.fairValueMark, (802 / 16046) * 100, 1e-9));
  assert.ok(
    !rows.some(r => r.principal === null && r.fairValue < 0),
    'negative-fair-value unfunded commitments are excluded'
  );
  const equity = rows.filter(r => r.investmentType === 'Common Stock');
  assert.ok(
    equity.length >= 2 && equity.every(r => r.fairValueMark === null),
    'common stock has a cost and value but no par-based mark'
  );
  assert.ok(
    rows.find(r => r.pik === '1.50%'),
    'PIK component read from its own column'
  );
});

// ── real header rows from 55 live BDC 10-Qs ────────────────────────────────

test('column mapper: every real BDC schedule header captured from live filings resolves company, principal, cost and fair value', () => {
  const REAL_HEADERS = [
    [
      'Portfolio Company(a)',
      'Footnotes',
      'Industry',
      'Rate(b)',
      'Floor(b)',
      'Maturity',
      'Principal Amount(c)/Shares',
      'Amortized Cost',
      'Fair Value(d)',
    ], // KKR FS Income Trust Select
    [
      'Portfolio Company',
      'Industry',
      'Type of Investment (1)(2)',
      'Index',
      'Spread',
      'Cash Interest Rate (3)(4)',
      'PIK',
      'Maturity Date',
      'Shares',
      'Principal(5)',
      'Cost',
      'Fair Value',
      'Notes',
    ], // Oaktree Gardens
    [
      'Portfolio Company (5)',
      'Investment Type',
      'Reference Rate and Spread (1)',
      'Maturity Date',
      'Principal / Shares',
      'Cost (2)',
      'Fair Value (3)',
      'Percent of Member’s Capital',
      'Footnotes',
    ], // Senior Credit Investments
    [
      'Company(1)',
      'Reference Rate and Spread(2)',
      'Interest Rate(2)',
      'Maturity Date',
      'Par Amount/Units',
      'Amortized Cost(3)',
      'Fair Value',
      'Percentage of Net Assets',
    ], // HPS Corporate Lending
    [
      'Investments (1)(19)',
      'Footnotes',
      'Reference Rate and Spread (2)',
      'Interest Rate (2)(15)',
      'Acquisition Date',
      'Maturity Date',
      'Par Amount/Units (1)',
      'Cost (3)',
      'Fair Value',
      '% of Net Assets',
    ], // Blackstone Secured Lending
    [
      'Portfolio Company (1) (20)',
      'Business Description',
      'Type of Investment (2) (3) (15)',
      'Investment Date (22)',
      'Shares/Units',
      'Total Rate',
      'Reference Rate and Spread (25)',
      'PIK Rate (19)',
      'Maturity Date',
      'Principal (4)',
      'Cost (4)',
      'Fair Value (18)',
    ], // Main Street
    [
      'Industry/Company',
      'Investment Type',
      'Interest Rate (12)',
      'Maturity Date',
      'Par/Shares (3)',
      'Cost (28)',
      'Fair Value (1)(29)',
    ], // Apollo Debt Solutions
    [
      'Company(1)(4)(6)(17)(23)',
      'Investment',
      'Interest',
      'Maturity Date',
      'Par / Units',
      'Amortized Cost(2)(3)',
      'Fair Value',
      'Percentage of Net Assets',
    ], // Blue Owl Technology Finance II
    [
      'Investments-non-controlled/non-affiliated (1)',
      'Footnotes',
      'Reference Rate and Spread',
      'Interest Rate (2)',
      'Maturity Date',
      'Par Amount/ Units',
      'Cost (3)',
      'Fair Value',
      '% of Net Assets',
    ], // OHA Senior Private Lending
    [
      'Portfolio Company, Location and Industry (1)',
      'Type of Investment',
      'Reference (6)',
      'Spread (6)',
      'Interest Rate (6)',
      'Acquisition Date',
      'Maturity/Expiration Date',
      'Principal Amount, Par Value or Shares',
      'Cost',
      'Fair Value',
      "Percent of Members' Capital",
    ], // New Mountain Guardian III
    [
      'Investments—non-controlled/non-affiliated (1)',
      'Footnotes',
      'Industry',
      'Reference Rate (2)',
      'Spread (2)',
      'Interest Rate (2)',
      'Acquisition Date',
      'Maturity Date',
      'Par/ Principal Amount **',
      'Amortized Cost (4)',
      'Fair Value (5)',
      '% of Net Assets',
    ], // Carlyle Secured Lending III
    [
      'Issuer',
      'Instrument',
      'Ref',
      'Floor',
      'Spread',
      'Total Coupon',
      'Maturity',
      'Principal',
      'Cost',
      'Fair Value',
      '% of Total Cash and Investments',
      'Notes',
    ], // BlackRock TCP
    [
      'Portfolio Company (k) (o)',
      'Industry',
      'Acquisition Date',
      'Investment Coupon Rate/ Maturity (i)',
      'Principal/ Numbers of Shares',
      'Amortized Cost',
      'Fair Value',
      '% of Net Assets (d)',
    ], // Franklin BSP
    [
      'Company (1)',
      'Investment',
      'Coupon (3)',
      'Reference (6)',
      'Spread (3)',
      'Acquisition Date',
      'Maturity Date',
      'Shares/ Units',
      'Principal',
      'Amortized Cost',
      'Fair Value',
      '% of Net Assets',
    ], // Ares Strategic Income
    [
      'Investments (a)',
      'Type',
      'Reference Rate and Spread (b)',
      'Interest Rate (b)',
      'Maturity Date',
      'Par Amount/ Units (c)',
      'Cost (d)',
      'Fair Value (e)',
      'Percentage of Net Assets',
    ], // Fidelity Private Credit
    [
      'Portfolio Company',
      'Industry',
      'Security(1)',
      'Notes',
      'Interest Rate(2)',
      'Initial Acquisition Date',
      'Maturity',
      'Par Amount / Quantity',
      'Cost',
      'Fair Value',
    ], // Great Elm
    [
      'Portfolio Company (1)',
      'Investment Type',
      'Reference Rate and Spread (2)',
      'Floor',
      'Interest Rate (2)',
      'Initial Acquisition Date',
      'Maturity Date',
      'Par/Shares',
      'Amortized Cost (3)',
      'Fair Value (4)',
      '% of Net Assets (17)',
      'Footnotes',
    ], // Onex
    [
      'Portfolio Company',
      'Industry',
      'Facility Type',
      'Interest',
      'Maturity',
      'FundedPar Amount',
      'Cost',
      'Fair Value',
    ], // AB Private Credit Investors
    [
      'Portfolio Company',
      'Type of Investment',
      'AcquisitionDate(12)',
      'OutstandingPrincipal',
      'Cost(6)',
      'Fair Value',
      'MaturityDate',
    ], // TriplePoint Venture Growth
    [
      'Investments (1),(2)',
      'Investment Type',
      'Reference Rate and Spread (3)',
      'All In Rate (3)',
      'AcquisitionDate',
      'MaturityDate',
      'Par ($) / Shares(4)',
      'Cost/Amortized Cost(5)',
      'Fair Value',
      'Percentageof Net Assets',
      'Footnotes',
    ], // AGL Private Credit Income
  ];
  for (const header of REAL_HEADERS) {
    const map = tryBuildCreditColumnMap(header);
    assert.ok(map, `no map for: ${header.join(' | ')}`);
    for (const f of ['portfolioCompany', 'principal', 'cost', 'fairValue']) {
      assert.notEqual(map[f], undefined, `${f} missing for: ${header.join(' | ')}`);
    }
  }
});

test('Blue Owl Technology Finance — Pluralsight: the unfunded delayed-draw commitment (cost 12,649, fair value -253) is not a holding; real marks of 37.5, 81.75 and 94.5 are kept', () => {
  const rows = extractCreditHoldings(load('otf_pluralsight'), 'Pluralsight', '2026-03-31');
  assert.ok(!rows.some(r => r.cost === 12649 || r.fairValue < 0), 'no unfunded-commitment row');
  const debt = rows.filter(r => /loan/i.test(r.investmentType));
  assert.deepEqual(
    debt.map(r => [r.principal, r.cost, r.fairValue, Math.round(r.fairValueMark * 100) / 100]),
    [
      [10293, 10293, 9726, 94.49],
      [36712, 34303, 13767, 37.5],
      [20585, 20585, 19453, 94.5],
      [30795, 30795, 30180, 98],
      [35340, 34303, 28890, 81.75],
    ]
  );
});
