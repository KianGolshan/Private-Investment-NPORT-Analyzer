// Phase 5b task 5: peer analytics in lib/analytics/peer.js, shared by the
// browser (/peer.js; the v1 UI tests in app-marks and app-leaderboard run it
// there) and Node. Here in Node, on real warehouse rows (the golden fixture):
// Capital Group's Stripe marks (GOLDEN-NUMBERS "Capital Group Stripe mark path").
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const peer = require('../lib/analytics/peer');
const company = require('../lib/services/company');
const { goldenWarehouse } = require('./helpers/warehouseApp');

const { db, idOf } = goldenWarehouse();

// One fund's warehouse history in v1's holdings shape, up to a date.
function fundHoldings(companyName, fundKey, until) {
  const f = company.history(db, { companyId: idOf(companyName) }).funds.find(x => x.fundKey === fundKey);
  return f.series.flatMap(s =>
    s.points
      .filter(p => p.markDate <= until)
      .map(p => ({
        reportDate: p.markDate,
        chartValue: p.chartValue,
        shares: p.balance,
        pricePerShare: p.pricePerShare,
        instrumentType: s.instrumentType,
        instrumentLabel: s.instrumentLabel,
        instrumentKey: s.instrumentKey,
      }))
  );
}

test('peer (Node): velocity on Growth Fund of America Stripe marks, $41.42 -> $63.00 (2025-11-30 -> 2026-02-28)', () => {
  const holdings = fundHoldings('Stripe', 'S000009228', '2026-02-28');
  const series = peer.getSeriesGroups({ 'Growth Fund of America': holdings });
  assert.ok(series.length >= 4, 'one series per Stripe class');
  const cls = series.find(sr => sr.key === 'ECS283004'); // PFD SER H
  const v = peer.computeMarkVelocity(cls);
  assert.equal(v.priorDate, '2025-11-30');
  assert.equal(v.days, 90);
  assert.equal(v.latestPct.toFixed(1), '52.1');
  // Annualized from the latest mark at least 180 days back: $35.50 (2025-08-31).
  assert.equal(v.annualizedDays, 181);
  assert.equal(v.annualizedPct.toFixed(1), ((Math.pow(63 / 35.5, 365 / 181) - 1) * 100).toFixed(1));
  // Since the class's first mark.
  const first = [...cls.holdings].sort((a, b) => a.reportDate.localeCompare(b.reportDate))[0];
  assert.equal(v.sinceFirstPct.toFixed(1), ((63 / first.chartValue - 1) * 100).toFixed(1));
});

test('peer (Node): the leaderboard takes labels and the clock as options', () => {
  const holdings = fundHoldings('Stripe', 'S000009228', '2026-02-28');
  const rows = peer.computeLeaderboardRows(
    { Stripe: { equity: { 'Growth Fund of America': holdings } } },
    { meta: { equity: { sectionTitle: 'Equity' } }, now: Date.parse('2026-03-30') }
  );
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].latestValue, rows[0].latestDate, rows[0].ageDays], [63, '2026-02-28', 30]);
});

test('peer.js is served to the browser from lib/analytics', async () => {
  const app = require('../server');
  const r = await request(app).get('/peer.js').expect(200);
  assert.match(r.headers['content-type'], /javascript/);
  assert.match(r.text, /root\.VantagePeer = api/);
});
