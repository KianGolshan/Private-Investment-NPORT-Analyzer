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
//   0000754510-26-000028  Fidelity Blue Chip Growth N-CSRS 2026-01-31 (lines set apart: outside the total)
//   0000707823-25-000029  Fidelity Growth Company N-CSRS 2024-11-30 (lines set apart: a name printed twice)
//   0001193125-23-046133  T. Rowe Price Small-Cap Stock N-CSR 2022-12-31 (no U+200C in the portfolio)
//   0001193125-26-062880  T. Rowe Price Small-Cap Stock N-CSR 2025-12-31 (the same, a blank value cell)
//   0001193125-26-062863  T. Rowe Price Dynamic Credit N-CSR 2025-12-31 (bonds, "†" value-only lines)
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
const {
  matchToNport,
  selfChecks,
  setApart,
  refusal,
  tolerance,
  isDebtName,
  pairWithSchedule,
} = require('../lib/ncsr/match');
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
  // a cost line missing: its name is set apart (never admitted) and the rest still proves out
  // against the totals; four names missing fail the report
  const dropped = { ...GCO, restricted: GCO.restricted.slice(1) };
  assert.deepEqual([...selfChecks(dropped).setApart.keys()], [GCO.restricted[0].name]);
  const names = [...new Set(GCO.restricted.map(r => r.name))].slice(0, 4);
  const four = { ...GCO, restricted: GCO.restricted.filter(r => !names.includes(r.name)) };
  assert.ok(selfChecks(four).some(c => !c.ok && /rows in schedule/.test(c.check)));
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
  assert.throws(() => parseCapitalGroup(two), /no fund name above the investment portfolio/);
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
  // real naming gaps from the backfill (2026-11-06): the header escapes names; ℠; VIP prefixes
  const fid = headerSeries(
    '<pre>&lt;SERIES-ID&gt;S000000001\n&lt;SERIES-NAME&gt;Fidelity Capital &amp; Income Fund\n' +
      '&lt;SERIES-ID&gt;S000000002\n&lt;SERIES-NAME&gt;Fidelity Women&#39;s Leadership Fund\n' +
      '&lt;SERIES-ID&gt;S000000003\n&lt;SERIES-NAME&gt;International Index Portfolio\n' +
      '&lt;SERIES-ID&gt;S000000004\n&lt;SERIES-NAME&gt;Freedom 2065 Portfolio\n</pre>'
  );
  const id = name => (seriesFor({ fundName: name }, fid) || {}).seriesId || null;
  assert.equal(id('Fidelity Capital & Income Fund'), 'S000000001');
  assert.equal(id('Fidelity Women’s Leadership Fund'), 'S000000002');
  assert.equal(id('VIP International Index Portfolio'), 'S000000003');
  assert.equal(id('VIP Freedom 2065 Portfolio℠'), 'S000000004');
  assert.equal(id('VIP Index 500 Portfolio'), null, 'not in the header: no guess');
  const twice = [...fid, { seriesId: 'S000000005', name: 'VIP International Index Portfolio' }];
  assert.equal(
    seriesFor({ fundName: 'Fidelity International Index Portfolio' }, twice),
    null,
    'two loose matches: none'
  );
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
  // no restricted holdings at all (T. Rowe Price's ETFs): no fund report with a cost, not an error
  assert.deepEqual(
    parseTRowePrice('<div>Annual report</div><table><tr><td>NET ASSETS</td><td>$17,090</td></tr></table>'),
    []
  );
  // nothing in the text at all (a report printed as images): an error, never "none"
  assert.throws(() => parseTRowePrice('<div>Annual report</div><div>T. Rowe Price</div>'), /no statements in the text/);
  // a restricted marker without the statement this parser reads: still an error
  assert.throws(
    () => parseTRowePrice('<div>Think &amp; Learn, Acquisition Date: 12/23/20, Cost $44,697</div>'),
    /no "Statement of Assets and Liabilities/
  );
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

test('Fidelity SAI funds: the distribution notice between the name and "Annual Report" is not the name', () => {
  const doc =
    '<div>Fidelity SAI International Index Fund</div>' +
    '<div>Offered exclusively to certain clients of the Adviser or its affiliates - not available for sale to the ' +
    'general public. Fidelity SAI is a product name of Fidelity funds dedicated to certain programs affiliated with ' +
    'Strategic Advisers LLC.</div><div>Annual Report</div><div>October 31, 2025</div>' +
    '<div>Schedule of Investments October 31, 2025</div>' +
    '<table><tr><td>Acme Corp.</td><td>10</td><td>5</td></tr><tr><td>NET ASSETS - 100.0%</td><td>100</td></tr></table>';
  assert.equal(parseFidelity(doc)[0].fundName, 'Fidelity SAI International Index Fund');
});

test('Capital Group multi-fund report (American Funds Insurance Series): one section per portfolio', () => {
  const funds = parseCapitalGroup(read('0001193125-26-383201.html'));
  assert.deepEqual(
    funds.map(f => [f.fundName, f.periodEnd, f.restricted.length]),
    [
      ['Global Growth Fund', '2026-06-30', 0],
      ['Growth Fund', '2026-06-30', 16],
    ]
  );
  const series = headerSeries(read('headers/0001193125-26-383201.html'));
  assert.equal(series.length, 24, 'the header names all 24 portfolios');
  assert.deepEqual(
    funds.map(f => seriesFor(f, series).seriesId),
    ['S000008786', 'S000008791']
  );
  for (const f of funds) for (const c of selfChecks(f)) assert.ok(c.ok, `${f.fundName}: ${c.check} (${c.detail})`);
  const res = matchToNport(funds[1], HOLDINGS['0001193125-26-371320']);
  assert.ok(res.filter(r => r.match === 'exact').length >= 10, 'Growth Fund lines join its N-PORT');
  // a section without its fund's name above the heading: an error, never a guess
  assert.throws(
    () =>
      parseCapitalGroup('<div>Investment portfolio June 30, 2026</div><div>Investment portfolio June 30, 2026</div>'),
    /no fund name above the investment portfolio/
  );
});

test('lines set apart: a fund report whose checks fail only because of named lines', () => {
  // Blue Chip Growth 2026-01-31: the marked rows exceed the stated total ($4,538,027,674) by
  // $34,377,795, exactly Trade Republic ($18,326,022) + Chobani ($16,051,773), bought Oct and
  // Dec 2025; no other row or pair fits. Every other line passes every check.
  const bc = parseFidelity(read('0000754510-26-000028.html')).find(
    f => f.fundName === 'Fidelity Blue Chip Growth Fund'
  );
  const checks = selfChecks(bc);
  for (const c of checks) assert.ok(c.ok, `${c.check} (${c.detail})`);
  assert.deepEqual([...checks.setApart.keys()].sort(), ['Chobani Inc Class A', 'Trade Republic Bank GmbH']);
  assert.match(checks.at(-1).before[0], /4572405469 vs 4538027674/);
  assert.deepEqual(
    checks.filter(c => c.check !== 'lines set apart (not admitted)').map(c => [c.check, c.detail]),
    [
      ['restricted rows in schedule = rows in cost table', '137 marked (d) vs 137 cost rows'],
      ['marked schedule value = stated restricted total', '4538027674 vs 4538027674'],
    ]
  );
  // a set-apart line is refused whatever its join; the others go on to the line-level rule
  const chobani = { ...one(bc.restricted, 'Chobani Inc Class A'), match: 'exact', nport: [] };
  assert.equal(refusal(chobani, { fundOk: true, unit: 1, setApart: checks.setApart }), 'set apart');
  const other = { ...bc.restricted.find(r => !checks.setApart.has(r.name)), match: 'none', nport: [] };
  assert.equal(refusal(other, { fundOk: true, unit: 1, setApart: checks.setApart }), 'none');
  // counterexamples: a shortfall (a restricted row not read) is never set apart; neither is a gap two
  // different pairings explain, nor a report with more than three names
  const marked = bc.schedule.filter(r => r.marks.includes('d'));
  const dropped = marked.find(r => !checks.setApart.has(r.name) && r.value > 1e6);
  const short = {
    ...bc,
    schedule: bc.schedule.filter(r => r !== dropped),
    restricted: bc.restricted.filter(r => r.name !== dropped.name),
  };
  assert.equal(setApart(short), null);
  assert.ok(selfChecks(short).some(c => !c.ok));
  const twin = { ...dropped, name: 'Twin of a set-apart pair', value: 18326022 + 16051773 };
  const both = { ...bc, schedule: [...bc.schedule, twin], restrictedTotal: { ...bc.restrictedTotal } };
  assert.equal(setApart(both), null, 'two pairings fit: nothing is set apart');
  const many = { ...bc, restricted: bc.restricted.filter(r => !/^(?:Stripe|Databricks|Anthropic|xAI)/.test(r.name)) };
  assert.ok(
    new Set(bc.restricted.filter(r => /^(?:Stripe|Databricks|Anthropic|xAI)/.test(r.name)).map(r => r.name)).size > 3
  );
  assert.equal(setApart(many), null);

  // Growth Company 2024-11-30: "DNA Script" twice in the schedule, once in the cost table; the marked
  // total still adds up. That name's line is set apart; the class lines under "Agomab Therapeutics SA:"
  // ("warrants 10/10/33") read as the cost table names them.
  const gc = parseFidelity(read('0000707823-25-000029.html')).find(f => f.fundName === 'Fidelity Growth Company Fund');
  const g = selfChecks(gc);
  for (const c of g) assert.ok(c.ok, `${c.check} (${c.detail})`);
  assert.deepEqual([...g.setApart.keys()], ['DNA Script']);
  assert.ok(g.setApart.get('DNA Script').startsWith('printed a different number of times'));
  assert.equal(byName(gc.schedule, 'DNA Script').length, 2);
  assert.equal(one(gc.restricted, 'DNA Script').cost, 1788000);
  for (const n of ['Agomab Therapeutics SA warrants 10/10/33', 'Agomab Therapeutics SA warrants 11/4/34'])
    assert.equal(one(gc.schedule, n).shares, 10);
  // the same report with every line in place reads exactly as before: nothing set apart
  assert.equal(selfChecks(GCO).setApart, undefined);
});

test('T. Rowe Price before 2024: amounts in positioned <div>s, read only when they add up', () => {
  // Small-Cap Stock 2022-12-31: no U+200C in the portfolio. The plain reading finds no line; the
  // marked one finds 62, adding up exactly to the stated $450,903 (000s)
  const [sc] = parseTRowePrice(read('0001193125-23-046133.html'));
  assert.deepEqual([sc.periodEnd, sc.netAssets], ['2022-12-31', 8417931000]);
  assert.deepEqual(sc.restrictedTotal, { mark: '2', value: 450903000, pctNav: 5.4 });
  assert.equal(sc.restricted.length, 62);
  for (const c of selfChecks(sc)) assert.ok(c.ok, `${c.check} (${c.detail})`);
  const torchys = one(sc.restricted, 'Torchys Holdings, Class A');
  assert.deepEqual(
    [torchys.acquiredFirst, torchys.cost, torchys.shares, torchys.value],
    ['2020-11-13', 33027000, 3862836, 15490000]
  );
  // "Cost $—": received at no cost
  const rover = one(sc.restricted, 'Rover Group, Earn Out Shares $16.00');
  assert.deepEqual([rover.cost, rover.shares, rover.value], [0, 773380, 15000]);
  // Small-Cap Stock 2025-12-31: a blank value cell on the line ("568,149 | ") is an empty value
  const [x] = parseTRowePrice(read('0001193125-26-062880.html'));
  for (const c of selfChecks(x)) assert.ok(c.ok, `${c.check} (${c.detail})`);
  assert.equal(x.restricted.length, 42);
  const fbn = one(x.restricted, 'Farmers Business Network');
  assert.deepEqual([fbn.cost, fbn.shares, fbn.value, fbn.belowUnit], [10490000, 568149, 0, false]);
  // the marked reading is used only when it adds up: a report whose lines it cannot complete reads as before
  const cut = read('0001193125-23-046133.html').replace(/>3,862,836</, '>3,862,836 shares<');
  const [c2] = parseTRowePrice(cut);
  assert.equal(c2.restricted.length, 0, 'one line unread: the total does not add up, so the plain reading stands');
  assert.ok(selfChecks(c2).some(c => !c.ok));
});

test('T. Rowe Price credit funds: a coupon after the cost, value-only fund interests', () => {
  // Dynamic Credit 2025-12-31: 13 lines add up to the stated $51,481 (000s)
  const [dc] = parseTRowePrice(read('0001193125-26-062863.html'));
  assert.deepEqual(dc.restrictedTotal, { mark: '2', value: 51481000, pctNav: 4.4 });
  assert.equal(dc.restricted.length, 13);
  for (const c of selfChecks(dc)) assert.ok(c.ok, `${c.check} (${c.detail})`);
  // "Cost $3,720, 9.335%, 7/8/30 (USD)": a bond, its par as shares
  const vaca = one(dc.restricted, 'Vaca Muerta, FRN, 6M TSFR + 5.38%');
  assert.deepEqual([vaca.cost, vaca.shares, vaca.value, vaca.currency], [3720000, 3720000, 3717000, 'USD']);
  // "† 25 | 37": not unitized, the value alone (37 is the section's subtotal)
  const feeder = one(dc.restricted, 'Bona Fide Investments Feeder LLC');
  assert.deepEqual([feeder.shares, feeder.value], [null, 25000]);
  // "(2) (8)" and an equity line with its section subtotal after it
  assert.deepEqual(
    [one(dc.restricted, 'Altera Infrastructure').shares, one(dc.restricted, 'Kobold Metals, Series C-2').value],
    [639, 5745000]
  );
  // Global Growth Stock 2024-04-30 prints a value below the unit as an undecoded Windows-1252 dash
  // (U+0097): shares and "—", never a value-only line (the stated total caught the misreading)
  const gg = parseTRowePrice(
    '<div>April 30, 2024 Statement of Assets and Liabilities</div><div>NET ASSETS $ 1,000\u200c</div>' +
      '<div>(3) Security cannot be offered for public resale without first being registered.</div>' +
      '<div>The aggregate value of restricted securities (excluding 144A holdings) at period end amounts to $0 and represents 0.0% of net assets.</div>' +
      '<div>Reliance Industries 149,438\u200c 5,242\u200c Think &amp; Learn, Acquisition Date: 12/23/20 - 1/15/21, Cost $1,309 (1)(2)(3) 821\u200c \u0097\u200c United Spirits 142,370\u200c 1,998\u200c</div>'
  )[0];
  const tl = one(gg.restricted, 'Think & Learn');
  assert.deepEqual([tl.shares, tl.value, tl.belowUnit, tl.cost], [821, 0, true, 1309000]);
  // a value-only line never joins N-PORT: no share count to match
  assert.equal(
    refusal({ ...feeder, match: 'none', nport: [], scheduleFound: true }, { fundOk: true, unit: 1000 }),
    'none'
  );
});

test('Capital Group 2024: wrapped and weighted side labels; cost-table names that keep their footnotes', () => {
  // SMALLCAP World Fund 2024-09-30, the filer's cells: "technology" (the second line of "Information
  // technology") and "Health care 0.03%" in the side column
  const doc =
    '<div>Investment portfolio September 30, 2024</div><table>' +
    '<tr><td>Information</td><td>PsiQuantum Corp., Series D, preferred shares 2,4,5</td><td>1,334,542</td><td>56,798</td></tr>' +
    '<tr><td>technology</td><td>Skyryse, Inc., Series B, preferred shares 1,2,4,5</td><td>1,649,110</td><td>36,627</td></tr>' +
    '<tr><td>Health care 0.03%</td><td>Candid Therapeutics, Inc., Class B, noncumulative convertible preferred shares 4,5</td><td>16,666,666</td><td>20,000</td></tr>' +
    '<tr><td>Net assets 100.00%</td><td>$ 77,077,041</td></tr></table><div>Restricted securities 5</div><table>' +
    '<tr><td>Acquisition date(s)</td><td>Cost (000)</td><td>Value (000)</td><td>Percent of net assets</td></tr>' +
    '<tr><td>PsiQuantum Corp., Series D, preferred shares 2,4</td><td>5/28/2021</td><td>$ 35,000</td><td>$ 56,798</td><td>.07 %</td></tr>' +
    '<tr><td>Skyryse, Inc., Series B, preferred shares 1,2,4</td><td>10/21/2021</td><td>40,700</td><td>36,627</td><td>.05</td></tr>' +
    '<tr><td>Candid Therapeutics, Inc., Class B, noncumulative convertible preferred shares 4</td><td>8/27/2024</td><td>20,000</td><td>20,000</td><td>.03</td></tr>' +
    '<tr><td>Total</td><td>$ 95,700</td><td>$ 113,425</td><td>.15 %</td></tr></table>';
  const [f] = parseCapitalGroup(doc);
  assert.deepEqual(
    f.schedule.map(r => [r.name, r.shares, r.value]),
    [
      ['PsiQuantum Corp., Series D, preferred shares', 1334542, 56798000],
      ['Skyryse, Inc., Series B, preferred shares', 1649110, 36627000],
      ['Candid Therapeutics, Inc., Class B, noncumulative convertible preferred shares', 16666666, 20000000],
    ]
  );
  // "preferred shares 1,2,4" in the cost table pairs with its row only through the value
  const paired = pairWithSchedule(f);
  assert.ok(
    paired.every(r => r.scheduleFound),
    paired
      .filter(r => !r.scheduleFound)
      .map(r => r.rawName)
      .join('; ')
  );
  assert.equal(paired[1].shares, 1649110);
  for (const c of selfChecks(f)) assert.ok(c.ok, `${c.check} (${c.detail})`);
  // a different value: no pairing, however close the name
  const off = doc.replace('<td>40,700</td><td>36,627</td>', '<td>40,700</td><td>36,727</td>');
  assert.equal(pairWithSchedule(parseCapitalGroup(off)[0])[1].scheduleFound, false);
});

test('Fidelity: "$--" in the cost table is a cost of 0, and the table goes on', () => {
  // Fidelity Blue Chip Growth K6 N-CSRS 2020-01-31, the filer's rows: "Riskified Ltd. warrants | 10/28/19 | $--"
  const doc =
    '<div>Fidelity® Blue Chip Growth K6 Fund</div><div>Semi-Annual Report</div>' +
    '<div>Schedule of Investments January 31, 2020 (Unaudited)</div><table>' +
    '<tr><td>Riskified Ltd. (a)(b)</td><td>3,900</td><td>203,370</td></tr>' +
    '<tr><td>Riskified Ltd. warrants (a)(b)</td><td>3,900</td><td>0</td></tr>' +
    '<tr><td>Roofoods Ltd. Series F (a)(b)</td><td>337</td><td>119,153</td></tr>' +
    '<tr><td>NET ASSETS - 100.0%</td><td>$100,000,000</td></tr></table>' +
    '<table><tr><td>(b)</td><td>Restricted securities (including private placements) - Investment in securities not registered under the Securities Act of 1933 (excluding 144A issues). At the end of the period, the value of restricted securities (excluding 144A issues) amounted to $322,523 or 0.3% of net assets.</td></tr></table>' +
    '<table><tr><td>Additional information on each restricted holding is as follows:</td></tr>' +
    '<tr><td>Security</td><td>Acquisition Date</td><td>Acquisition Cost</td></tr>' +
    '<tr><td>Riskified Ltd.</td><td>12/20/19</td><td>$203,370</td></tr>' +
    '<tr><td>Riskified Ltd. warrants</td><td>10/28/19</td><td>$--</td></tr>' +
    '<tr><td>Roofoods Ltd. Series F</td><td>9/12/17</td><td>$119,153</td></tr></table>';
  const [f] = parseFidelity(doc);
  assert.deepEqual(
    f.restricted.map(r => [r.name, r.cost]),
    [
      ['Riskified Ltd.', 203370],
      ['Riskified Ltd. warrants', 0],
      ['Roofoods Ltd. Series F', 119153],
    ]
  );
  for (const c of selfChecks(f)) assert.ok(c.ok, `${c.check} (${c.detail})`);
  assert.equal(
    refusal(
      { ...f.restricted[1], match: 'exact', nport: [], scheduleFound: true, shares: 3900 },
      { fundOk: true, unit: 1 }
    ),
    'no cost'
  );
});
