// Production start-up behaviour (real child processes, real sockets): the
// server must refuse to run in production without a real SEC_USER_AGENT, honour
// X-Forwarded-For only in production (so per-visitor rate limits work behind a
// proxy and can't be spoofed in dev), and survive a cache.db written by an
// older parser version.
//
// Run with: npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'server.js');

function baseEnv(extra) {
  // dotenv never overrides variables already set, so blanking SEC_USER_AGENT
  // here really means "unset" even when the developer has a real .env.
  return {
    ...process.env,
    PORT: '0',
    CACHE_DB_PATH: ':memory:',
    // No warehouse: these tests are about start-up, proxies and rate limits. The
    // real one (~578 MB) made start-up warm it while the tests fired timed
    // request bursts, blocking the event loop (the intermittent failures under load).
    WAREHOUSE_DB_PATH: path.join(os.tmpdir(), 'vantage-no-warehouse', 'warehouse.db'),
    SEC_USER_AGENT: '',
    NODE_ENV: '',
    API_RATE_LIMIT_PER_MIN: '200',
    ...extra,
  };
}

test('production without SEC_USER_AGENT refuses to start (exit code 1, explains why)', () => {
  const r = spawnSync(process.execPath, [SERVER], {
    env: baseEnv({ NODE_ENV: 'production' }),
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Refusing to start in production/);
});

function startServer(env) {
  return new Promise((resolve, reject) => {
    const port = 3300 + Math.floor(Math.random() * 500);
    const child = spawn(process.execPath, [SERVER], {
      env: baseEnv({ PORT: String(port), ...env }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('server did not start: ' + out));
    }, 15000);
    child.stdout.on('data', d => {
      out += d;
      if (out.includes('Vantage running')) {
        clearTimeout(timer);
        resolve({ child, port });
      }
    });
    child.stderr.on('data', d => (out += d));
    child.on('exit', code => {
      clearTimeout(timer);
      reject(new Error(`server exited early (${code}): ${out}`));
    });
  });
}

function get(port, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: urlPath, headers }, res => {
        let body = '';
        res.on('data', c => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      })
      .on('error', reject);
  });
}

test('production with a real user agent starts, serves the app, and reports it configured', async () => {
  const { child, port } = await startServer({ NODE_ENV: 'production', SEC_USER_AGENT: 'Test Suite test@example.com' });
  try {
    assert.equal((await get(port, '/')).status, 200);
    assert.equal(JSON.parse((await get(port, '/api/config')).body).userAgentConfigured, true);
  } finally {
    child.kill();
  }
});

test('behind a proxy (production): rate limiting is per X-Forwarded-For visitor, not one shared bucket', async () => {
  const { child, port } = await startServer({ NODE_ENV: 'production', SEC_USER_AGENT: 'Test Suite test@example.com' });
  try {
    let limited = 0;
    for (let i = 0; i < 210; i++) {
      const r = await get(port, '/api/config', { 'X-Forwarded-For': '203.0.113.7' });
      if (r.status === 429) limited++;
    }
    assert.ok(limited >= 5, `visitor A should hit the 200/min cap (limited ${limited})`);
    const other = await get(port, '/api/config', { 'X-Forwarded-For': '198.51.100.9' });
    assert.equal(other.status, 200, 'a different visitor is unaffected');
    const limitedBody = await get(port, '/api/config', { 'X-Forwarded-For': '203.0.113.7' });
    assert.match(limitedBody.body, /Too many requests/);
  } finally {
    child.kill();
  }
});

test('in development X-Forwarded-For is ignored (a client cannot dodge the limit by spoofing it)', async () => {
  const { child, port } = await startServer({ SEC_USER_AGENT: 'Test Suite test@example.com' });
  try {
    let limited = 0;
    for (let i = 0; i < 215; i++) {
      const r = await get(port, '/api/config', { 'X-Forwarded-For': `10.0.0.${i % 250}` });
      if (r.status === 429) limited++;
    }
    assert.ok(limited >= 5, `spoofed forwarded headers must not reset the limit (limited ${limited})`);
  } finally {
    child.kill();
  }
});

// Staff full-stack review R11: X-Forwarded-For is trusted only where the origin
// cannot be reached directly (a loopback HOST) or TRUST_PROXY says so.
test('production on a public HOST without TRUST_PROXY ignores X-Forwarded-For and says why', async () => {
  const { child, port } = await startServer({
    NODE_ENV: 'production',
    SEC_USER_AGENT: 'Test Suite test@example.com',
    HOST: '0.0.0.0',
  });
  let err = '';
  child.stderr.on('data', d => (err += d));
  try {
    let limited = 0;
    for (let i = 0; i < 215; i++) {
      const r = await get(port, '/api/config', { 'X-Forwarded-For': `10.0.1.${i % 250}` });
      if (r.status === 429) limited++;
    }
    assert.ok(limited >= 5, `a spoofed header must not reset the limit on an exposed origin (limited ${limited})`);
    assert.match(err, /no TRUST_PROXY: X-Forwarded-For is ignored/);
  } finally {
    child.kill();
  }
});

test('TRUST_PROXY must be a hop count', () => {
  const r = spawnSync(process.execPath, [SERVER], {
    env: baseEnv({ SEC_USER_AGENT: 'Test Suite test@example.com', TRUST_PROXY: 'yes' }),
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /TRUST_PROXY must be a hop count/);
});

test('SEC pacing: negative or unreadable is the default, 0 only outside production, never under 100 ms in production', () => {
  const { minIntervalMs } = require('../lib/edgar');
  assert.equal(minIntervalMs(undefined, false), 110);
  assert.equal(minIntervalMs('-5', false), 110);
  assert.equal(minIntervalMs('abc', false), 110);
  assert.equal(minIntervalMs('0', false), 0);
  assert.equal(minIntervalMs('250', false), 250);
  assert.equal(minIntervalMs('0', true), 100);
  assert.equal(minIntervalMs('-1', true), 110);
  assert.equal(minIntervalMs('150', true), 150);
});

test('a cache.db written by an older parser version is not served (version is part of the key) and does not crash start-up', async () => {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vantage-cache-')), 'cache.db');
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE holdings_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, created_at INTEGER NOT NULL);
           CREATE TABLE search_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, created_at INTEGER NOT NULL);`);
  const stale = JSON.stringify({ stale: true });
  for (const v of [5, 6, 7, 8]) {
    db.prepare('INSERT INTO holdings_cache VALUES (?,?,?)').run(
      `fundxray:v${v}:555:000000000000000001`,
      stale,
      Date.now()
    );
  }
  const { PARSE_VERSION } = require('../cache');
  const liveKey = `holdings:nport:v${PARSE_VERSION}:555:000000000000000001:acme`;
  db.prepare('INSERT INTO holdings_cache VALUES (?,?,?)').run(liveKey, '[]', Date.now());
  db.close();

  const { child, port } = await startServer({ CACHE_DB_PATH: dbPath, SEC_USER_AGENT: 'Test Suite test@example.com' });
  try {
    const cache = require('../cache');
    assert.ok(
      cache.PARSE_VERSION > 8,
      `PARSE_VERSION (${cache.PARSE_VERSION}) must move past every legacy version present in a user's cache`
    );
    // The server is up and answering with a pre-populated legacy db.
    assert.equal((await get(port, '/api/config')).status, 200);
    const legacyKey = 'fundxray:v8:555:000000000000000001';
    const current = cache.holdingsKey('fundxray', '555', '000000000000000001');
    assert.notEqual(current, legacyKey, 'current keys never collide with legacy rows');
    // Unreachable legacy rows are deleted at start-up; current-version rows stay.
    const after = new Database(dbPath, { readonly: true });
    const keys = after
      .prepare('SELECT key FROM holdings_cache')
      .all()
      .map(r => r.key);
    after.close();
    assert.deepEqual(keys, [liveKey]);
  } finally {
    child.kill();
  }
});

test('the default API rate limit tolerates a large warm-cache Watchlist run (~1,000 requests in a minute) from one visitor', async () => {
  const { child, port } = await startServer({
    SEC_USER_AGENT: 'Test Suite test@example.com',
    API_RATE_LIMIT_PER_MIN: '',
  });
  try {
    let limited = 0;
    for (let i = 0; i < 1100; i++) {
      const r = await get(port, '/api/config');
      if (r.status === 429) limited++;
    }
    assert.equal(limited, 0, `a 1,100-request burst was limited ${limited} times`);
  } finally {
    child.kill();
  }
});
