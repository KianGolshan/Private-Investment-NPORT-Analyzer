// Phase 6 views on the golden fixture (test/fixtures/warehouse/, real rows):
// position changes, trends, share classes, firms, the market and the feed,
// each checked against GOLDEN-NUMBERS and against exposureAsOf (one definition,
// two answers: LESSONS 32). Through the API, with no SEC call.
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const nock = require('nock');
const { goldenWarehouse } = require('./helpers/warehouseApp');
const { exposureAsOf, exposureSeries, monthEnds } = require('../lib/analytics/asof');
const market = require('../lib/services/market');
const firm = require('../lib/services/firm');

const { db, app, idOf, firmIdOf } = goldenWarehouse();
// nock (no SEC calls) aborts large gzipped bodies; gzip itself is tested in
// test/api-warehouse.test.js, and real HTTP serves these answers gzipped.
const api = url => request(app).get(url).set('Accept-Encoding', 'identity').expect(200);
const billions = v => Math.round(v / 1e7) / 100;

test.before(() => {
  nock.disableNetConnect();
  nock.enableNetConnect('127.0.0.1');
});
test.after(() => nock.enableNetConnect());

test('activity: Fidelity OTC Portfolio no longer reports Stripe at 2026-01-31 (F8/F9)', async () => {
  const { events } = (await api(`/api/companies/${idOf('Stripe')}/activity`)).body;
  const otc = events.find(e => e.accession === '0000035402-26-002031');
  assert.deepEqual([otc.type, otc.label, otc.prevAccession], ['exited', 'no longer reported', '0000035402-25-002966']);
  assert.equal(otc.markDate, '2026-01-31');
});

test('activity: Capital Group marks Stripe $33.73 -> $35.50 -> $41.42 -> $63.00 (Growth Fund of America)', async () => {
  const { events } = (await api(`/api/companies/${idOf('Stripe')}/activity`)).body;
  const gfa = events.filter(e => e.fundKey === 'S000009228');
  const at = acc => gfa.find(e => e.accession === acc).instruments[0];
  const path = [
    ['0001193125-25-251567', 33.73, 35.5],
    ['0001193125-26-027715', 35.5, 41.42],
    ['0001193125-26-182055', 41.42, 63.0],
  ];
  for (const [acc, prev, cur] of path) {
    const leg = at(acc);
    assert.deepEqual([Math.round(leg.prevPrice * 100) / 100, Math.round(leg.price * 100) / 100], [prev, cur], acc);
  }
  // 2025-05-31 repeated $33.73 with no share change: nothing to report.
  assert.ok(!gfa.some(e => e.accession === '0001145549-25-048194'));
});

test('activity: a 3:1 split is not an add (F13, T. Rowe Databricks 2022-08-31)', async () => {
  const { events } = (await api(`/api/companies/${idOf('Databricks')}/activity`)).body;
  const e = events.find(x => x.accession === '0001752724-22-239970');
  assert.equal(e.type, 'unchanged');
  assert.ok(e.instruments.every(i => i.split === 3 && i.change === 'unchanged'));
});

test('trend: the monthly series equals exposureAsOf at A1 and A2 (72 / $5.93B, 117 / $17.26B)', async () => {
  const { points } = (await api(`/api/companies/${idOf('Anthropic')}/trend`)).body;
  const at = d => points.find(p => p.date === d);
  assert.deepEqual([at('2026-03-31').funds, billions(at('2026-03-31').total)], [72, 5.93]);
  assert.deepEqual([at('2026-06-30').funds, billions(at('2026-06-30').total)], [117, 17.26]);
  assert.equal(points[0].date, '2023-04-30'); // first mark 2023-04-28
  const dates = monthEnds('2024-01-01', '2026-07-31');
  const series = exposureSeries(db, { companyId: idOf('Stripe'), dates });
  for (const [i, d] of dates.entries()) {
    const x = exposureAsOf(db, { companyId: idOf('Stripe'), date: d });
    assert.deepEqual([series[i].funds, Math.round(series[i].total)], [x.funds, Math.round(x.total)], d);
  }
});

test('classes: Fidelity marks Anthropic Series D 5.76% above Series E-H in one filing (F30)', async () => {
  const c = (await api(`/api/companies/${idOf('Anthropic')}/classes?date=2026-05-31`)).body;
  const fid = c.withinFiling.find(w => w.accession === '0000035402-26-004618');
  const d = fid.classes.find(x => x.instrument === 'Series D');
  const g = fid.classes.find(x => x.instrument === 'Series G');
  assert.equal(Math.round(d.pricePerShare * 100) / 100, 622.94);
  assert.equal(Math.round(g.pricePerShare * 100) / 100, 589.01);
  assert.equal(Math.round(d.vsLowPct * 100) / 100, 5.76);
  assert.equal(fid.firm, 'Fidelity');
  // Capital Group marks every class alike at 5/31 (F30): no within-filing gap.
  assert.ok(!c.withinFiling.some(w => w.accession === '0001193125-26-323081'));
  const marks = (await api(`/api/companies/${idOf('Anthropic')}/marks`)).body;
  assert.ok(marks.series.some(s => s.markDate === '2026-05-31' && s.instrument === 'Series D' && s.median > 622));
});

test('firm: Capital Group holds Anthropic in 9 funds / $8.46B at 2026-06-30 (A3), equal to exposureAsOf', async () => {
  const id = firmIdOf('Capital Group (American Funds)');
  const book = (await api(`/api/firms/${id}?date=2026-06-30`)).body;
  const anthropic = book.byCompany.find(c => c.name === 'Anthropic');
  assert.deepEqual([anthropic.funds, billions(anthropic.value)], [9, 8.46]);
  const x = firm.firmExposureByCompany(db, id, idOf('Anthropic'), '2026-06-30');
  assert.deepEqual([x.funds, Math.round(x.value)], [anthropic.funds, Math.round(anthropic.value)]);
  // F17: the ninth holder is the AFIS Capital World Growth & Income series, $0.66M.
  const afis = anthropic.positions.find(p => p.accession === '0001193125-26-371285');
  assert.equal(Math.round(afis.value / 1e4) / 100, 0.66);
});

test("company holders by firm: filtering Anthropic's holders to a firm equals that firm's book (A3), one definition", async () => {
  const id = firmIdOf('Capital Group (American Funds)');
  const x = (await api(`/api/companies/${idOf('Anthropic')}/exposure?date=2026-06-30`)).body;
  const mine = x.holdings.filter(h => h.firms.some(f => f.id === id));
  const book = (await api(`/api/firms/${id}?date=2026-06-30`)).body.byCompany.find(c => c.name === 'Anthropic');
  assert.equal(mine.length, book.funds);
  assert.equal(Math.round(mine.reduce((s, h) => s + h.value, 0)), Math.round(book.value));
  // positions carry the class the class views group by; pctNav stays the filed percent (0.83 = 0.83%)
  const gfa = x.holdings.find(h => h.accession === '0001193125-26-323081');
  const g1 = gfa.positions.find(p => p.classLabel === 'Series G-1');
  assert.ok(g1 && g1.pctNav > 0.5 && g1.pctNav < 1, `G-1 is ${g1?.pctNav}% of the fund`);
  // changes carry the same firms
  const { events } = (await api(`/api/companies/${idOf('Anthropic')}/activity`)).body;
  assert.ok(events.filter(e => e.fundKey === gfa.fundKey).every(e => e.firms.some(f => f.id === id)));
});

test("trap 50: one series across filers' categories; a CLASS code with common wording stays common", () => {
  const { classOfRow } = require('../lib/services/classes');
  // Anthropic Series G: BlackRock files EC, Fidelity EP; Capital Group "CL G-1 PFD", NY Life "Series G-1" (EC)
  assert.equal(classOfRow({ instrumentLabel: 'Common G', title: 'ANTHROPIC SERIES G' }), 'Series G');
  assert.equal(classOfRow({ instrumentLabel: 'Preferred G', title: 'ANTHROPIC PBC SERIES G PC PP' }), 'Series G');
  assert.equal(
    classOfRow({ instrumentLabel: 'Preferred G-1', title: 'ANTHROPIC PBC CL G-1 PFD PP (PHYSICAL)' }),
    'Series G-1'
  );
  assert.equal(classOfRow({ instrumentLabel: 'Common G-1', title: 'Anthropic PBC, Series G-1' }), 'Series G-1');
  // Stripe Class B common stays common, by the filer's words (CL B, or explicit COMMON)
  assert.equal(
    classOfRow({ instrumentLabel: 'Common B', title: 'STRIPE INC CL B PP (DRS) (NOT LISTED OR TRADING)' }),
    'Common B'
  );
  assert.equal(classOfRow({ instrumentLabel: 'Common B', title: 'STRIPE INC CL B COMMON PP' }), 'Common B');
  assert.equal(
    classOfRow({ instrumentLabel: 'Preferred I', title: 'STRIPE INC PFD SER I 6.00% NON-CUM PP' }),
    'Series I'
  );
  // a class code only in the issuer field (T. Rowe Price Canva, 0001099263-26-009584)
  assert.equal(
    classOfRow({
      instrumentLabel: 'Common',
      title: 'CANVA COMMON STOCK PP',
      issuerName: 'CANVA CLASS B COMMON STOCK PP',
    }),
    'Common B'
  );
  // uncoded labels and vehicles are unchanged
  assert.equal(classOfRow({ instrumentLabel: 'Preferred', title: 'Anthropic PBC' }), 'Preferred');
  assert.equal(classOfRow({ instrumentLabel: 'Indirect via ANTHROPIC', title: 'ANTHROPIC' }), 'Indirect via ANTHROPIC');
});

test('kind: named SPVs and fund interests are both indirect, one definition (asof.kindOf)', async () => {
  const x = (await api(`/api/companies/${idOf('Anthropic')}/exposure?date=2026-06-30`)).body;
  const kinds = new Set(x.holdings.flatMap(h => h.positions.map(p => p.kind)));
  assert.ok(kinds.has('direct'));
  for (const h of x.holdings) for (const p of h.positions) assert.equal(p.kind === 'spv', p.viaSpv);
  const top = (await api('/api/market/top?date=2026-06-30&limit=50')).body.results.find(r => r.name === 'Anthropic');
  const indirect = x.holdings.flatMap(h => h.positions).filter(p => p.kind !== 'direct');
  assert.equal(Math.round(top.indirectValue), Math.round(indirect.reduce((s, p) => s + p.valueUsd, 0)));
});

test('changes split into position and mark effects that sum to the value change (F39)', async () => {
  const { events } = (await api(`/api/companies/${idOf('Anthropic')}/activity`)).body;
  for (const e of events)
    assert.ok(Math.abs(e.positionEffect + e.markEffect + e.otherEffect - e.valueChange) < 0.01, e.accession);
  const gfa = events.find(e => e.accession === '0001193125-26-323081');
  assert.equal(gfa.positionEffect.toFixed(2), '305781925.89');
  assert.equal(gfa.markEffect.toFixed(2), '2617600776.30');
});

test('a 3:1 split is neither a position nor a mark change (F13)', async () => {
  const { events } = (await api(`/api/companies/${idOf('Databricks')}/activity`)).body;
  const legs = events.flatMap(e => e.instruments).filter(l => l.split === 3);
  assert.ok(legs.length > 0);
  for (const l of legs) assert.ok(Math.abs(l.positionEffect) < 1, `${l.title}: ${l.positionEffect}`);
});

test('stale marks look up each fund\'s class the way the class views name it (never "Unlabeled")', () => {
  const { companyHistory } = require('../lib/analytics/asof');
  const { classOfRow } = require('../lib/services/classes');
  const marks = require('../lib/services/marks');
  for (const name of ['Anthropic', 'Stripe', 'Databricks']) {
    const known = new Set(marks.classMarks(db, { companyId: idOf(name) }).classes);
    for (const f of companyHistory(db, { companyId: idOf(name) }))
      for (const s of f.series) {
        const last = s.points.filter(p => p.pricePerShare != null).at(-1);
        if (last) assert.ok(known.has(classOfRow(last)), `${name} ${f.fundKey} ${classOfRow(last)}`);
      }
  }
});

test('firm: Capital Group marks Stripe in 8 of 12 months of 2025, at one price per date', async () => {
  const id = firmIdOf('Capital Group (American Funds)');
  const m = (await api(`/api/firms/${id}/marks/${idOf('Stripe')}`)).body;
  const y2025 = m.series.filter(s => s.markDate.startsWith('2025'));
  assert.deepEqual([...new Set(y2025.map(s => s.markDate.slice(5, 7)))].sort(), [
    '02',
    '03',
    '05',
    '06',
    '08',
    '09',
    '11',
    '12',
  ]);
  // one price per date ($33.725 sits on a half cent, so compare relatively, not in rounded cents)
  for (const s of y2025) assert.ok(s.high / s.low - 1 < 1e-6, `${s.markDate} ${s.instrument}`);
  const changes = (await api(`/api/firms/${id}/changes?since=2025-01-01`)).body;
  assert.ok(changes.events.length > 0);
  assert.ok(changes.events.every(e => e.markDate >= '2025-01-01' && e.fundLabel));
});

test('market: every company in the top list equals exposureAsOf at that date', async () => {
  const top = (await api('/api/market/top?date=2026-06-30')).body;
  assert.ok(top.results.length >= 3);
  for (const r of top.results) {
    const x = exposureAsOf(db, { companyId: r.companyId, date: '2026-06-30' });
    assert.deepEqual([r.funds, Math.round(r.value)], [x.funds, Math.round(x.total)], r.name);
  }
  assert.equal(top.results[0].name, 'Anthropic');
  const c = market.countries(db, { date: '2026-06-30' });
  assert.ok(Math.abs(c.results.reduce((s, r) => s + r.value, 0) - top.totalValue) < 1);
});

test("feed: the filings made on 2026-07-29 include Growth Fund of America's 5/31 Anthropic marks (F2)", async () => {
  const f = (await api('/api/feed?since=2026-07-29&until=2026-07-29')).body;
  const gfa = f.events.find(e => e.accession === '0001193125-26-323081' && e.company === 'Anthropic');
  assert.ok(gfa, 'F2 is in the feed');
  assert.equal(gfa.markDate, '2026-05-31');
  assert.equal(gfa.filingDate, '2026-07-29');
  assert.ok(f.events.every(e => e.tracked));
  await request(app).get('/api/feed?since=2026-01-01&until=2026-06-30').expect(400); // over 92 days
});

test('fund changes: Growth Fund of America reports its Stripe marks filing by filing', async () => {
  const r = (await api('/api/funds/S000009228/changes')).body;
  const s = r.events.find(e => e.accession === '0001193125-26-182055' && e.company === 'Stripe');
  assert.ok(Math.abs(s.markChangePct - 52.1) < 0.1);
});

test('marks use canonical filings only: an amended filing replaces the original (F16 rule)', () => {
  // S000002245 filed its 2025-10-31 report twice: 0002071691-25-009460, then 0002071691-26-013202.
  const superseded = '0002071691-25-009460';
  assert.equal(db.prepare('SELECT COUNT(*) n FROM canonical_filings WHERE accession = ?').get(superseded).n, 0);
  const owners = firm.fundFirms(db).byFund.get('S000002245') || [];
  assert.ok(owners.length, 'the fund has a firm');
  for (const { managerId } of owners) {
    const m = firm.firmMarks(db, managerId, idOf('Anthropic'));
    const used = m.series.flatMap(x => x.accessions);
    assert.ok(used.includes('0002071691-26-013202'), 'the amendment is used');
    assert.ok(!used.includes(superseded), 'the superseded filing is not');
  }
});

test('tracked dashboard: holders now and a year earlier equal exposureAsOf for every tracked company', async () => {
  const r = (await api('/api/market/tracked?date=2026-06-30')).body;
  assert.equal(r.yearAgo, '2025-06-30');
  for (const c of r.companies.filter(x => x.funds || x.fundsYearAgo)) {
    const now = exposureAsOf(db, { companyId: c.companyId, date: '2026-06-30' });
    const then = exposureAsOf(db, { companyId: c.companyId, date: '2025-06-30' });
    assert.deepEqual([c.funds, c.fundsYearAgo], [now.funds, then.funds], c.name);
  }
  const stripe = r.companies.find(c => c.name === 'Stripe');
  assert.deepEqual([stripe.funds, stripe.fundsYearAgo, stripe.holderChange], [37, 49, -12]); // A5
  assert.ok(stripe.markChange12mPct > 0 && stripe.markChangeFunds > 0);
});

test('R14: dashboard fund counts are distinct funds, and a past date never reads later filings', () => {
  const Database = require('better-sqlite3');
  const { trackedDashboard } = require('../lib/services/dashboard');
  const { staleMarks } = require('../lib/services/marks');
  const { companyHistory } = require('../lib/analytics/asof');
  const D = '2026-03-31';
  const copy = new Database(db.serialize());
  const before = trackedDashboard(copy, { date: D });
  for (const c of before.companies) {
    const funds = new Set(companyHistory(copy, { companyId: c.companyId }).map(f => f.fundKey));
    assert.ok(c.markChangeFunds <= funds.size, `${c.name}: counts funds, not fund × class series`);
    const stale = staleMarks(copy, { companyId: c.companyId }, { asOf: D }).stale;
    assert.equal(c.staleFunds, new Set(stale.map(x => x.fundKey)).size, c.name);
  }
  // later filings arrive: drop everything after D and the past answer is the same
  const truncated = new Database(db.serialize());
  truncated.pragma('foreign_keys = ON');
  truncated.prepare('DELETE FROM filings WHERE report_date > ?').run(D);
  const cut = trackedDashboard(truncated, { date: D });
  const pick = r => r.companies.map(c => [c.name, c.staleFunds, c.markChangeFunds, c.funds]);
  assert.deepEqual(pick(cut), pick(before));
  copy.close();
  truncated.close();
});

test('stale marks: every flagged series really repeats its mark while the class median moved', async () => {
  const id = idOf('Databricks');
  const st = (await api(`/api/companies/${id}/stale?min=2`)).body;
  const h = (await api(`/api/companies/${id}/history`)).body;
  for (const x of st.stale) {
    const pts = h.funds
      .find(f => f.fundKey === x.fundKey)
      .series.flatMap(s => s.points)
      .filter(p => p.markDate >= x.unchangedSince && p.markDate <= x.lastMarkDate && p.pricePerShare != null);
    assert.ok(
      pts.some(p => Math.abs(p.pricePerShare - x.pricePerShare) < 1e-6),
      x.fund
    );
    assert.ok(x.reports >= 2 && Math.abs(x.marketMovePct) > 1, x.fund);
  }
});

test('Atom feed: a company feed lists its changes with their filings (Stripe: Fidelity OTC, F9)', async () => {
  const r = await request(app)
    .get(`/api/companies/${idOf('Stripe')}/feed.xml`)
    .set('Accept-Encoding', 'identity');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /application\/atom\+xml/);
  assert.match(r.text, /^<\?xml version="1\.0"/);
  assert.match(r.text, /<feed xmlns="http:\/\/www\.w3\.org\/2005\/Atom">/);
  assert.ok((r.text.match(/<entry>/g) || []).length > 0);
});

// Staff review F06: a class's per-date row counts funds, not lots, and its
// median is across funds (one observation per fund: its lots' value over shares).
test('classes: Anthropic 2026-06-30 Common counts 13 funds, the PBC line 1 (F06)', async () => {
  const c = (await api(`/api/companies/${idOf('Anthropic')}/classes?date=2026-06-30`)).body;
  const at = name => c.classes.find(x => x.instrument === name).byMarkDate.find(d => d.markDate === '2026-06-30');
  assert.equal(at('Common').funds, 13);
  assert.equal(at('Indirect via ANTHROPIC PBC').funds, 1);
});

test('markStats: a fund with several lots is one observation at value / shares (F06)', () => {
  const { markStats } = require('../lib/services/classes');
  // A: 100 sh $1,000 + 300 sh $3,600 -> $11.50; B $12.00; C $20.00. Median $12.00 (not 11 of 4 rows)
  const s = markStats([
    { fundKey: 'A', value: 1000, shares: 100 },
    { fundKey: 'A', value: 3600, shares: 300 },
    { fundKey: 'B', value: 1200, shares: 100 },
    { fundKey: 'C', value: 2000, shares: 100 },
  ]);
  assert.deepEqual(s, { funds: 3, median: 12, low: 11.5, high: 20, severalMarks: 1 });
});

test('cross-company answers say how they read history; company answers do not need to (F14)', async () => {
  for (const url of [
    '/api/market/top?date=2026-06-30',
    '/api/firms',
    '/api/analysis/pivot?rows=company&from=2026-01-01&to=2026-06-30',
  ]) {
    const b = (await api(url)).body;
    assert.match(b.basis?.companies || '', /today's reviewed list/, url);
    assert.match(b.basis?.firms || '', /current adviser/, url);
  }
  assert.equal((await api(`/api/companies/${idOf('Stripe')}/exposure?date=2026-06-30`)).body.basis, undefined);
});
