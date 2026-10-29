// N-CSR cost pilot (docs/plans/ncsr-research.md): the HTML reader, the Fidelity, Capital
// Group, T. Rowe Price and Morgan Stanley restricted-table parsers, and the join to N-PORT
// holdings, on REAL filings trimmed by test/fixtures/ncsr/build-fixture.js:
//   0000707823-26-000042  Fidelity Mt. Vernon Street Trust N-CSRS 2026-05-31
//   0001379491-21-003390  Fidelity Mt. Vernon Street Trust N-CSRS 2021-05-31 (older layout)
//   0001193125-26-195253  Growth Fund of America N-CSRS 2026-02-28
//   0000051931-22-001052  Growth Fund of America N-CSR 2022-08-31 (older layout)
//   0001193125-26-247125  SMALLCAP World Fund N-CSRS 2026-03-31
//   0001193125-26-062850  T. Rowe Price Science & Technology Fund N-CSR 2025-12-31
//   0001104659-26-104596  Morgan Stanley Institutional Fund N-CSRS 2026-06-30
// and the warehouse's N-PORT rows for the same funds and dates (holdings.json).
//
// Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { htmlEvents, parseAmount, parseDateRange, parseLongDate, stripFootnotes } = require('../lib/ncsr/html');
const {
  parseNcsr,
  parseFidelity,
  parseCapitalGroup,
  parseTRowePrice,
  parseMorganStanley,
  securityName,
  parsePct,
  thousands,
  joinCells,
} = require('../lib/ncsr/parse');
const { matchToNport, selfChecks, tolerance, isDebtName } = require('../lib/ncsr/match');
const { headerSeries, seriesFor, normName } = require('../scripts/ncsr-pilot');

const DIR = path.join(__dirname, 'fixtures', 'ncsr');
const read = f => fs.readFileSync(path.join(DIR, f), 'utf8');
const HOLDINGS = JSON.parse(read('holdings.json'));
const FID = parseFidelity(read('0000707823-26-000042.html'));
const GCO = FID.find(f => f.fundName === 'Fidelity Growth Company Fund');
const GSF = FID.find(f => f.fundName === 'Fidelity Growth Strategies Fund');
const [GFA] = parseCapitalGroup(read('0001193125-26-195253.html'));
const [SCW] = parseCapitalGroup(read('0001193125-26-247125.html'));
const byName = (rows, name) => rows.filter(r => r.name === name);
const one = (rows, name) => {
  const hits = byName(rows, name);
  assert.equal(hits.length, 1, `${name}: ${hits.length} rows`);
  return hits[0];
};

test('amounts, dates and names as filers print them', () => {
  assert.equal(parseAmount('1,315,269'), 1315269);
  assert.equal(parseAmount('$ 1,315,269'), 1315269);
  assert.equal(parseAmount('(380,306)'), -380306);
  assert.equal(parseAmount('$(380,306'), -380306); // Capital Group splits ")" into the next cell
  assert.equal(parseAmount('0'), 0);
  for (const s of ['', '—', '— (h)', '0.40 %', '9/17/2014', 'Shares', 'USD 25,314'])
    assert.equal(parseAmount(s), null, s);
  assert.deepEqual(parseDateRange('9/17/2014 - 6/5/2015'), { first: '2014-09-17', last: '2015-06-05' });
  assert.deepEqual(parseDateRange('1/27/2026-2/12/2026'), { first: '2026-01-27', last: '2026-02-12' });
  assert.deepEqual(parseDateRange('5/31/2024'), { first: '2024-05-31', last: '2024-05-31' });
  assert.equal(parseDateRange('2024-05-31'), null);
  assert.equal(parseLongDate('Consolidated Schedule of Investments May 31, 2026 (Unaudited)'), '2026-05-31');
  assert.equal(parseLongDate('Smarch 31, 2026'), null);
  assert.equal(
    stripFootnotes('Anthropic, PBC, Class G-1, preferred shares (a)(b)'),
    'Anthropic, PBC, Class G-1, preferred shares'
  );
  assert.equal(stripFootnotes('Adimab LLC (b)(d)(e)(g)'), 'Adimab LLC');
  assert.equal(
    stripFootnotes('Kardium Inc/US (US)'),
    'Kardium Inc/US (US)',
    'upper-case parentheses are part of a name'
  );
  assert.equal(
    securityName('Castle Creek Biosciences Inc Series A4 (b)(d)(e) (Cost $4,471,547)'),
    'Castle Creek Biosciences Inc Series A4'
  );
  assert.equal(parsePct('0.40 %'), 0.4);
  assert.equal(parsePct('0.00 (p)'), 0);
  assert.equal(parsePct('n/a'), null);
  assert.deepEqual(thousands('— (h)'), { amount: 0, belowUnit: true });
  assert.deepEqual(thousands('$ 97,662'), { amount: 97662, belowUnit: false });
  assert.equal(thousands('Total'), null);
});

test('the HTML reader keeps the filer cells of real markup', () => {
  const fid = htmlEvents(read('raw-fidelity.html')).map(e => e.cells);
  assert.deepEqual(fid[0], ['Additional information on each restricted holding is as follows:']);
  assert.deepEqual(fid[1], ['Security', 'Acquisition Date', 'Acquisition Cost ($)']);
  assert.deepEqual(fid[2], ['Adimab LLC', '9/17/2014 - 6/5/2015', '8,796,986']);
  assert.equal(fid.length, 3, 'a spacer row with only non-breaking spaces is no row');
  const cap = htmlEvents(read('raw-capital.html')).map(e => e.cells);
  assert.deepEqual(cap[0], [
    'Anthropic, PBC, Class G-1, preferred shares (a)(b)',
    '1/27/2026-2/12/2026',
    '$ 1,315,269',
    '$ 1,315,269',
    '0.40 %',
  ]);
  assert.deepEqual(htmlEvents('<p>a &amp; b&#160;&#x41;</p><table><tr><td> </td></tr></table>tail'), [
    { type: 'text', text: 'a & b A' },
    { type: 'text', text: 'tail' },
  ]);
});

test('Fidelity: each fund section, its cost table and the stated restricted total', () => {
  assert.deepEqual(FID.map(f => f.fundName).sort(), [
    'Fidelity Growth Company Fund',
    'Fidelity Growth Strategies Fund',
  ]);
  assert.equal(GCO.periodEnd, '2026-05-31');
  assert.equal(GCO.unit, 1);
  assert.equal(GCO.netAssets, 99453200356);
  assert.equal(GCO.restricted.length, 234);
  assert.equal(
    GCO.restricted.reduce((s, r) => s + r.cost, 0),
    1889000686
  );
  assert.deepEqual(GCO.restrictedTotal, { mark: 'e', value: 5236869962, pctNav: 5.3 });
  assert.deepEqual(one(GCO.restricted, 'Anthropic PBC Series D'), {
    rawName: 'Anthropic PBC Series D',
    name: 'Anthropic PBC Series D',
    acquiredFirst: '2024-05-31',
    acquiredLast: '2024-05-31',
    cost: 7055558,
    costUnit: 1,
    value: null,
    belowUnit: false,
    pctNav: null,
  });
  assert.equal(one(GCO.restricted, 'Fanatics Inc Class A').acquiredFirst, '2020-08-13');
  assert.equal(one(GCO.restricted, 'Fanatics Inc Class A').acquiredLast, '2022-10-24');
  assert.equal(GSF.restricted.length, 4);
  for (const f of FID) for (const c of selfChecks(f)) assert.ok(c.ok, `${f.fundName}: ${c.check} (${c.detail})`);
});

test('Capital Group: thousands, the continued table, page footers and the Total row', () => {
  assert.equal(GFA.periodEnd, '2026-02-28');
  assert.equal(GFA.unit, 1000);
  assert.equal(GFA.fundName, null, 'one fund per filing: the header names the series');
  assert.equal(GFA.netAssets, 328183657000);
  assert.equal(GFA.restricted.length, 29);
  assert.deepEqual(GFA.restrictedTotal, { mark: 'c', cost: 3487933000, value: 4885723000, pctNav: 1.49 });
  const g1 = one(GFA.restricted, 'Anthropic, PBC, Class G-1, preferred shares');
  assert.deepEqual(
    [g1.acquiredFirst, g1.acquiredLast, g1.cost, g1.value, g1.pctNav],
    ['2026-01-27', '2026-02-12', 1315269000, 1315269000, 0.4]
  );
  assert.equal(
    one(GFA.restricted, 'Crusoe Inc, Series E, preferred shares').cost,
    97662000,
    'first row after "(continued)"'
  );
  // SMALLCAP World: "— (h)" amounts, a principal in thousands with its currency, "21 | <fund>" footers
  const kandou = one(SCW.restricted, 'Kandou Holding SA, warrants, expire 8/18/2028');
  assert.deepEqual([kandou.cost, kandou.value, kandou.belowUnit], [0, 0, true]);
  const payclip = one(SCW.schedule, 'PayClip, Inc., convertible notes, 4.50% Cash 12/15/2028');
  assert.deepEqual([payclip.shares, payclip.value], [25314000, 33414000]);
  for (const f of [GFA, SCW]) for (const c of selfChecks(f)) assert.ok(c.ok, `${c.check} (${c.detail})`);
});

test('self-checks fail when a row is dropped or misread', () => {
  const dropped = { ...GCO, restricted: GCO.restricted.slice(1) };
  assert.ok(selfChecks(dropped).some(c => !c.ok && /rows in schedule/.test(c.check)));
  const k = GCO.schedule.findIndex(r => r.marks.includes('e'));
  const unmarked = { ...GCO, schedule: GCO.schedule.map((r, i) => (i === k ? { ...r, marks: [] } : r)) };
  assert.ok(selfChecks(unmarked).some(c => !c.ok && /stated restricted total/.test(c.check)));
  const cost = { ...GFA, restricted: GFA.restricted.map((r, i) => (i ? r : { ...r, cost: r.cost + 500000 })) };
  assert.ok(selfChecks(cost).some(c => !c.ok && /Total row/.test(c.check)));
  // no restricted table: fine when the filing states none, a failure when rows exist without a total
  assert.ok(selfChecks({ ...GSF, restricted: [], restrictedTotal: null }).every(c => c.ok));
  assert.ok(selfChecks({ ...GSF, restrictedTotal: null }).some(c => !c.ok));
});

test('parsers fail loudly on layouts they cannot read', () => {
  assert.throws(() => parseFidelity('<div>Annual report</div>'), /no "Schedule of Investments"/);
  assert.throws(
    () =>
      parseFidelity(
        '<div>Fidelity X Fund</div><div>Schedule of Investments May 31, 2026</div><table><tr><td>A</td><td>1</td><td>2</td></tr></table>'
      ),
    /no "NET ASSETS - 100%"/
  );
  assert.throws(() => parseCapitalGroup('<div>nothing</div>'), /no "Investment portfolio/);
  const two = '<div>Investment portfolio May 31, 2026</div><div>Investment portfolio May 31, 2026</div>';
  assert.throws(() => parseCapitalGroup(two), /multi-fund/);
  const bad = read('0001193125-26-195253.html').replace('<td>8/29/2025</td>', '<td>8/29/2025</td><td>extra</td>');
  assert.throws(() => parseCapitalGroup(bad), /unreadable restricted row: Anthropic, PBC, Class F/);
  const noTotal = read('0001193125-26-195253.html').replace(/<tr><td>Total<\/td>.*?<\/tr>/, '');
  assert.throws(() => parseCapitalGroup(noTotal), /no "Total" row/);
  assert.throws(() => parseNcsr('', 'baron'), /unknown N-CSR family/);
});

test('join to N-PORT: by shares and value, legs, holding vehicles, value differences, debt', () => {
  const gco = matchToNport(GCO, HOLDINGS['0000035402-26-004656']);
  const r = name => one(gco, name);
  const d = r('Anthropic PBC Series D');
  assert.deepEqual(
    [d.match, d.shares, d.value, d.nportValue, d.companyName],
    ['exact', 235150, 146484341, 146484341, 'Anthropic']
  );
  assert.equal(d.costPerShare.toFixed(2), '30.00');
  assert.equal(r('Databricks Inc Series J').costPerShare.toFixed(2), '92.50');
  assert.equal(r('Anthropic PBC Series F').costPerShare.toFixed(2), '140.97');
  // a date range is a blend of lots: no entry price
  assert.equal(r('Fanatics Inc Class A').costPerShare, null);
  // two N-CSR lines = one N-PORT holding vehicle (GROWTHCO TB HOLDINGS LLC: 1,275,683.805 sh, $41,714,860)
  for (const name of ['Tory Burch LLC Class A', 'Tory Burch LLC Class B']) {
    assert.equal(r(name).match, 'combined');
    assert.equal(r(name).nport[0].issuer_name, 'GROWTHCO TB HOLDINGS LLC');
  }
  // one N-CSR line = 11 N-PORT CVR lines of 7,200 sh
  const tub = r('Tubulis GmbH rights');
  assert.equal(tub.match, 'legs');
  assert.equal(tub.nport.length, 11);
  assert.equal(tub.nportValue, 2603016);
  // same shares, another value at the same date (N-PORT 0000035402-26-004656: $11,734,528)
  const par = r('Parabilis Medicines Inc Series F');
  assert.deepEqual([par.match, par.value, par.nportValue, par.companyId], ['value', 30700801, 11734528, null]);
  // a name printed twice pairs by order, which the filing does not prove
  for (const a of byName(gco, 'Adimab LLC'))
    assert.deepEqual([a.match, a.pairedByOrder, a.costPerShare], ['ambiguous', true, null]);
  // two N-PORT rows with the same shares and value: not picked
  assert.equal(r('Element Biosciences Inc Series D').match, 'ambiguous');
  assert.equal(r('Neutron Holdings Inc 4% 5/22/2027').match, 'debt');
  // no N-PORT row joined twice (only the rows of one holding vehicle share it)
  const keys = gco.filter(x => x.match === 'exact' || x.match === 'legs').flatMap(x => x.nport.map(h => h.row_key));
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(!keys.includes(r('Tory Burch LLC Class A').nport[0].row_key));

  const gfa = matchToNport(GFA, HOLDINGS['0001193125-26-182055']);
  const stripe = one(gfa, 'Stripe, LLC, Class B');
  assert.equal(stripe.match, 'legs', 'PHYSICAL + DRS custody legs');
  assert.deepEqual(
    stripe.nport.map(h => h.balance).sort((a, b) => a - b),
    [30538, 1123404]
  );
  // the same round price at another manager (Fidelity Growth Company Fund above)
  assert.equal(one(gfa, 'Databricks, Inc., Series J, preferred shares').costPerShare.toFixed(2), '92.50');
  assert.equal(one(gfa, 'Anthropic, PBC, Class F, preferred shares').costPerShare.toFixed(2), '140.97');
  assert.equal(one(gfa, 'Epic Games, Inc.').valueToCost.toFixed(3), '0.596');

  // thousands that sit up to $999 from N-PORT still join (PsiQuantum E: 49,993 vs $49,992,421)
  const scw = matchToNport(SCW, HOLDINGS['0001193125-26-243462']);
  assert.equal(one(scw, 'PsiQuantum Corp., Series E, preferred shares').match, 'exact');
  assert.equal(one(scw, 'PayClip, Inc., convertible notes, 4.50% Cash 12/15/2028').match, 'debt');
});

test('the join reads numbers, not names: a renamed N-PORT row still joins, a changed value does not', () => {
  const holdings = HOLDINGS['0000035402-26-004656'].map(h =>
    h.title.startsWith('ANTHROPIC PBC SERIES D') ? { ...h, issuer_name: 'SOMETHING ELSE', title: 'X' } : h
  );
  assert.equal(one(matchToNport(GCO, holdings), 'Anthropic PBC Series D').match, 'exact');
  const moved = HOLDINGS['0000035402-26-004656'].map(h =>
    h.title.startsWith('ANTHROPIC PBC SERIES D') ? { ...h, value_usd: h.value_usd + 3 } : h
  );
  assert.equal(one(matchToNport(GCO, moved), 'Anthropic PBC Series D').match, 'value');
  assert.equal(one(matchToNport(GCO, []), 'Anthropic PBC Series D').match, 'none');
  assert.ok(matchToNport({ ...GCO, restricted: [] }, holdings).length === 0);
});

test('helpers: tolerance, debt names, filing-header series and fund names', () => {
  assert.equal(tolerance(1), 1.5);
  assert.equal(tolerance(1000), 1001);
  for (const n of [
    'Neutron Holdings Inc 4% 5/22/2027',
    'Enevate Corp 6%',
    'Evozyne Inc 6% 9/13/2028 pay-in-kind',
    'PayClip, Inc., convertible notes, 4.50% Cash 12/15/2028',
  ])
    assert.ok(isDebtName(n), n);
  for (const n of [
    'Stripe, LLC, Series I, 6.00% noncumulative preferred shares',
    'Anthropic PBC Series F',
    'Long Wall Co., Class A-9, noncumulative convertible preferred shares',
  ])
    assert.ok(!isDebtName(n), n);
  const header =
    '<pre>&lt;SERIES&gt;\n&lt;OWNER-CIK&gt;0000707823\n&lt;SERIES-ID&gt;S000007119\n&lt;SERIES-NAME&gt;Fidelity Growth Company Fund\n&lt;SERIES-ID&gt;S000007118\n&lt;SERIES-NAME&gt;Fidelity Growth Strategies Fund\n</pre>';
  const series = headerSeries(header);
  assert.deepEqual(series, [
    { seriesId: 'S000007119', name: 'Fidelity Growth Company Fund' },
    { seriesId: 'S000007118', name: 'Fidelity Growth Strategies Fund' },
  ]);
  assert.equal(seriesFor(GCO, series).seriesId, 'S000007119');
  assert.equal(seriesFor({ fundName: 'Fidelity Growth Company K6 Fund' }, series), null, 'no near-name guess');
  assert.equal(seriesFor(GFA, [{ seriesId: 'S000009228', name: 'GROWTH FUND OF AMERICA' }]).seriesId, 'S000009228');
  assert.equal(seriesFor(GFA, series), null, 'a single-fund parse needs a single-series filing');
  assert.equal(normName('The Growth Fund of America ®'), 'growth fund of america');
});

test('older layouts: Fidelity 2021 (thousands, issuer lines, paragraph footnotes, two-digit years)', () => {
  const [nmf] = parseFidelity(read('0001379491-21-003390.html'));
  assert.equal(nmf.fundName, 'Fidelity New Millennium Fund', 'the name from the report cover');
  assert.deepEqual([nmf.periodEnd, nmf.unit, nmf.netAssets], ['2021-05-31', 1000, 2841675000]);
  assert.deepEqual(nmf.restrictedTotal, { mark: 'd', value: 95498000, pctNav: 3.4 });
  assert.equal(nmf.restricted.length, 20);
  // "Allbirds, Inc.:" on its own line, then "Series A (a)(d)(e) | 8,775 | 95"
  assert.deepEqual(
    [one(nmf.schedule, 'Allbirds, Inc. Series A').shares, one(nmf.schedule, 'Allbirds, Inc. Series A').value],
    [8775, 95000]
  );
  const a = one(nmf.restricted, 'Allbirds, Inc. Series A');
  assert.deepEqual([a.acquiredFirst, a.cost, a.costUnit], ['2018-10-09', 96000, 1000], '"10/9/18", "$96" in (000s)');
  // a long name over two lines: "(Cost $8,368) | 8,367,654 | 3,715"
  assert.equal(one(nmf.schedule, 'Utica Shale Drilling Program (non-operating revenue interest)').value, 3715000);
  for (const c of selfChecks(nmf)) assert.ok(c.ok, `${c.check} (${c.detail})`);
  const res = matchToNport(nmf, HOLDINGS['0001752724-21-152583']);
  assert.equal(res.filter(r => r.match === 'exact').length, 17, 'thousands join within one unit');
  assert.deepEqual(parseDateRange('9/17/14 - 6/05/15'), { first: '2014-09-17', last: '2015-06-05' });
  assert.deepEqual(parseDateRange('12/21/98'), { first: '1998-12-21', last: '1998-12-21' });
});

test('older layouts: Capital Group 2022 (numeric marks, split cells, a header over three rows)', () => {
  assert.deepEqual(joinCells(['A', '$', '142,918', '$', '(16,465', ')', '.06', '%']), [
    'A',
    '$ 142,918',
    '$ (16,465)',
    '.06 %',
  ]);
  const [gfa] = parseCapitalGroup(read('0000051931-22-001052.html'));
  assert.equal(gfa.periodEnd, '2022-08-31');
  assert.deepEqual(gfa.restrictedTotal, { mark: '6', cost: 785823000, value: 604547000, pctNav: 0.28 });
  const w = one(gfa.restricted, 'Waymo, LLC, Series A-2, 8.00% noncumulative preferred shares');
  assert.deepEqual([w.cost, w.value, w.pctNav], [100000000, 106818000, 0.05], '"1,2,5" marks dropped, ".05 | %" read');
  for (const c of selfChecks(gfa)) assert.ok(c.ok, `${c.check} (${c.detail})`);
  const res = matchToNport(gfa, HOLDINGS['0001145549-22-063355']);
  assert.deepEqual(
    res.reduce((m, r) => ({ ...m, [r.match]: (m[r.match] || 0) + 1 }), {}),
    { exact: 13, debt: 1 }
  );
  assert.equal(securityName('Stripe, Inc., Class B 1,4', true), 'Stripe, Inc., Class B');
  assert.equal(securityName('TAE Technologies, Series 11', false), 'TAE Technologies, Series 11');
  assert.equal(parsePct('.00 16'), 0);
  assert.deepEqual(thousands('— 9'), { amount: 0, belowUnit: true });
});

test('T. Rowe Price: costs inline in positioned text, checked against the stated total', () => {
  const [st] = parseTRowePrice(read('0001193125-26-062850.html'));
  assert.deepEqual([st.periodEnd, st.unit, st.netAssets], ['2025-12-31', 1000, 11912426000]);
  assert.deepEqual(st.restrictedTotal, { mark: '3', value: 370822000, pctNav: 3.1 });
  assert.equal(st.restricted.length, 32);
  // "Cost $ (1)(2)(3)": rights received at no cost
  const rights = one(st.restricted, 'Hadrian Automation, Rights, 12/19/26');
  assert.deepEqual([rights.cost, rights.value, rights.shares], [0, 2366000, 793223]);
  // "7,289 " with a blank value; the cost in dollars for a rupee security
  const tl = one(st.restricted, 'Think & Learn');
  assert.deepEqual([tl.cost, tl.value, tl.currency], [11621000, 0, 'INR']);
  for (const c of selfChecks(st)) assert.ok(c.ok, `${c.check} (${c.detail})`);
  const res = matchToNport(st, HOLDINGS['0001099263-26-002527']);
  assert.equal(res.filter(r => r.match === 'exact').length, 32);
  // dropping one line breaks the stated total
  assert.ok(selfChecks({ ...st, restricted: st.restricted.slice(1), schedule: st.schedule.slice(1) }).some(c => !c.ok));
  assert.throws(() => parseTRowePrice('<div>Annual report</div>'), /no "Statement of Assets and Liabilities/);
});

test('Morgan Stanley: one filing, many portfolios; the cost in the name cell', () => {
  const funds = parseMorganStanley(read('0001104659-26-104596.html'));
  const growth = funds.find(f => f.fundName === 'Growth Portfolio');
  const inception = funds.find(f => f.fundName === 'Inception Portfolio');
  assert.deepEqual([growth.periodEnd, growth.unit, growth.netAssets], ['2026-06-30', 1000, 3589221000]);
  const d = one(growth.restricted, 'Databricks, Inc., Series H');
  assert.deepEqual([d.acquiredFirst, d.cost, d.shares, d.value], ['2021-08-31', 63187000, 859870, 161269000]);
  const g = matchToNport(growth, HOLDINGS['0001410368-26-084089']);
  // the same entry price as Fidelity's Series H (golden F69)
  assert.equal(one(g, 'Databricks, Inc., Series H').costPerShare.toFixed(2), '73.48');
  assert.equal(one(g, 'Stripe, Inc., Series I').costPerShare.toFixed(2), '20.13');
  // two restricted rows print no cost (Infleqtion, SomaLogic warrants): reported as a note, not a failure
  const count = selfChecks(inception).find(c => /rows in schedule/.test(c.check));
  assert.deepEqual([count.ok, count.severity], [false, 'note']);
  assert.equal(matchToNport(inception, HOLDINGS['0001410368-26-084068']).filter(r => r.match === 'exact').length, 2);
});

test('fail closed: a cost table the parser cannot find is an error, never "no restricted holdings"', () => {
  // Capital Group: SMALLCAP World 2022-03-31 titled its table "Private placement securities 4"; an unknown
  // title with the known header row must fail, not return an empty table
  const cap = h =>
    `<div>Investment portfolio March 31, 2022</div><table><tr><td>Acme, Inc. 4</td><td>10</td><td>5</td></tr>` +
    `<tr><td>Net assets 100.00%</td><td>$ 100</td></tr></table><div>${h}</div><table>` +
    `<tr><td>Acquisition date(s)</td><td>Cost (000)</td><td>Value (000)</td><td>Percent of net assets</td></tr>` +
    `<tr><td>Acme, Inc.</td><td>3/9/2021</td><td>4</td><td>5</td><td>.01</td></tr>` +
    `<tr><td>Total</td><td>$ 4</td><td>$ 5</td><td>.01 %</td></tr></table>`;
  assert.equal(parseCapitalGroup(cap('Private placement securities 4'))[0].restricted.length, 1);
  assert.equal(parseCapitalGroup(cap('Restricted securities 4'))[0].restrictedTotal.mark, '4');
  assert.throws(() => parseCapitalGroup(cap('Securities with restrictions')), /without a heading this parser reads/);
  // the heading as a one-cell row (Growth Fund of America 2023-02-28 read as empty before)
  const asRow = cap('').replace('<div></div><table>', '<table><tr><td>Restricted securities 5</td></tr>');
  assert.equal(parseCapitalGroup(asRow)[0].restricted.length, 1);
  // Fidelity: a stated restricted total with no cost table
  const fid =
    '<div>Fidelity X Fund</div><div>Semi-Annual Report</div><div>Schedule of Investments May 31, 2026</div>' +
    '<table><tr><td>Acme (e)</td><td>10</td><td>5</td></tr><tr><td>NET ASSETS - 100.0%</td><td>100</td></tr>' +
    '<tr><td>(e)</td><td>Restricted securities (including private placements) - Investment in securities not ' +
    'registered under the Securities Act of 1933 (excluding 144A issues). At the end of the period, the value of ' +
    'restricted securities (excluding 144A issues) amounted to $5 or 5.0% of net assets.</td></tr></table>';
  assert.throws(() => parseFidelity(fid), /restricted securities stated but no cost table found/);
});

test('Capital Group cell variants: en dashes, side-column sector labels, names over two rows', () => {
  assert.deepEqual(thousands('– 6'), { amount: 0, belowUnit: true });
  const doc =
    '<div>Investment portfolio September 30, 2024</div><table>' +
    '<tr><td>Industrials</td><td>Relativity Space, Inc., Series D, preferred shares 2,4,5</td><td>2,143,751</td><td>48,599</td></tr>' +
    '<tr><td>0.18%</td><td>Relativity Space, Inc., Series E, preferred shares 2,4,5</td><td>464,197</td><td>10,523</td></tr>' +
    '<tr><td>Candid Therapeutics, Inc., Class B, noncumulative convertible preferred shares 5</td><td>1</td><td>20,000</td></tr>' +
    '<tr><td>Net assets 100.00%</td><td>$ 77,077,041</td></tr></table><div>Restricted securities 5</div><table>' +
    '<tr><td>Acquisition date(s)</td><td>Cost (000)</td><td>Value (000)</td><td>Percent of net assets</td></tr>' +
    '<tr><td>Relativity Space, Inc., Series D, preferred shares 2,4</td><td>11/20/2020</td><td>$ 32,000</td><td>$ 48,599</td><td>.06 %</td></tr>' +
    '<tr><td>Relativity Space, Inc., Series E, preferred shares 2,4</td><td>5/27/2021</td><td>10,600</td><td>10,523</td><td>.02</td></tr>' +
    '<tr><td>Candid Therapeutics, Inc., Class B,</td></tr>' +
    '<tr><td>noncumulative convertible preferred shares 4</td><td>8/27/2024</td><td>20,000</td><td>20,000</td><td>.03</td></tr>' +
    '<tr><td>Total</td><td>$ 62,600</td><td>$ 79,122</td><td>.11 %</td></tr></table>';
  const [f] = parseCapitalGroup(doc);
  assert.deepEqual(
    f.schedule.map(r => [r.name, r.shares]),
    [
      ['Relativity Space, Inc., Series D, preferred shares', 2143751],
      ['Relativity Space, Inc., Series E, preferred shares', 464197],
      ['Candid Therapeutics, Inc., Class B, noncumulative convertible preferred shares', 1],
    ]
  );
  assert.equal(f.restricted[2].name, 'Candid Therapeutics, Inc., Class B, noncumulative convertible preferred shares');
  for (const c of selfChecks(f)) assert.ok(c.ok, `${c.check} (${c.detail})`);
});
