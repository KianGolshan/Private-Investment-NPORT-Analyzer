// The guards on the warehouse API (lib/api/heavy.js, reviews F-05, H1, H2, M1):
// which routes count as heavy (whatever the case), the per-visitor count and time
// budgets, and load shedding that refuses the visitors filling the process while
// others still get answers, with recovery once the window passes.
//
// Run with: npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { heavyGuard, busyMeter, visitorMeter, isHeavy, isApi } = require('../lib/api/heavy');

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
    // the tracked dashboard at a new date read every tracked company (review H1)
    '/api/market/tracked',
    // any spelling (review H2: /API/... reached the same handlers)
    '/API/analysis/pivot',
    '/Api/Analysis/Pivot',
    '/api/COMPANIES/1/ROWS',
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

// An app whose heavy route takes `cost` ms of (fake) time per answer, and a
// light route that takes `lightCost`. Visitors are told apart by
// X-Forwarded-For (a trusted proxy in front, as on the server).
function appWith(opts, cost = 0, lightCost = 0) {
  let t = 0;
  const clock = () => t;
  const app = express();
  app.set('trust proxy', 1); // one proxy hop, as on the server
  app.use(heavyGuard({ clock, ...opts }));
  app.get('/api/analysis/pivot', (_req, res) => {
    t += cost;
    res.json({ ok: true });
  });
  app.get('/api/search', (_req, res) => {
    t += lightCost;
    res.json({ ok: true });
  });
  app.get('/healthz', (_req, res) => {
    t += lightCost;
    res.json({ ok: true });
  });
  return app;
}
const from = ip => ({ 'X-Forwarded-For': ip });

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

test('isApi: any spelling of /api/, nothing else', () => {
  for (const p of ['/api/search', '/API/search', '/Api/x']) assert.equal(isApi(p), true, p);
  for (const p of ['/', '/healthz', '/company/1', '/apix/search', '/assets/api/x.js']) assert.equal(isApi(p), false, p);
});

test('time budget (H1): a visitor past its share of the minute gets 429 on every API route; others go on', async () => {
  let now = 0;
  const visitors = visitorMeter({ windowMs: 60000, now: () => now });
  // a light route that turned out slow (as /api/market/tracked was, 4.8 s at a new date)
  const app = appWith({ perMinute: 1000, visitors, visitorMsPerMin: 15000 }, 0, 4000);
  for (let i = 0; i < 4; i++) {
    now += 1000;
    await request(app).get('/api/search').set(from('203.0.113.1')).expect(200);
  }
  assert.equal(visitors.used('203.0.113.1'), 16000);
  now += 1000;
  const r = await request(app).get('/api/search').set(from('203.0.113.1')).expect(429);
  assert.match(r.body.error, /share of the server/);
  assert.equal(r.headers['cache-control'], 'no-store');
  // the first 4 s span ended at t=1 s: under the budget again once it leaves the window (t=61 s)
  assert.equal(r.headers['retry-after'], '56');
  await request(app).get('/api/analysis/pivot').set(from('203.0.113.1')).expect(429);
  // another visitor is untouched, and so is anything outside the API
  await request(app).get('/api/search').set(from('198.51.100.7')).expect(200);
  await request(app).get('/healthz').set(from('203.0.113.1')).expect(200);
  // exactly at the edge of the window the oldest span leaves: answered again
  now = 61000;
  await request(app).get('/api/search').set(from('203.0.113.1')).expect(200);
});

test('time budget: IPv6 visitors are grouped by /56, so a new address in the same block is the same visitor', async () => {
  let now = 0;
  const visitors = visitorMeter({ now: () => now });
  const app = appWith({ perMinute: 1000, visitors, visitorMsPerMin: 5000 }, 0, 6000);
  await request(app).get('/api/search').set(from('2001:db8:1:100::1')).expect(200);
  await request(app).get('/api/search').set(from('2001:db8:1:1ff::2')).expect(429); // same /56
  await request(app).get('/api/search').set(from('2001:db8:2::1')).expect(200); // another /56
});

test('fair shedding (M1): when the process is busy, the visitor filling it waits; a light visitor still gets heavy answers', async () => {
  let now = 0;
  const meter = busyMeter({ windowMs: 10000, now: () => now });
  const visitors = visitorMeter({ now: () => now });
  const app = appWith({ perMinute: 1000, meter, visitors, visitorMsPerMin: 60000, busyVisitorMs: 2000 }, 2500);
  for (let i = 0; i < 3; i++) await request(app).get('/api/analysis/pivot').set(from('203.0.113.1')).expect(200);
  assert.ok(meter.used() > 6000, 'the process is busy');
  const busy = await request(app).get('/api/analysis/pivot').set(from('203.0.113.1')).expect(503);
  assert.equal(busy.headers['retry-after'], '5');
  // a visitor who has asked for little is answered, and is then charged like anyone
  await request(app).get('/api/analysis/pivot').set(from('198.51.100.7')).expect(200);
  assert.equal(visitors.used('198.51.100.7'), 2500);
  // now over 2 s itself, it waits too while the process stays busy
  await request(app).get('/api/analysis/pivot').set(from('198.51.100.7')).expect(503);
  // light routes stay open to both
  await request(app).get('/api/search').set(from('203.0.113.1')).expect(200);
  // the busy window passes: heavy answers again
  now += 10001;
  await request(app).get('/api/analysis/pivot').set(from('203.0.113.1')).expect(200);
});

test('a request is charged once, whether it finishes or the client goes away', async () => {
  const visitors = visitorMeter();
  const meter = busyMeter();
  const app = appWith({ perMinute: 1000, visitors, meter }, 700);
  await request(app).get('/api/analysis/pivot').set(from('203.0.113.1')).expect(200);
  assert.equal(visitors.used('203.0.113.1'), 700, 'finish and close both fire: one charge');
  assert.equal(meter.used(), 700);
});

test('visitorMeter: empty, the edge of the window, Retry-After, and the visitor cap (idle first, then least recent)', () => {
  let now = 1000;
  const m = visitorMeter({ windowMs: 100, now: () => now, maxVisitors: 2 });
  assert.equal(m.used('a'), 0);
  assert.equal(m.retryAfter('a', 10), 1, 'no spans: at once');
  m.record('a', 40);
  now = 1010;
  m.record('a', 30);
  assert.equal(m.used('a'), 70);
  assert.equal(m.retryAfter('a', 50), 1, 'the first span leaves at 1100: under a second away, rounded up to 1');
  now = 1099;
  assert.equal(m.used('a'), 70);
  now = 1100;
  assert.equal(m.used('a'), 30, 'a span ends exactly one window ago: gone');
  now = 1200;
  m.record('b', 5);
  m.record('c', 5); // three visitors over a cap of two: 'a' has nothing left in the window and goes
  assert.equal(m.size(), 2);
  assert.equal(m.used('a'), 0);
  m.record('b', 5); // b seen again: c is now the least recent
  m.record('d', 5); // nobody idle: the least recently seen (c) goes
  assert.equal(m.size(), 2);
  assert.deepEqual([m.used('b'), m.used('c'), m.used('d')], [10, 0, 5]);
});
