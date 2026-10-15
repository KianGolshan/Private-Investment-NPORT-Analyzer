// The guards on the expensive warehouse routes (lib/api/heavy.js, review F-05):
// which routes count as heavy, the per-visitor budget, and load shedding when
// heavy work fills the process, with light routes unaffected and recovery once
// the window passes.
//
// Run with: npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { heavyGuard, busyMeter, isHeavy } = require('../lib/api/heavy');

test('heavy routes: the pivots, change feeds, stored rows and fund returns; not search, headers or health', () => {
  for (const p of [
    '/api/analysis/pivot',
    '/api/analysis/drill',
    '/api/feed',
    '/api/market/movers',
    '/api/market/new',
    '/api/firms/3/changes',
    '/api/companies/1/rows',
    '/api/companies/1/activity',
    '/api/companies/1/bridge',
    '/api/entities/RIPPLE/legs',
    '/api/funds/S000009228/returns',
    '/api/funds/S000009228/compare/',
  ])
    assert.equal(isHeavy(p), true, p);
  for (const p of [
    '/api/search',
    '/api/companies/1',
    '/api/companies/1/exposure',
    '/api/market/top',
    '/api/firms',
    '/api/freshness',
    '/api/config',
    '/healthz',
    '/api/funds/S000009228',
  ])
    assert.equal(isHeavy(p), false, p);
});

// An app whose heavy route takes `cost` ms of (fake) time per answer.
function appWith(opts, cost = 0) {
  let t = 0;
  const clock = () => t;
  const app = express();
  app.use(heavyGuard({ clock, ...opts }));
  app.get('/api/analysis/pivot', (_req, res) => {
    t += cost;
    res.json({ ok: true });
  });
  app.get('/api/search', (_req, res) => res.json({ ok: true }));
  return app;
}

test('per visitor: heavy routes stop at their own budget, with a message; light routes go on', async () => {
  const app = appWith({ perMinute: 3, meter: busyMeter() });
  for (let i = 0; i < 3; i++) await request(app).get('/api/analysis/pivot').expect(200);
  const r = await request(app).get('/api/analysis/pivot').expect(429);
  assert.match(r.body.error, /Too many detailed queries/);
  await request(app).get('/api/search').expect(200);
});

test('load shedding: once heavy work fills 60% of the window, new heavy requests get 503 busy; light ones still answer', async () => {
  let now = 0;
  const meter = busyMeter({ windowMs: 10000, now: () => now });
  const app = appWith({ perMinute: 1000, meter }, 2500); // each answer "takes" 2.5 s
  await request(app).get('/api/analysis/pivot').expect(200); // 2.5 s used
  await request(app).get('/api/analysis/pivot').expect(200); // 5.0 s
  await request(app).get('/api/analysis/pivot').expect(200); // 7.5 s, now over 6 s
  const busy = await request(app).get('/api/analysis/pivot').expect(503);
  assert.equal(busy.headers['retry-after'], '5');
  assert.equal(busy.headers['cache-control'], 'no-store');
  assert.match(busy.body.error, /busy/);
  await request(app).get('/api/search').expect(200);
  // the window passes: heavy requests are served again
  now += 10001;
  await request(app).get('/api/analysis/pivot').expect(200);
});

test('a warm site never sheds: cheap (memoized) heavy answers barely use the budget', async () => {
  const meter = busyMeter();
  const app = appWith({ perMinute: 1000, meter }, 1); // 1 ms each
  for (let i = 0; i < 200; i++) await request(app).get('/api/analysis/pivot').expect(200);
  assert.ok(meter.used() <= 200);
});

test('busyMeter: empty, exactly at the edge of the window, and after it', () => {
  let now = 1000;
  const m = busyMeter({ windowMs: 100, now: () => now });
  assert.equal(m.used(), 0);
  m.record(40);
  m.record(30);
  assert.equal(m.used(), 70);
  now = 1099;
  assert.equal(m.used(), 70, 'inside the window');
  now = 1100;
  assert.equal(m.used(), 0, 'a span ends exactly one window ago: gone');
});
