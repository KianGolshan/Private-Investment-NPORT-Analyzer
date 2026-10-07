// An independent oracle (staff review F17). Raw holdings come straight from
// EDGAR's primary_doc.xml (test/fixtures/oracle/oracle.json, built by
// build-oracle.js with regular expressions, not parsers.js). Which rows make a
// class is picked here by hand, and every expected answer is plain arithmetic
// on those raw numbers: no production helper computes an expectation. The app
// answers the same questions on the golden fixture and must agree.
const test = require('node:test');
const assert = require('node:assert/strict');
const { goldenWarehouse } = require('./helpers/warehouseApp');
const oracle = require('./fixtures/oracle/oracle.json');
const { exposureAsOf } = require('../lib/analytics/asof');
const { companyActivity } = require('../lib/analytics/activity');
const marks = require('../lib/services/marks');

const { db, idOf } = goldenWarehouse();
const num = x => Number(x);
const close = (a, b, tol = 0.005) => Math.abs(a - b) <= tol;
// A raw row, picked by hand: accession, the filer's title, and shares.
function pick(accession, title, balance) {
  const f = oracle.filings[accession];
  assert.ok(f, `${accession} in the oracle`);
  const r = f.rows.find(x => x.title === title && num(x.balance) === balance);
  assert.ok(r, `${accession}: "${title}" ${balance} sh`);
  return { accession, fundKey: f.fundKey, markDate: f.repPdDate, shares: num(r.balance), value: num(r.valUSD) };
}
const median = xs => {
  const s = [...xs].sort((a, b) => a - b);
  const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
};
// One observation per fund: its lots' value over their shares.
function byFund(rows) {
  const m = new Map();
  for (const r of rows) {
    const f = m.get(r.fundKey) || m.set(r.fundKey, { v: 0, s: 0 }).get(r.fundKey);
    f.v += r.value;
    f.s += r.shares;
  }
  return [...m.values()].map(f => f.v / f.s);
}

// The class cases: [company, instrument as the app names it, mark date, hand-picked rows]
const CLASS_CASES = [
  [
    'Databricks',
    'Common',
    '2026-02-27',
    [
      pick('0000940400-26-014719', 'DATABRICKS INC', 375170),
      pick('0000940400-26-014719', 'DATABRICKS INC', 110367),
      pick('0000940400-26-014713', 'DATABRICKS INC', 319983),
      pick('0000940400-26-014713', 'DATABRICKS INC', 211425),
      pick('0000940400-26-014713', 'DATABRICKS INC', 258450),
      pick('0000940400-26-014717', 'DATABRICKS INC', 141268),
      pick('0000940400-26-014717', 'DATABRICKS INC', 41135),
    ],
  ],
  [
    'Anthropic',
    'Common',
    '2026-03-31',
    [
      pick('0001410368-26-054494', 'ANTHROPIC PBC', 156064),
      pick('0001410368-26-054509', 'ANTHROPIC PBC', 156064),
      pick('0001410368-26-054489', 'ANTHROPIC PBC', 120595),
      pick('0001193125-26-243966', 'ANTHROPIC PBC PP (PHYSICAL) (NOT LISTED OR TRADING)', 117063),
      pick('0001410368-26-054534', 'ANTHROPIC PBC', 4922),
      pick('0001410368-26-054521', 'ANTHROPIC PBC', 2683),
    ],
  ],
  [
    'Stripe',
    'Series H',
    '2026-03-31',
    [
      pick('0000035402-26-003312', 'STRIPE INC SER H PC PP', 190300),
      pick('0001193125-26-243966', 'STRIPE LLC PFD SER H 6.00% NON-CUM PP (PHYSICAL) (NOT LISTED OR TRADING)', 52656),
      pick('0000035402-26-003299', 'STRIPE INC SER H PC PP', 34900),
      pick('0000035402-26-003445', 'STRIPE INC SER H PC PP', 30400),
      pick('0000035402-26-003310', 'STRIPE INC SER H PC PP', 29000),
      pick('0000035402-26-003406', 'STRIPE INC SER H PC PP', 11500),
    ],
  ],
];

test('oracle: the warehouse rows equal the raw EDGAR rows they came from', () => {
  const stored = db.prepare('SELECT balance, value_usd FROM holdings WHERE accession = ? AND balance = ?');
  let n = 0;
  for (const [, , , rows] of CLASS_CASES)
    for (const r of rows) {
      const s = stored.get(r.accession, r.shares);
      assert.ok(s, `${r.accession} ${r.shares} sh stored`);
      assert.ok(close(s.value_usd, r.value, 0.01), `${r.accession}: stored ${s.value_usd}, EDGAR ${r.value}`);
      n++;
    }
  assert.equal(n, 19);
});

test('oracle: class marks per fund, fund counts, medians and spreads (F06)', () => {
  for (const [company, instrument, date, rows] of CLASS_CASES) {
    const prices = byFund(rows);
    const c = marks.classesAsOf(db, { companyId: idOf(company) }, date).classes.find(x => x.instrument === instrument);
    const d = c.byMarkDate.find(x => x.markDate === date);
    const what = `${company} ${instrument} ${date}`;
    assert.equal(d.funds, prices.length, `${what}: funds`);
    assert.ok(close(d.median, median(prices), 1e-6), `${what}: median ${d.median} vs ${median(prices)}`);
    assert.ok(close(d.low, Math.min(...prices), 1e-6), `${what}: low`);
    assert.ok(close(d.high, Math.max(...prices), 1e-6), `${what}: high`);
  }
  // typed by hand from the raw rows: Databricks common at $178.72 a share in all three funds (7 lots)
  assert.equal(byFund(CLASS_CASES[0][3]).length, 3);
  assert.ok(byFund(CLASS_CASES[0][3]).every(p => close(p, 178.72)));
});

test("oracle: a fund's exposure is the sum of its raw rows in the company (Stripe, 2026-03-31)", () => {
  const x = exposureAsOf(db, { companyId: idOf('Stripe'), date: '2026-03-31' });
  for (const acc of ['0000035402-26-003312', '0001193125-26-243966', '0000035402-26-003406']) {
    const f = oracle.filings[acc];
    const raw = f.rows.filter(r => /stripe/i.test(r.name)).reduce((t, r) => t + num(r.valUSD), 0);
    const h = x.holdings.find(h => h.fundKey === f.fundKey);
    assert.ok(h, `${f.fundKey} holds Stripe at 2026-03-31`);
    assert.equal(h.accession, acc);
    assert.ok(close(h.value, raw, 0.01), `${f.fundKey}: ${h.value} vs ${raw}`);
  }
});

test('oracle: an exit is the whole prior value, all position (Fidelity OTC, Stripe, 2026-01-31)', () => {
  const prev = oracle.filings['0000035402-25-002966'].rows.reduce((t, r) => t + num(r.valUSD), 0);
  assert.equal(oracle.filings['0000035402-26-002031'].rows.length, 0, 'the 2026-01-31 filing has no Stripe row');
  assert.ok(close(prev, 3536136 + 12165771.6));
  const e = companyActivity(db, { companyId: idOf('Stripe') }).find(x => x.accession === '0000035402-26-002031');
  assert.equal(e.type, 'exited');
  assert.ok(close(e.positionEffect, -prev, 0.01), `${e.positionEffect} vs ${-prev}`);
  assert.ok(close(e.markEffect, 0));
});

test('oracle: a re-mark with unchanged shares is all mark ($41.42 -> $63.00, Growth Fund of America)', () => {
  const prev = oracle.filings['0001193125-26-027715'].rows;
  const cur = oracle.filings['0001193125-26-182055'].rows;
  // the same seven lots, the same shares, every one re-marked from $41.42 to $63.00
  for (const r of prev) assert.ok(close(num(r.valUSD) / num(r.balance), 41.42), r.title);
  for (const r of cur) assert.ok(close(num(r.valUSD) / num(r.balance), 63), r.title);
  const shares = rows => rows.map(r => num(r.balance)).sort((a, b) => a - b);
  assert.deepEqual(shares(cur), shares(prev));
  const mark = cur.reduce((t, r) => t + num(r.valUSD), 0) - prev.reduce((t, r) => t + num(r.valUSD), 0);
  const e = companyActivity(db, { companyId: idOf('Stripe') }).find(
    x => x.accession === '0001193125-26-182055' && x.fundKey === 'S000009228'
  );
  assert.equal(e.label, 'mark moved');
  assert.ok(close(e.positionEffect, 0, 0.01));
  assert.ok(close(e.markEffect, mark, 0.01), `${e.markEffect} vs ${mark}`);
});

test('oracle: an amended filing is the one counted (NPORT-P/A, Anthropic, 2026-03-31)', () => {
  const f = oracle.filings['0000940400-26-036410'];
  const raw = f.rows.reduce((t, r) => t + num(r.valUSD), 0);
  assert.ok(close(raw, 4328096.15 + 7205287.6));
  const h = exposureAsOf(db, { companyId: idOf('Anthropic'), date: '2026-03-31' }).holdings.find(
    x => x.fundKey === f.fundKey
  );
  assert.equal(h.accession, '0000940400-26-036410');
  assert.ok(close(h.value, raw, 0.01));
});
