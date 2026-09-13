// Test suite for cache.js — key normalization, indefinite holdings cache,
// TTL'd search cache, and in-flight request coalescing.
//
// Node's test runner (`node --test`) runs each matched file in its own
// process, so it's safe to set env vars here before requiring the module:
// this file's process gets its own isolated in-memory SQLite DB
// (CACHE_DB_PATH=':memory:', which better-sqlite3 supports directly) and a
// short search-cache TTL, without affecting the real cache.db or any other
// test file's env.
//
// Run with: npm test

process.env.CACHE_DB_PATH = ':memory:';
process.env.SEARCH_CACHE_TTL_MS = '50';

const test = require('node:test');
const assert = require('node:assert/strict');
const cache = require('../cache');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Key builders ─────────────────────────────────────────────────────────

test('holdingsKey: normalizes (trims, lowercases) and namespaces with PARSE_VERSION', () => {
  const a = cache.holdingsKey('holdings:nport', ' 0001234567 ', 'ACC-0001', 'SpaceX');
  const b = cache.holdingsKey('holdings:nport', '0001234567', 'acc-0001', 'spacex');
  assert.equal(a, b, 'trim/case differences in the same logical key must collide');
  assert.match(a, new RegExp(`^holdings:nport:v${cache.PARSE_VERSION}:`));
});

test('holdingsKey: different parts produce different keys', () => {
  const a = cache.holdingsKey('holdings:nport', 'cik1', 'acc1', 'security1');
  const b = cache.holdingsKey('holdings:nport', 'cik1', 'acc1', 'security2');
  assert.notEqual(a, b);
});

test('searchKey: normalizes the same way but carries no PARSE_VERSION segment', () => {
  const a = cache.searchKey('search:nport', ' Anthropic ');
  const b = cache.searchKey('search:nport', 'anthropic');
  assert.equal(a, b);
  assert.ok(!a.includes('v' + cache.PARSE_VERSION), 'search keys are not versioned by PARSE_VERSION');
});

// ── Holdings cache (indefinite) ─────────────────────────────────────────

test('holdings cache: round-trips a value through set/get', () => {
  const key = cache.holdingsKey('holdings:nport', 'cik-a', 'acc-a', 'sec-a');
  assert.equal(cache.getHoldings(key), null, 'unset key starts as a miss');

  const value = [{ name: 'TEST CO', pricePerShare: 12.34 }];
  cache.setHoldings(key, value);
  assert.deepEqual(cache.getHoldings(key), value);
});

test('holdings cache: overwriting an existing key updates the stored value', () => {
  const key = cache.holdingsKey('holdings:nport', 'cik-b', 'acc-b', 'sec-b');
  cache.setHoldings(key, [{ v: 1 }]);
  cache.setHoldings(key, [{ v: 2 }]);
  assert.deepEqual(cache.getHoldings(key), [{ v: 2 }]);
});

// ── Search cache (TTL'd) ─────────────────────────────────────────────────

test('search cache: round-trips a value before it expires', () => {
  const key = cache.searchKey('search:nport', 'fresh-issuer');
  cache.setSearch(key, { hits: { hits: [1, 2, 3] } });
  assert.deepEqual(cache.getSearch(key), { hits: { hits: [1, 2, 3] } });
});

test('search cache: expires after SEARCH_CACHE_TTL_MS and reads back as a miss', async () => {
  const key = cache.searchKey('search:nport', 'stale-issuer');
  cache.setSearch(key, { hits: { hits: [] } });
  assert.notEqual(cache.getSearch(key), null, 'should still be a hit immediately after writing');

  await sleep(80); // > the 50ms SEARCH_CACHE_TTL_MS set for this process
  assert.equal(cache.getSearch(key), null, 'should be treated as a miss once past its TTL');
});

// ── In-flight request coalescing ─────────────────────────────────────────

test('withInFlight: concurrent calls for the same key share one underlying call', async () => {
  let calls = 0;
  const fn = async () => {
    calls++;
    await sleep(20);
    return 'result';
  };

  const [a, b, c] = await Promise.all([
    cache.withInFlight('coalesce-key', fn),
    cache.withInFlight('coalesce-key', fn),
    cache.withInFlight('coalesce-key', fn),
  ]);

  assert.equal(calls, 1, 'the underlying function should run exactly once for concurrent callers');
  assert.deepEqual([a, b, c], ['result', 'result', 'result']);
});

test('withInFlight: a later call (after the first resolves) runs the function again', async () => {
  let calls = 0;
  const fn = async () => {
    calls++;
    return calls;
  };

  const first = await cache.withInFlight('sequential-key', fn);
  const second = await cache.withInFlight('sequential-key', fn);

  assert.equal(first, 1);
  assert.equal(second, 2, 'once the first call has settled, the key should no longer be treated as in-flight');
});

test('withInFlight: a rejection is delivered to all concurrent callers and clears the in-flight entry', async () => {
  let calls = 0;
  const fn = async () => {
    calls++;
    throw new Error('boom');
  };

  await assert.rejects(
    () => Promise.all([cache.withInFlight('failing-key', fn), cache.withInFlight('failing-key', fn)]),
    /boom/
  );
  assert.equal(calls, 1, 'the underlying function should still run exactly once even on rejection');

  // Confirms the in-flight map entry was cleaned up on failure — a
  // subsequent call must run the function again, not hang on a stale promise.
  let calledAgain = false;
  await cache.withInFlight('failing-key', async () => {
    calledAgain = true;
    return 'ok';
  });
  assert.ok(calledAgain);
});
