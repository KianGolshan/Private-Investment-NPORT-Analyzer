// N-CSR cost pilot (docs/plans/ncsr-research.md): the HTML reader, the Fidelity and
// Capital Group restricted-table parsers, and the join to N-PORT holdings, on REAL
// filings trimmed by test/fixtures/ncsr/build-fixture.js:
//   0000707823-26-000042  Fidelity Mt. Vernon Street Trust N-CSRS 2026-05-31
//   0001193125-26-195253  Growth Fund of America N-CSRS 2026-02-28
//   0001193125-26-247125  SMALLCAP World Fund N-CSRS 2026-03-31
// and the warehouse's N-PORT rows for the same funds and dates (holdings.json).
//
// Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { htmlEvents, parseAmount, parseDateRange, parseLongDate, stripFootnotes } = require('../lib/ncsr/html');
const { parseNcsr, parseFidelity, parseCapitalGroup, securityName, parsePct, thousands } = require('../lib/ncsr/parse');
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
    /no "NET ASSETS - 100.0%"/
  );
  assert.throws(() => parseCapitalGroup('<div>nothing</div>'), /no "Investment portfolio/);
  const two = '<div>Investment portfolio May 31, 2026</div><div>Investment portfolio May 31, 2026</div>';
  assert.throws(() => parseCapitalGroup(two), /multi-fund/);
  const bad = read('0001193125-26-195253.html').replace('<td>8/29/2025</td>', '<td>8/29/2025</td><td>extra</td>');
  assert.throws(() => parseCapitalGroup(bad), /unreadable restricted row: Anthropic, PBC, Class F/);
  const noTotal = read('0001193125-26-195253.html').replace(/<tr><td>Total<\/td>.*?<\/tr>/, '');
  assert.throws(() => parseCapitalGroup(noTotal), /no "Total" row/);
  assert.throws(() => parseNcsr('', 'troweprice'), /unknown N-CSR family/);
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
