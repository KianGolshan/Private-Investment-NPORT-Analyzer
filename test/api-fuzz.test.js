// Every API route against hostile input (2026-10-22 project check): a bad
// value is a 4xx with a JSON error, never a 500. The routes and the query
// parameters each one reads come from lib/api/warehouse.js itself, so a new
// route or parameter is fuzzed without editing this file.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');
const { goldenWarehouse } = require('./helpers/warehouseApp');
const { apiNotFound } = require('../lib/api/warehouse');

const { app, idOf } = goldenWarehouse();
app.use('/api', apiNotFound); // as server.js mounts it after the routers

function routes() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'api', 'warehouse.js'), 'utf8');
  const out = new Map();
  for (const part of src.split(/router\.get\(\s*/).slice(1)) {
    const m = /^'([^']+)'/.exec(part);
    if (!m) continue;
    const body = part.split(/router\.get\(/)[0];
    const params = new Set([...body.matchAll(/req\.query\.(\w+)/g)].map(x => x[1]));
    out.set(m[1], params);
  }
  return out;
}

// the filters any route may read through the scope or the sector filter
const COMMON = ['firm', 'fund', 'class', 'kind', 'sector', 'industry', 'theme', 'known', 'level', 'company', 'entity'];
const BAD = [
  '',
  '-1',
  '1e999',
  '99999999999999999999',
  'NaN',
  '2026-02-30',
  '0000-00-00',
  "' OR 1=1--",
  '<script>x</script>',
  '%00',
  '../../etc/passwd',
  '__proto__',
  'constructor',
  'toString',
  'x'.repeat(2000),
];

test('every route answers hostile parameters with a 4xx or an answer, never a 500', async () => {
  const all = routes();
  assert.ok(all.size >= 30, `found ${all.size} routes`);
  const ids = { ':id': String(idOf('Anthropic')), ':companyId': String(idOf('Anthropic')), ':key': 'S000009228' };
  const bad = [];
  for (const [route, own] of all) {
    const base = `/api${route.replace(/:\w+/g, k => ids[k] ?? 'x')}`;
    const asks = [];
    for (const k of Object.keys(ids))
      if (route.includes(k))
        for (const v of BAD)
          asks.push(`/api${route.replace(k, encodeURIComponent(v)).replace(/:\w+/g, x => ids[x] ?? 'x')}`);
    for (const q of new Set([...own, ...COMMON])) {
      for (const v of BAD) asks.push(`${base}?${q}=${encodeURIComponent(v)}`);
      asks.push(`${base}?${q}=1&${q}=2`, `${base}?${q}[a]=1`);
    }
    for (const url of asks) {
      const r = await request(app).get(url);
      if (r.status >= 500) bad.push(`${r.status} ${url.slice(0, 140)}`);
      else if (r.status >= 400 && !/json/.test(r.headers['content-type'] || ''))
        bad.push(`not JSON ${url.slice(0, 140)}`);
    }
  }
  assert.deepEqual(bad, []);
});
