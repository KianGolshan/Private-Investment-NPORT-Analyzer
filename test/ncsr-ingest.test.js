// P15 (ADR 0011): the N-CSR ingest (lib/warehouse/ncsr.js) and the cost facts
// (lib/warehouse/cost-facts.js) on the golden warehouse, with REAL filings from
// test/fixtures/ncsr (built by its builder): Fidelity Mt. Vernon Street Trust N-CSRS
// 2026-05-31 and Growth Fund of America N-CSRS 2026-02-28, their SGML headers and
// submissions listings, and T. Rowe Price Growth Stock's image-only report 2020-12-31.
// The SEC is a fake that serves those files; nothing reaches the network.
//
// The admission rule is the user's: only 100% validatable data; any doubt, leave it out.
//
// Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { goldenWarehouse } = require('./helpers/warehouseApp');
const { ingestNcsr, readFiling, store, readFamilies } = require('../lib/warehouse/ncsr');
const { buildCostFacts, roundPrices, precise } = require('../lib/warehouse/cost-facts');
const { buildPositionFacts } = require('../lib/warehouse/position-facts');
const { refusal, allChecksPassed } = require('../lib/ncsr/match');
const { imageOnly } = require('../lib/ncsr/filing');

const DIR = path.join(__dirname, 'fixtures', 'ncsr');
const read = f => fs.readFileSync(path.join(DIR, f), 'utf8');
const SUBMISSIONS = JSON.parse(read('submissions.json'));
const FID = '0000707823-26-000042';
const GFA = '0001193125-26-195253';
const IMG = '0001206774-21-000424';

// The SEC, served from the fixtures: each registrant's real listing cut to `keep`.
function fakeSec({ keep, docs = {}, fail = {} }) {
  const calls = [];
  const get = async url => {
    calls.push(url);
    if (fail[url]) throw Object.assign(new Error(`HTTP ${fail[url]}`), { response: { status: fail[url] } });
    const sub = url.match(/submissions\/CIK0*(\d+)\.json$/);
    if (sub) {
      const s = structuredClone(SUBMISSIONS[sub[1]] || { filings: { recent: { form: [] }, files: [] } });
      const r = s.filings.recent;
      const idx = r.accessionNumber
        ? r.accessionNumber.map((a, i) => (keep.includes(a) ? i : -1)).filter(i => i >= 0)
        : [];
      for (const k of Object.keys(r)) r[k] = idx.map(i => r[k][i]);
      return JSON.stringify(s);
    }
    if (docs[url]) return docs[url]();
    const acc = url.match(/\/(\d{10}-\d{2}-\d{6})-index-headers\.html$/);
    if (acc) return read(path.join('headers', `${acc[1]}.html`));
    throw Object.assign(new Error('HTTP 404'), { response: { status: 404 } });
  };
  return { get, calls };
}
const dirOf = (cik, acc) => `https://www.sec.gov/Archives/edgar/data/${cik}/${acc.replace(/-/g, '')}`;
const primaryOf = (cik, acc) =>
  SUBMISSIONS[cik].filings.recent.primaryDocument[SUBMISSIONS[cik].filings.recent.accessionNumber.indexOf(acc)];
const realDocs = () => ({
  [`${dirOf('707823', FID)}/${primaryOf('707823', FID)}`]: () => read(`${FID}.html`),
  [`${dirOf('707823', FID)}/index.json`]: () => JSON.stringify({ directory: { item: [] } }),
  [`${dirOf('44201', GFA)}/${primaryOf('44201', GFA)}`]: () => read(`${GFA}.html`),
  [`${dirOf('44201', GFA)}/index.json`]: () => JSON.stringify({ directory: { item: [] } }),
});
const tableHash = (db, t) =>
  crypto
    .createHash('sha256')
    .update(
      db
        .prepare(`SELECT * FROM ${t}`)
        .raw()
        .all()
        .map(r => JSON.stringify(r))
        .sort()
        .join('\n')
    )
    .digest('hex');

test('the registry: every listed registrant has a parser, no cik twice', () => {
  const fams = readFamilies();
  assert.equal(fams.length, 93);
  assert.deepEqual([...new Set(fams.map(f => f.family))].sort(), [
    'capital',
    'fidelity',
    'morganstanley',
    'troweprice',
  ]);
  assert.ok(fams.some(f => f.cik === '707823' && f.family === 'fidelity'));
  assert.ok(fams.some(f => f.cik === '44201' && f.family === 'capital'));
});

test('ingest: reads, stores, retries failures, never re-reads a stored filing, and caps a run', async () => {
  const { db } = goldenWarehouse();
  const secOk = fakeSec({ keep: [FID, GFA, '0000707823-26-000019'], docs: realDocs() });
  const first = await ingestNcsr(db, { ciks: ['707823', '44201'], get: secOk.get, now: () => '2026-11-05T00:00:00Z' });
  assert.deepEqual([first.ok, first.failed, first.unreadable], [2, 1, 0]);
  assert.equal(first.failedFilings[0].accession, '0000707823-26-000019', 'its document is not served: 404');
  const st = acc => db.prepare('SELECT status, attempts, funds, lines FROM ncsr_filings WHERE accession = ?').get(acc);
  assert.deepEqual(st(FID), { status: 'ok', attempts: 1, funds: 2, lines: 238 });
  assert.deepEqual(st(GFA), { status: 'ok', attempts: 1, funds: 1, lines: 29 });
  assert.deepEqual(st('0000707823-26-000019'), { status: 'failed', attempts: 1, funds: 0, lines: 0 });
  // a second run reads only the failed filing again
  const again = fakeSec({ keep: [FID, GFA, '0000707823-26-000019'], docs: realDocs() });
  const second = await ingestNcsr(db, { ciks: ['707823', '44201'], get: again.get, now: () => '2026-11-06T00:00:00Z' });
  assert.deepEqual([second.ok, second.failed], [0, 1]);
  assert.equal(st('0000707823-26-000019').attempts, 2);
  assert.ok(!again.calls.some(u => u.includes(primaryOf('707823', FID))), 'a stored filing is not fetched again');
  // the cap: oldest first, the rest left for the next run
  const { db: db2 } = goldenWarehouse();
  const capped = await ingestNcsr(db2, {
    ciks: ['707823', '44201'],
    get: fakeSec({ keep: [FID, GFA], docs: realDocs() }).get,
    max: 1,
  });
  assert.deepEqual([capped.ok, capped.pending], [1, 1]);
  assert.equal(
    db2.prepare('SELECT accession FROM ncsr_filings').get().accession,
    GFA,
    'filed 2026-04-30, before Fidelity'
  );
  const log = db2.prepare("SELECT * FROM ingest_log WHERE kind = 'ncsr'").get();
  assert.deepEqual([log.filings, log.status], [1, 'ok']);
});

test('ingest: an image-only report is unreadable (not retried); an SEC refusal stops the run with nothing half-read', async () => {
  const { db } = goldenWarehouse();
  const dir = dirOf('80257', IMG);
  const sec = fakeSec({
    keep: [IMG],
    docs: {
      [`${dir}/argsf_ncsr.htm`]: () => read(`imageonly/${IMG}.htm`),
      [`${dir}/index.json`]: () => read(`imageonly/${IMG}-index.json`),
      [`${dir}/${IMG}-index-headers.html`]: () => read(`imageonly/${IMG}-headers.html`),
    },
  });
  SUBMISSIONS['80257'] = {
    cik: '0000080257',
    filings: {
      recent: {
        accessionNumber: [IMG],
        filingDate: ['2021-02-25'],
        reportDate: ['2020-12-31'],
        form: ['N-CSR'],
        primaryDocument: ['argsf_ncsr.htm'],
      },
      files: [],
    },
  };
  try {
    const r = await ingestNcsr(db, { ciks: ['80257'], get: sec.get });
    assert.deepEqual([r.unreadable, r.failed, r.failedFilings.length], [1, 0, 0]);
    assert.equal(db.prepare('SELECT status FROM ncsr_filings WHERE accession = ?').get(IMG).status, 'unreadable');
    const again = await ingestNcsr(db, { ciks: ['80257'], get: sec.get });
    assert.equal(again.unreadable + again.failed + again.ok, 0, 'an unreadable report is final');
    assert.ok(imageOnly(read(`imageonly/${IMG}.htm`), 43));
    assert.ok(!imageOnly(read(`${GFA}.html`), 43), 'a report with a portfolio is never image-only');
    // a note's words are not a portfolio (T. Rowe Price Health Sciences 2022-06-30, 37 page images)
    assert.ok(imageOnly('<p>Private Investments Issued by Special Purpose Acquisition Companies</p>', 37));
    assert.ok(!imageOnly('<p>Databricks, Series J, Acquisition Date: 12/17/24, Cost $1,974</p>', 37));
    // HTTP 503 after the client's retries: the run stops there; filings read before it are kept,
    // the refused one is not touched, and the next run starts at it
    const { db: db2 } = goldenWarehouse();
    const boom = fakeSec({
      keep: [FID, GFA],
      docs: realDocs(),
      fail: { [`${dirOf('707823', FID)}/${FID}-index-headers.html`]: 503 },
    });
    const r2 = await ingestNcsr(db2, { ciks: ['707823', '44201'], get: boom.get });
    assert.deepEqual([r2.ok, r2.stopped.accession, r2.stopped.status, r2.pending], [1, FID, 503, 1]);
    assert.deepEqual(
      db2.prepare('SELECT accession, status FROM ncsr_filings').all(),
      [{ accession: GFA, status: 'ok' }],
      'Growth Fund of America (filed first) kept; Fidelity not touched'
    );
    assert.equal(db2.prepare("SELECT status FROM ingest_log WHERE kind = 'ncsr'").get().status, 'partial');
    const resumed = await ingestNcsr(db2, {
      ciks: ['707823', '44201'],
      get: fakeSec({ keep: [FID, GFA], docs: realDocs() }).get,
    });
    assert.deepEqual([resumed.ok, resumed.pending, resumed.stopped], [1, 0, null]);
  } finally {
    delete SUBMISSIONS['80257'];
  }
});

// The golden warehouse with both real filings read and stored, and the cost facts built.
function loaded({ before } = {}) {
  const w = goldenWarehouse();
  if (before) {
    before(w.db);
    buildPositionFacts(w.db); // as every job does after a change to the stored rows
  }
  const put = (acc, cik, family, period, filingDate, html = read(`${acc}.html`), form = 'N-CSRS', as = acc) => {
    const rep = { accession: as, cik, form, filingDate, periodEnd: period };
    store(
      w.db,
      rep,
      family,
      readFiling(w.db, rep, family, { html, header: read(`headers/${acc}.html`), document: 'x' }),
      {
        status: 'ok',
        now: '2026-11-05T00:00:00Z',
      }
    );
  };
  put(FID, '707823', 'fidelity', '2026-05-31', '2026-07-23');
  put(GFA, '44201', 'capital', '2026-02-28', '2026-04-30');
  return { ...w, put, built: buildCostFacts(w.db) };
}
const fact = (db, company, cls, fund) =>
  db
    .prepare(
      `SELECT f.* FROM cost_facts f JOIN companies c ON c.id = f.company_id
       WHERE c.name = ? AND f.class_label = ? AND f.fund_key = ?`
    )
    .all(company, cls, fund);

test('cost facts: only lines that validate completely, each on one position leg', () => {
  const { db, built } = loaded();
  assert.deepEqual([built.checked, built.admitted], [25, 24]);
  assert.deepEqual(
    built.refusals,
    { 'more than one position leg': 1 },
    'Stripe Class B: two custody legs, two legs in the app'
  );
  const [d] = fact(db, 'Anthropic', 'Series D', 'S000007119');
  assert.deepEqual(
    [d.nport_accession, d.report_date, d.shares, d.value_usd, d.cost_usd, d.acquired_first, d.single_lot],
    ['0000035402-26-004656', '2026-05-31', 235150, 146484341, 7055558, '2024-05-31', 1]
  );
  assert.equal(d.cost_per_share, 7055558 / 235150);
  // a date range is a blend of lots: a cost, no entry price
  const [g1] = fact(db, 'Anthropic', 'Series G-1', 'S000009228');
  assert.deepEqual([g1.cost_usd, g1.single_lot, g1.cost_per_share], [1315269000, 0, null]);
  // value conflicts (SpaceX: N-PORT $1,213,180,026.80, N-CSR $1,555,063,650), debt and lines with no N-PORT row: none
  const reasons = Object.fromEntries(
    db
      .prepare('SELECT refused, COUNT(*) n FROM ncsr_costs GROUP BY refused')
      .all()
      .map(r => [String(r.refused), r.n])
  );
  assert.deepEqual(reasons, { null: 25, value: 2, debt: 19, none: 221 });
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) n FROM cost_facts f JOIN companies c ON c.id = f.company_id WHERE c.name LIKE 'Space Exploration%'"
      )
      .get().n,
    0
  );
  // every admitted cost sits on a leg the app shows, with its exact shares and value
  for (const x of db.prepare('SELECT * FROM cost_facts').all()) {
    const leg = db
      .prepare('SELECT balance, value FROM position_facts WHERE fund_key = ? AND accession = ? AND instrument_key = ?')
      .get(x.fund_key, x.nport_accession, x.instrument_key);
    assert.deepEqual([leg.balance, leg.value], [x.shares, x.value_usd]);
  }
});

test('confirmed round prices: two firms, one date, one class, within 0.5%', () => {
  const { db } = loaded();
  const rows = db
    .prepare(
      `SELECT c.name, r.class_label, r.acquired_on, ROUND(r.price, 2) AS price, r.firms, r.funds
       FROM round_prices r JOIN companies c ON c.id = r.company_id ORDER BY 1, 2`
    )
    .all();
  assert.deepEqual(rows, [
    { name: 'Databricks', class_label: 'Series J', acquired_on: '2024-12-17', price: 92.5, firms: 2, funds: 2 },
    { name: 'Databricks', class_label: 'Series K', acquired_on: '2025-09-08', price: 150, firms: 2, funds: 2 },
    { name: 'Stripe', class_label: 'Series H', acquired_on: '2021-03-15', price: 40.13, firms: 2, funds: 2 },
  ]);
  // Series L: Fidelity 2025-12-18, Capital Group 2025-12-16 (two dates); Anthropic H: one firm (two Fidelity funds)
  assert.ok(!rows.some(r => r.class_label === 'Series L' || r.name === 'Anthropic'));

  // a lot too small for its printed unit neither confirms nor contradicts: 459 Series J shares at "$42"
  // thousand (T. Rowe Price, 2025-04-30) are $90.41 to $92.59 a share; a precise lot at that price does refuse
  assert.equal(precise({ shares: 459, cost_unit: 1000, cost_per_share: 42000 / 459 }), false);
  assert.equal(precise({ shares: 292276, cost_unit: 1000, cost_per_share: 27036000 / 292276 }), true);
  assert.equal(precise({ shares: 1, cost_unit: 1000, cost_per_share: 1000 }), false);
  const facts = db.prepare('SELECT * FROM cost_facts').all();
  const j = facts.find(f => f.class_label === 'Series J' && f.acquired_first === '2024-12-17');
  const lot = (shares, cost) => ({
    ...j,
    fund_key: 'S000007118',
    shares,
    cost_usd: cost,
    cost_per_share: cost / shares,
    cost_unit: 1000,
  });
  const jOf = list => roundPrices(db, list).find(r => r.class_label === 'Series J');
  assert.equal(Math.round(jOf([...facts, lot(459, 42000)]).price * 100) / 100, 92.5);
  assert.equal(jOf([...facts, lot(459000, 42000000)]), undefined, '$91.50 on 459,000 shares disagrees');
});

test('admission is strict: one dollar too far, one share off, an unreviewed company or a vehicle refuse the line', () => {
  const nudge = (title, col, by) => db =>
    db
      .prepare(`UPDATE holdings SET ${col} = ${col} + ? WHERE accession = '0000035402-26-004656' AND title = ?`)
      .run(by, title);
  const dOf = db => fact(db, 'Anthropic', 'Series D', 'S000007119');
  assert.equal(dOf(loaded({ before: nudge('ANTHROPIC PBC SERIES D PC PP', 'value_usd', 0.99) }).db).length, 1);
  const far = loaded({ before: nudge('ANTHROPIC PBC SERIES D PC PP', 'value_usd', 1.5) });
  assert.equal(dOf(far.db).length, 0);
  assert.equal(
    far.db.prepare("SELECT refused FROM ncsr_costs WHERE security = 'Anthropic PBC Series D'").get().refused,
    'value differs'
  );
  assert.equal(dOf(loaded({ before: nudge('ANTHROPIC PBC SERIES D PC PP', 'balance', 1) }).db).length, 0);
  const unreviewed = loaded({
    before: db =>
      db
        .prepare(
          "UPDATE holdings SET company_id = NULL WHERE accession = '0000035402-26-004656' AND title LIKE 'ANTHROPIC PBC SERIES D%'"
        )
        .run(),
  });
  assert.equal(dOf(unreviewed.db).length, 0);
  // the number-level rule on its own
  const r = {
    match: 'exact',
    pairedByOrder: false,
    scheduleFound: true,
    belowUnit: false,
    cost: 10,
    shares: 5,
    value: 100,
    nport: [{ balance: 5, value_usd: 100 }],
  };
  assert.equal(refusal(r, { fundOk: true, unit: 1 }), null);
  assert.equal(refusal(r, { fundOk: false, unit: 1 }), 'fund report');
  assert.equal(refusal({ ...r, match: 'combined' }, { fundOk: true, unit: 1 }), 'combined');
  assert.equal(refusal({ ...r, pairedByOrder: true }, { fundOk: true, unit: 1 }), 'paired by order');
  assert.equal(refusal({ ...r, belowUnit: true }, { fundOk: true, unit: 1000 }), 'below the printed unit');
  assert.equal(refusal({ ...r, cost: 0 }, { fundOk: true, unit: 1 }), 'no cost');
  assert.equal(
    refusal({ ...r, value: 100 + 501 }, { fundOk: true, unit: 1000 }),
    'value differs',
    'thousands: $500 at most'
  );
  assert.equal(refusal({ ...r, value: 100 + 500 }, { fundOk: true, unit: 1000 }), null);
  assert.equal(
    allChecksPassed([{ ok: true }, { ok: false, severity: 'note' }]),
    false,
    'a note refuses the fund report'
  );
});

test('a fund report that fails a self-check gives no cost at all', () => {
  // a marked schedule row cut from Growth Strategies (Suncrete): the stated restricted total holds a
  // row the parse did not read, a shortfall nothing can set apart
  const html = read(`${FID}.html`);
  const section = html.indexOf('Fidelity® Growth Strategies Fund');
  const row = html.indexOf('<tr><td>Suncrete Inc (d)</td>', section);
  assert.ok(row > section);
  const cut = html.slice(0, row) + html.slice(html.indexOf('</tr>', row) + 5);
  const w = loaded();
  w.put(FID, '707823', 'fidelity', '2026-05-31', '2026-07-24', cut, 'N-CSRS', '0000707823-26-999999');
  const fund = name =>
    w.db.prepare("SELECT status FROM ncsr_funds WHERE accession = '0000707823-26-999999' AND fund_name = ?").get(name)
      .status;
  assert.equal(fund('Fidelity Growth Strategies Fund'), 'checks');
  assert.equal(fund('Fidelity Growth Company Fund'), 'ok', 'the other fund in the filing is unaffected');
  const lines = w.db
    .prepare(
      `SELECT c.refused FROM ncsr_costs c JOIN ncsr_funds f ON f.accession = c.accession AND f.fund_no = c.fund_no
       WHERE f.status = 'checks'`
    )
    .all();
  assert.ok(lines.length > 0 && lines.every(l => l.refused === 'fund report'));
  buildCostFacts(w.db);
  assert.equal(
    w.db.prepare("SELECT COUNT(*) n FROM cost_facts WHERE fund_key = 'S000007118'").get().n,
    0,
    'the later, failing report replaces the earlier one and gives Growth Strategies no cost'
  );
});

test('lines set apart: the rest of the report is admitted, the set-apart name is not', () => {
  // the cost line of Anthropic Series H cut from Growth Strategies: the schedule still marks it, the
  // stated total still holds it. Its name is set apart; the other lines prove out exactly.
  const html = read(`${FID}.html`);
  const section = html.indexOf('Fidelity® Growth Strategies Fund');
  const table = html.indexOf('Acquisition Cost', section);
  const row = html.lastIndexOf('<tr>', html.indexOf('Anthropic PBC Series H</td>', table));
  assert.ok(row > table);
  const cut = html.slice(0, row) + html.slice(html.indexOf('</tr>', row) + 5);
  const w = loaded();
  const before = w.db
    .prepare(
      "SELECT c.name, f.cost_usd FROM cost_facts f JOIN companies c ON c.id = f.company_id WHERE fund_key = 'S000007118' ORDER BY 1"
    )
    .all();
  assert.deepEqual(
    before.map(r => r.name),
    ['Anthropic', 'Databricks']
  );
  w.put(FID, '707823', 'fidelity', '2026-05-31', '2026-07-24', cut, 'N-CSRS', '0000707823-26-999999');
  const f = w.db
    .prepare(
      "SELECT status, checks FROM ncsr_funds WHERE accession = '0000707823-26-999999' AND fund_name = 'Fidelity Growth Strategies Fund'"
    )
    .get();
  assert.equal(f.status, 'ok');
  const apart = JSON.parse(f.checks).find(c => c.check === 'lines set apart (not admitted)');
  assert.match(apart.detail, /^Anthropic PBC Series H: printed a different number of times/);
  buildCostFacts(w.db);
  const after = w.db
    .prepare(
      "SELECT c.name, f.cost_usd FROM cost_facts f JOIN companies c ON c.id = f.company_id WHERE fund_key = 'S000007118' ORDER BY 1"
    )
    .all();
  assert.deepEqual(
    after,
    before.filter(r => r.name !== 'Anthropic'),
    'the same costs as the whole report, Anthropic left out'
  );
});

test('re-read after a parser change: by fund-report status or by family; nothing else is fetched', async () => {
  const { db } = goldenWarehouse();
  const docs = realDocs();
  await ingestNcsr(db, { ciks: ['707823', '44201'], get: fakeSec({ keep: [FID, GFA], docs }).get });
  db.prepare("UPDATE ncsr_funds SET status = 'checks' WHERE accession = ? AND fund_no = 2").run(FID);
  const byStatus = fakeSec({ keep: [FID, GFA], docs });
  const r = await ingestNcsr(db, { ciks: ['707823', '44201'], get: byStatus.get, reread: { statuses: ['checks'] } });
  assert.equal(r.ok, 1);
  assert.ok(byStatus.calls.some(u => u.includes(primaryOf('707823', FID))));
  assert.ok(
    !byStatus.calls.some(u => u.includes(primaryOf('44201', GFA))),
    'a filing with every report ok is not read'
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM ncsr_funds WHERE accession = ? AND status = 'ok'").get(FID).n,
    2,
    'read again with the parser: its stored rows replaced whole'
  );
  const byFamily = fakeSec({ keep: [FID, GFA], docs });
  const r2 = await ingestNcsr(db, { ciks: ['707823', '44201'], get: byFamily.get, reread: { families: ['capital'] } });
  assert.equal(r2.ok, 1);
  assert.ok(byFamily.calls.some(u => u.includes(primaryOf('44201', GFA))));
  assert.ok(!byFamily.calls.some(u => u.includes(primaryOf('707823', FID))));
  const none = fakeSec({ keep: [FID, GFA], docs });
  assert.equal((await ingestNcsr(db, { ciks: ['707823', '44201'], get: none.get })).ok, 0);
});

test('the latest read filing wins; an unreadable amendment withholds the period', () => {
  const w = loaded();
  // the same report again, filed later under another accession: only the later one counts
  w.put(FID, '707823', 'fidelity', '2026-05-31', '2026-08-01', read(`${FID}.html`), 'N-CSRS/A', '0000707823-26-900001');
  const r = buildCostFacts(w.db);
  assert.equal(r.admitted, 24);
  assert.deepEqual(
    w.db
      .prepare('SELECT DISTINCT ncsr_accession FROM cost_facts ORDER BY 1')
      .all()
      .map(x => x.ncsr_accession),
    ['0000707823-26-900001', GFA]
  );
  // an amendment we could not read: every cost of that registrant and period is withheld
  w.db
    .prepare(
      `INSERT INTO ncsr_filings (accession, cik, family, form, period_end, filing_date, status, error, read_at)
       VALUES ('0000707823-26-900002', '707823', 'fidelity', 'N-CSRS/A', '2026-05-31', '2026-09-01', 'failed', 'x', 'now')`
    )
    .run();
  buildCostFacts(w.db);
  assert.deepEqual(
    w.db
      .prepare('SELECT DISTINCT ncsr_accession FROM cost_facts')
      .all()
      .map(x => x.ncsr_accession),
    [GFA]
  );
});

test('the cost work changes no N-PORT table', () => {
  const w = goldenWarehouse();
  const tables = ['holdings', 'filings', 'position_facts', 'company_stats', 'companies', 'unreviewed_entities'];
  const before = Object.fromEntries(tables.map(t => [t, tableHash(w.db, t)]));
  for (const [acc, cik, fam, period] of [
    [FID, '707823', 'fidelity', '2026-05-31'],
    [GFA, '44201', 'capital', '2026-02-28'],
  ]) {
    const rep = { accession: acc, cik, form: 'N-CSRS', filingDate: '2026-07-01', periodEnd: period };
    store(
      w.db,
      rep,
      fam,
      readFiling(w.db, rep, fam, { html: read(`${acc}.html`), header: read(`headers/${acc}.html`), document: 'x' }),
      {
        status: 'ok',
        now: 'now',
      }
    );
  }
  buildCostFacts(w.db);
  for (const t of tables) assert.equal(tableHash(w.db, t), before[t], t);
});
