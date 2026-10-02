// P6b W1 on the golden fixture (real rows): position facts, the bridge, the
// pivot, the timeline, position history, scope filters and unified search.
// Every number is held equal to exposureAsOf, companyActivity, the firm book or
// a post-filter of the unfiltered answer (LESSONS 26), and the bridge
// reconciles to the cent.
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const nock = require('nock');
const { goldenWarehouse } = require('./helpers/warehouseApp');
const { exposureAsOf, exposureSeries, companyRows } = require('../lib/analytics/asof');
const { companyActivity } = require('../lib/analytics/activity');
const { factsOf, buildPositionFacts } = require('../lib/warehouse/position-facts');
const analysis = require('../lib/services/analysis');
const firm = require('../lib/services/firm');
const scopes = require('../lib/services/scope');
const { classOfRow } = require('../lib/services/classes');
const { rowInfo } = require('../lib/analytics/asof');

const { db, app, idOf, firmIdOf } = goldenWarehouse();
const api = url => request(app).get(url).set('Accept-Encoding', 'identity').expect(200);
const cents = v => Math.round(v * 100) / 100;
const privateIds = db
  .prepare('SELECT DISTINCT company_id id FROM position_facts p JOIN companies c ON c.id = p.company_id')
  .all()
  .map(r => r.id);
const QUARTERS = [];
for (let y = 2019; y <= 2026; y++)
  for (const md of ['03-31', '06-30', '09-30', '12-31']) if (`${y}-${md}` <= '2026-09-30') QUARTERS.push(`${y}-${md}`);
const scope = s => ({ firm: [], fund: [], class: [], kind: [], ...s });

test.before(() => {
  nock.disableNetConnect();
  nock.enableNetConnect('127.0.0.1');
});
test.after(() => nock.enableNetConnect());

test('facts: the table equals the activity walk over each company’s rows, leg for leg', () => {
  const norm = ls =>
    ls
      .map(({ until: _u, stops: _s, ...l }) =>
        JSON.stringify(
          Object.keys(l)
            .sort()
            .map(k => [k, l[k]])
        )
      )
      .sort();
  assert.ok(privateIds.length >= 4);
  for (const id of privateIds) {
    const table = analysis.legsFor(db, { companyId: id });
    const walk = factsOf(db, companyRows(db, { companyId: id }, '9999-12-31'), () => id);
    assert.deepEqual(norm(table), norm(walk), `company ${id}`);
  }
});

test('facts: every companyActivity event is one filing of legs with the same type and effects', () => {
  for (const id of privateIds) {
    const events = new Map();
    for (const l of analysis.legsFor(db, { companyId: id })) {
      const k = `${l.fund_key}|${l.accession}`;
      const e = events.get(k) || events.set(k, { type: l.event, change: 0, pos: 0, mark: 0 }).get(k);
      e.change += l.value - l.prev_value;
      e.pos += l.position_effect;
      e.mark += l.mark_effect;
    }
    const acts = companyActivity(db, { companyId: id }, { includeUnchanged: true });
    assert.equal(events.size, acts.length, `company ${id}`);
    for (const a of acts) {
      const e = events.get(`${a.fundKey}|${a.accession}`);
      assert.equal(e.type, a.type);
      assert.equal(cents(e.change), cents(a.valueChange));
      assert.equal(cents(e.pos), cents(a.positionEffect));
      assert.equal(cents(e.mark), cents(a.markEffect));
    }
  }
});

test('facts: lots of one instrument are one leg (the key is unique per filing)', () => {
  const dup = db
    .prepare(
      `SELECT accession, company_id, instrument_key, COUNT(*) n FROM position_facts GROUP BY 1, 2, 3 HAVING n > 1`
    )
    .all();
  assert.deepEqual(dup, []);
});

test('bridge: start and end equal exposureAsOf at every quarter end, and the steps reconcile to the cent', () => {
  let windows = 0;
  let stopped = 0;
  let started = 0;
  for (const id of privateIds) {
    const series = exposureSeries(db, { companyId: id, dates: QUARTERS });
    for (let i = 1; i < QUARTERS.length; i++) {
      const b = analysis.bridge(db, { ref: { companyId: id }, from: QUARTERS[i - 1], to: QUARTERS[i] });
      assert.equal(cents(b.start.value), cents(series[i - 1].total), `${id} ${QUARTERS[i - 1]}`);
      assert.equal(cents(b.end.value), cents(series[i].total), `${id} ${QUARTERS[i]}`);
      assert.equal(b.start.funds, series[i - 1].funds);
      assert.equal(b.end.funds, series[i].funds);
      assert.ok(b.reconciled && Math.abs(b.residual) < 0.005, `${id} ${QUARTERS[i]} residual ${b.residual}`);
      stopped += b.steps.find(s => s.key === 'stopped').value;
      started += b.steps.find(s => s.key === 'started').value;
      windows++;
    }
  }
  assert.ok(windows > 100);
  // The fixture exercises both filing-status steps.
  assert.ok(stopped < 0 && started > 0, `stopped ${stopped}, started ${started}`);
  // Across all private companies at once (no subject) the same holds.
  const all = analysis.bridge(db, { from: '2025-06-30', to: '2026-06-30' });
  const total = d => privateIds.reduce((t, id) => t + exposureAsOf(db, { companyId: id, date: d }).total, 0);
  assert.equal(cents(all.start.value), cents(total('2025-06-30')));
  assert.equal(cents(all.end.value), cents(total('2026-06-30')));
  assert.ok(all.reconciled);
});

test('bridge: Growth Fund of America in Stripe, 2025-11-30..2026-05-31 = +$212,419,557.74 mark, +$149,999,976 added (F43)', async () => {
  const b = (await api(`/api/companies/${idOf('Stripe')}/bridge?fund=S000009228&from=2025-11-30&to=2026-05-31`)).body;
  const step = k => cents(b.steps.find(s => s.key === k).value);
  assert.equal(cents(b.start.value), 407711681.26);
  assert.equal(step('mark'), 212419557.74);
  assert.equal(step('added'), 149999976);
  assert.equal(cents(b.end.value), 770131215);
  assert.deepEqual(
    b.steps.filter(s => !['mark', 'added'].includes(s.key)).map(s => s.value),
    [0, 0, 0, 0, 0, 0]
  );
  assert.equal(b.residual, 0);
  assert.deepEqual(b.scope, { fund: ['S000009228'] });
});

test('bridge: the F13 3:1 split moves neither position nor mark (T. Rowe Databricks, 2022-08-31)', () => {
  const legs = analysis
    .legsFor(db, { companyId: idOf('Databricks') })
    .filter(l => l.accession === '0001752724-22-239970');
  assert.ok(legs.length > 0 && legs.every(l => l.split === 3));
  for (const l of legs)
    assert.ok(Math.abs(l.position_effect) < 0.01 && Math.abs(l.value - l.prev_value - l.mark_effect) < 0.01);
});

test('pivot: firm rows equal the firm list (value, funds holding) at every quarter end', () => {
  const p = analysis.pivot(db, { rows: 'firm', period: 'quarter', from: '2024-12-31', to: '2026-06-30', limit: 1000 });
  assert.deepEqual(
    p.periods.map(x => x.label),
    ['2025Q1', '2025Q2', '2025Q3', '2025Q4', '2026Q1', '2026Q2']
  );
  p.periods.forEach((per, i) => {
    const by = new Map(firm.firms(db, { date: per.to, limit: 1000 }).results.map(f => [f.id, f]));
    for (const r of p.results.filter(r => r.key !== 0)) {
      assert.equal(cents(r.value[i]), cents(by.get(r.key)?.value || 0), `${r.label} ${per.to}`);
      assert.equal(r.holders[i], by.get(r.key)?.fundsHolding || 0, `${r.label} ${per.to}`);
    }
  });
});

test('pivot: company rows in a firm scope equal the firm book and exposureAsOf (A3: Capital Group Anthropic)', () => {
  const cg = firmIdOf('Capital Group (American Funds)');
  const p = analysis.pivot(db, {
    rows: 'company',
    period: 'quarter',
    from: '2025-12-31',
    to: '2026-06-30',
    scope: scope({ firm: [cg] }),
  });
  const a = p.results.find(r => r.key === idOf('Anthropic'));
  const book = firm.firmExposureByCompany(db, cg, idOf('Anthropic'), '2026-06-30');
  assert.equal(a.holders[1], book.funds);
  assert.equal(cents(a.value[1]), cents(book.value));
  // Each period's flows reconcile: start + flows = end, per row.
  for (const r of p.results)
    r.value.forEach((v, i) => {
      const before = i ? r.value[i - 1] : r.startValue;
      const flows = ['firstReported', 'added', 'reduced', 'exited', 'mark', 'valueOnly', 'started', 'stopped'].reduce(
        (t, k) => t + r[k][i],
        0
      );
      assert.ok(Math.abs(before + flows - v) < 0.005, `${r.label} period ${i}`);
    });
});

test('pivot: class rows need nothing else and split one company by class; the total counts each fund once', () => {
  const p = analysis.pivot(db, {
    ref: { companyId: idOf('Anthropic') },
    rows: 'class',
    period: 'year',
    from: '2024-12-31',
    to: '2026-06-30',
  });
  const x = exposureAsOf(db, { companyId: idOf('Anthropic'), date: '2026-06-30' });
  const sum = p.results.reduce((t, r) => t + r.value[r.value.length - 1], 0);
  assert.equal(cents(sum), cents(x.total));
  assert.equal(cents(p.total.value[p.total.value.length - 1]), cents(x.total));
  assert.equal(p.total.holders[p.total.holders.length - 1], x.funds);
  assert.ok(p.results.some(r => r.label === 'Anthropic · Series G'));
  assert.equal(p.periods[p.periods.length - 1].partial, true); // 2026 is cut at June 30
});

test('scope: firm, fund, class and kind filters equal a post-filter of the unfiltered answer', async () => {
  const id = idOf('Anthropic');
  const date = '2026-06-30';
  const full = (await api(`/api/companies/${id}/exposure?date=${date}`)).body;
  const cg = firmIdOf('Capital Group (American Funds)');
  const byFirm = (await api(`/api/companies/${id}/exposure?date=${date}&firm=${cg}`)).body;
  const expected = full.holdings.filter(h => h.firms.some(f => f.id === cg));
  assert.deepEqual(
    byFirm.holdings.map(h => h.fundKey),
    expected.map(h => h.fundKey)
  );
  assert.equal(cents(byFirm.total), cents(expected.reduce((t, h) => t + h.value, 0)));
  assert.deepEqual(byFirm.scope, { firm: [cg] });

  const g = (await api(`/api/companies/${id}/exposure?date=${date}&class=${encodeURIComponent('Series G')}`)).body;
  const gPositions = full.holdings.flatMap(h => h.positions.filter(p => p.classLabel === 'Series G'));
  assert.ok(gPositions.length > 0);
  assert.equal(cents(g.total), cents(gPositions.reduce((t, p) => t + p.valueUsd, 0)));
  assert.ok(g.holdings.every(h => h.positions.every(p => p.classLabel === 'Series G')));

  const ind = (await api(`/api/companies/${id}/exposure?date=${date}&kind=indirect`)).body;
  const indPositions = full.holdings.flatMap(h => h.positions.filter(p => p.kind !== 'direct'));
  assert.equal(cents(ind.total), cents(indPositions.reduce((t, p) => t + p.valueUsd, 0)));

  const fundKey = full.holdings[0].fundKey;
  const acts = (await api(`/api/companies/${id}/activity`)).body.events.filter(e => e.fundKey === fundKey);
  const scoped = (await api(`/api/companies/${id}/activity?fund=${fundKey}`)).body.events;
  assert.deepEqual(
    scoped.map(e => e.accession),
    acts.map(e => e.accession)
  );
  // The trend, classes and marks answer within the scope too.
  const trend = (await api(`/api/companies/${id}/trend?firm=${cg}`)).body.points.find(p => p.date === date);
  assert.equal(cents(trend.total), cents(byFirm.total));
  const classes = (await api(`/api/companies/${id}/classes?date=${date}&class=${encodeURIComponent('Series G')}`)).body;
  assert.deepEqual(
    classes.classes.map(c => c.instrument),
    ['Series G']
  );
});

test('scope: a class-scoped bridge equals exposureAsOf of that class and reconciles', () => {
  const id = idOf('Anthropic');
  const s = scope({ class: ['Series G'] });
  const only = scopes.rowPredicate(db, s);
  const b = analysis.bridge(db, { ref: { companyId: id }, scope: s, from: '2025-12-31', to: '2026-06-30' });
  const at = d => exposureAsOf(db, { companyId: id, only, date: d });
  assert.equal(cents(b.start.value), cents(at('2025-12-31').total));
  assert.equal(cents(b.end.value), cents(at('2026-06-30').total));
  assert.ok(b.reconciled);
  // Every row the predicate keeps is a Series G row.
  assert.ok(companyRows(db, { companyId: id, only }, '9999-12-31').every(r => classOfRow(rowInfo(r)) === 'Series G'));
});

test('scope: bad filters and class without a company answer 400', async () => {
  await request(app)
    .get(`/api/companies/${idOf('Anthropic')}/exposure?kind=listed`)
    .expect(400);
  await request(app)
    .get(`/api/companies/${idOf('Anthropic')}/exposure?firm=abc`)
    .expect(400);
  await request(app).get('/api/analysis/bridge?class=Series%20G').expect(400);
  await request(app).get('/api/analysis/pivot?rows=country').expect(400);
  await request(app).get('/api/analysis/timeline').expect(400);
});

test('timeline: a firm’s events equal firmChanges by type, and its value equals the firm book', () => {
  const cg = firmIdOf('Capital Group (American Funds)');
  const t = analysis.timeline(db, { firm: cg });
  const changes = firm.firmChanges(db, cg, { since: '2019-01-01' }).events.filter(e => e.type !== 'unchanged');
  const count = new Map();
  for (const c of t.companies) for (const e of c.events) count.set(e.type, (count.get(e.type) || 0) + e.funds);
  const expected = new Map();
  for (const e of changes) expected.set(e.type, (expected.get(e.type) || 0) + 1);
  assert.deepEqual(Object.fromEntries([...count].sort()), Object.fromEntries([...expected].sort()));
  const book = firm.firmBook(db, cg, { date: t.asOf });
  for (const c of book.byCompany) {
    const x = t.companies.find(y => y.companyId === c.companyId);
    assert.equal(cents(x.value), cents(c.value), c.name);
    assert.equal(x.funds, c.funds, c.name);
  }
  assert.equal(t.attribution, 'current adviser (latest N-CEN)');
});

test('positions: one fund’s Stripe history through the API, every leg with its accession', async () => {
  const b = (await api(`/api/companies/${idOf('Stripe')}/positions/S000009228?instrument=ECS282034`)).body;
  assert.equal(b.fund.fundKey, 'S000009228');
  const last = b.legs.find(l => l.accession === '0001193125-26-323081');
  assert.deepEqual(
    [last.prevBalance, last.balance, last.change, cents(last.positionEffect)],
    [1123404, 3504356, 'added', 149999976]
  );
  assert.ok(b.legs.every(l => l.instrumentKey === 'ECS282034' && l.accession));
  await request(app)
    .get(`/api/companies/${idOf('Stripe')}/positions/S999999999`)
    .expect(404);
});

test('analysis routes: bridge and pivot across companies, timeline by firm and fund', async () => {
  const b = (await api('/api/analysis/bridge?from=2025-06-30&to=2026-06-30')).body;
  assert.ok(b.reconciled);
  const cg = firmIdOf('Capital Group (American Funds)');
  const p = (await api(`/api/analysis/pivot?rows=fund&period=quarter&from=2025-12-31&to=2026-06-30&firm=${cg}`)).body;
  assert.ok(p.results.length > 0 && p.results.every(r => r.label));
  const t = (await api(`/api/analysis/timeline?firm=${cg}`)).body;
  assert.equal(t.firmInfo.id, cg);
  const f = (await api('/api/analysis/timeline?fund=S000009228')).body;
  assert.ok(f.companies.some(c => c.companyId === idOf('Stripe')));
  const c = (await api(`/api/analysis/bridge?company=${idOf('Stripe')}&fund=S000009228&from=2025-11-30&to=2026-05-31`))
    .body;
  assert.equal(c.company.name, 'Stripe');
  assert.equal(cents(c.end.value), 770131215);
});

test('search: one ranked list over companies, firms, funds and classes; only a clear top result is strong', async () => {
  const r = (await api('/api/search?q=anthropic%20series%20g&kinds=company,entity,firm,fund,class')).body.results;
  assert.deepEqual([r[0].type, r[0].classLabel, r[0].strong], ['class', 'Series G', true]);
  assert.equal(r[1].type, 'company');
  const cg = (await api('/api/search?q=capital%20group&kinds=firm')).body.results;
  assert.equal(cg[0].type, 'firm');
  assert.equal(cg[0].id, firmIdOf('Capital Group (American Funds)'));
  const gfa = (await api('/api/search?q=growth%20fund%20of%20america&kinds=fund')).body.results;
  assert.equal(gfa[0].fundKey, 'S000009228');
  // Without kinds the answer is the company search, unchanged.
  const plain = (await api('/api/search?q=stripe')).body.results;
  assert.equal(plain[0].type, 'company');
  await request(app).get('/api/search?q=stripe&kinds=planet').expect(400);
});

test('position facts: a failed build rolls back and is logged as failed', () => {
  const { db: d } = require('./helpers/warehouseFixture').openFixtureWarehouse();
  d.prepare(
    "INSERT INTO position_facts (fund_key, company_id, accession, report_date, filing_date, event, change, instrument_key, class_label, kind, value, prev_value, per_share, position_effect, mark_effect, other_effect) VALUES ('X', 1, 'A', '2026-01-01', '2026-01-01', 'new', 'new class', 'K', 'Common', 'direct', 1, 0, 1, 1, 0, 0)"
  ).run();
  d.exec("CREATE TRIGGER no_facts BEFORE INSERT ON position_facts BEGIN SELECT RAISE(ABORT, 'blocked'); END");
  d.prepare("INSERT OR IGNORE INTO companies (id, name, status) VALUES (1, 'Test company', 'private')").run();
  d.prepare('UPDATE holdings SET company_id = 1 WHERE rowid IN (SELECT rowid FROM holdings LIMIT 5)').run();
  assert.throws(() => buildPositionFacts(d), /blocked/);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM position_facts').get().n, 1); // the old table stands
  const log = d.prepare("SELECT status, error FROM ingest_log WHERE kind = 'position-facts' ORDER BY id DESC").get();
  assert.deepEqual([log.status, log.error], ['failed', 'blocked']);
});

test('bridge: Fidelity Select Technology’s move to segregated lines is a mark move only (F44, trap 52)', async () => {
  const b = (await api(`/api/companies/${idOf('Databricks')}/bridge?fund=S000007484&from=2026-02-28&to=2026-05-31`))
    .body;
  const step = k => cents(b.steps.find(s => s.key === k).value);
  assert.equal(step('mark'), 5080773.7);
  assert.deepEqual([step('added'), step('reduced'), step('firstReported'), step('exited')], [0, 0, 0, 0]);
  const ev = (await api(`/api/companies/${idOf('Databricks')}/activity?fund=S000007484`)).body.events.find(
    e => e.accession === '0000035402-26-004764'
  );
  assert.deepEqual([ev.type, ev.label], ['unchanged', 'mark moved']);
  // A class filter includes its segregated lines.
  const h = (
    await api(`/api/companies/${idOf('Databricks')}/exposure?date=2026-05-31&fund=S000007484&class=Series%20H`)
  ).body;
  assert.equal(h.holdings[0].positions.length, 2);
  assert.equal(cents(h.total), 29961860 + 22060900);
});

// ── P6b W2: the company workbench's answers ──

test('legs: each fund’s legs in force at D sum to exposureAsOf, filtered or not', async () => {
  for (const id of privateIds)
    for (const date of ['2025-06-30', '2026-03-31', '2026-06-30']) {
      const { legs } = analysis.legsAt(db, { companyId: id }, { date });
      const x = exposureAsOf(db, { companyId: id, date });
      assert.equal(cents(legs.reduce((t, l) => t + l.value, 0)), cents(x.total), `${id} ${date}`);
      assert.equal(new Set(legs.filter(l => l.value > 0).map(l => l.fundKey)).size, x.funds);
    }
  const cg = firmIdOf('Capital Group (American Funds)');
  const id = idOf('Anthropic');
  const b = (await api(`/api/companies/${id}/legs?date=2026-06-30&firm=${cg}`)).body;
  const e = (await api(`/api/companies/${id}/exposure?date=2026-06-30&firm=${cg}`)).body;
  assert.equal(cents(b.legs.reduce((t, l) => t + l.value, 0)), cents(e.total));
  // Growth Fund of America's latest Stripe filing as of 2026-05-31 is the F43 add.
  const s = (await api(`/api/companies/${idOf('Stripe')}/legs?date=2026-05-31&fund=S000009228`)).body.legs;
  const clB = s.find(l => l.instrumentKey === 'ECS282034');
  assert.deepEqual([clB.prevBalance, clB.balance, cents(clB.positionEffect)], [1123404, 3504356, 149999976]);
});

test('rows: the Filings tab lists each canonical filing’s rows as filed, in the range and scope', async () => {
  const id = idOf('Stripe');
  const all = (await api(`/api/companies/${id}/rows`)).body;
  const canonical = db
    .prepare(
      `SELECT COUNT(*) n FROM holdings h JOIN canonical_filings f ON f.accession = h.accession
       WHERE h.company_id = ? AND h.instrument_type IN ('equity','indirect','derivative')
         AND (h.value_usd > 0 AND (h.balance > 0 OR h.balance IS NULL OR h.balance = 0) OR NOT h.value_usd > 0)`
    )
    .get(id).n;
  assert.equal(all.count, canonical);
  const gfa = (await api(`/api/companies/${id}/rows?fund=S000009228&from=2026-05-01&to=2026-05-31`)).body.rows;
  assert.equal(gfa.length, 7);
  const r = gfa.find(x => x.otherId === 'ECS282034');
  assert.deepEqual(
    [r.balance, r.valueUsd, r.accession, r.markDate],
    [3504356, 220774428, '0001193125-26-323081', '2026-05-31']
  );
});

test('leadership: Stripe Common B $63.00 was first filed on 2026-02-28 by Capital Group and Fidelity', async () => {
  const L = (await api(`/api/companies/${idOf('Stripe')}/leadership?instrument=${encodeURIComponent('Common B')}`))
    .body;
  const lvl = L.levels.find(l => Math.abs(l.mark - 63) < 0.01);
  assert.equal(lvl.firstDate, '2026-02-28');
  const first = lvl.adopters
    .filter(a => a.lagDays === 0)
    .map(a => a.firm)
    .sort();
  assert.deepEqual(first, ['Capital Group (American Funds)', 'Fidelity']);
  // Every follower filed later, and its own previous mark date is shown.
  assert.ok(lvl.adopters.every(a => a.markDate >= lvl.firstDate && a.prevMarkDate < a.markDate));
  assert.ok(L.levels.every(l => l.instrument === 'Common B'));
});

// ── P6b W3: firm and fund pages ──

test('marks vs others: each firm mark and the others’ median equal a recomputation from stored rows', async () => {
  const cg = firmIdOf('Capital Group (American Funds)');
  const m = (await api(`/api/analysis/marks?firm=${cg}&date=2026-06-30`)).body;
  const managed = new Set(firm.fundFirms(db).byFirm.get(cg).managed);
  const median = xs => {
    const s = [...xs].sort((a, b) => a - b);
    const h = s.length >> 1;
    return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
  };
  const compared = m.rows.filter(r => r.othersMedian != null);
  assert.ok(compared.length >= 3);
  for (const r of m.rows) {
    const rows = keepRows(r.companyId).filter(
      x => x.report_date === r.markDate && x.counts && x.balance > 0 && x.unit === 'NS'
    );
    const same = rows.filter(x => classOfRow(rowInfo(x)).replace(/ \(segregated\)$/, '') === r.classLabel);
    const mine = same.filter(x => managed.has(x.fund_key)).map(x => x.value_usd / x.balance);
    const others = same.filter(x => !managed.has(x.fund_key)).map(x => x.value_usd / x.balance);
    assert.ok(mine.length > 0, `${r.company} ${r.classLabel} ${r.markDate}`);
    assert.ok(Math.abs(median(mine) - r.mark) < 0.01, `${r.company} ${r.classLabel}: ${median(mine)} vs ${r.mark}`);
    if (others.length)
      assert.ok(Math.abs(median(others) - r.othersMedian) < 0.01, `${r.company} ${r.classLabel} others`);
    else assert.equal(r.othersMedian, null);
  }
  const s = m.summary;
  assert.equal(s.above + s.same + s.below, s.compared);
  await request(app).get('/api/analysis/marks').expect(400);
});
const keepRowsCache = new Map();
function keepRows(companyId) {
  if (!keepRowsCache.has(companyId)) {
    const { keepCanonical } = require('../lib/analytics/asof');
    keepRowsCache.set(companyId, keepCanonical(db, companyRows(db, { companyId }, '9999-12-31')));
  }
  return keepRowsCache.get(companyId);
}

test('firm changes: pages reassemble the unpaged list; counts and totals cover every matching event', async () => {
  const cg = firmIdOf('Capital Group (American Funds)');
  const all = firm.firmChanges(db, cg, { since: '2019-01-01' }).events;
  const pages = [];
  for (let offset = 0; ; offset += 100) {
    const p = (await api(`/api/firms/${cg}/changes?since=2019-01-01&limit=100&offset=${offset}`)).body;
    assert.equal(p.count, all.length);
    pages.push(...p.events);
    if (offset + 100 >= p.count) break;
  }
  assert.deepEqual(
    pages.map(e => `${e.fundKey}|${e.accession}|${e.companyId}`),
    all.map(e => `${e.fundKey}|${e.accession}|${e.companyId}`)
  );
  const added = (await api(`/api/firms/${cg}/changes?since=2019-01-01&types=added&limit=5`)).body;
  assert.equal(added.count, all.filter(e => e.type === 'added').length);
  assert.ok(added.events.length <= 5 && added.events.every(e => e.type === 'added'));
  const sum = all.filter(e => e.type === 'added').reduce((t, e) => t + e.markEffect, 0);
  assert.equal(cents(added.totals.markEffect), cents(sum));
});
