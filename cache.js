// Server-side cache for parsed filings and search results.
//
// better-sqlite3 (not a flat JSON file) because it gives atomic, indexed
// reads/writes for free — important here since the Watchlist "run all"
// feature can fire many concurrent lookups, and a hand-rolled JSON file
// would need its own read-modify-write locking to stay correct under that.
//
// Two tables, two lifetimes:
//   - holdings_cache: parsed filing content for a given (cik, accession,
//     security) never changes — a historical filing is immutable — so this
//     is cached indefinitely.
//   - search_cache: search-result listings (which filings exist for a
//     security/issuer) can grow as new filings are submitted, so these are
//     cached with a short TTL (default 1 hour, override with
//     SEARCH_CACHE_TTL_MS).
//
// PARSE_VERSION guards against the indefinite holdings cache masking a
// future fix to the extraction logic (extractHoldings / extractCreditHoldings):
// bump it whenever that logic changes and old cached rows are automatically
// treated as misses, without needing to wipe the whole cache file.
//
// v2: merged the ticker/cusip "[object Object]" fix (extractIdString) into
// extractHoldings — bumped so any rows cached under v1 with the bad values
// are treated as misses and re-parsed.
// v3: added instrument-type classification (instrumentType/instrumentLabel/
// instrumentKey/chartValue/chartUnit) to extractHoldings — bumped so rows
// cached under v1/v2 (which lack these fields entirely) are treated as
// misses rather than silently falling back to instrumentType:undefined.
// v4: changed chartValue for derivative/indirect rows from total position
// value to per-unit (valUSD/balance) — a user caught the total-value
// convention live (dividing the shown $ by shares themselves didn't match,
// since the number on screen was the total, not price-per-unit like every
// other type). Bumped so rows cached under v3 with the old (total-value)
// convention get re-parsed instead of silently showing the wrong number.
// v5: Fund X-Ray's isPrivate (extractAllHoldings) now requires an
// equity-type instrument, not just Level 3/restricted — a user caught live
// that restricted Rule 144A bonds (e.g. sovereign bonds) were being counted
// as "private equity" alongside real private-company stakes. Bumped so
// cached fund-xray results computed under the old, debt-inclusive
// definition are re-parsed instead of silently overstating private equity
// exposure with bond/loan holdings.
// v6: isPrivateHolding no longer treats isRestrictedSec:Y alone as
// sufficient — a user caught live that "PREMIER ENERGIES LTD" (a real,
// publicly-listed Indian company, fairValLevel 2) was showing up as
// "private equity" solely because it's restricted under Indian
// foreign-ownership rules, unrelated to being privately held. Level 3 is
// now the sole signal. Bumped so cached results computed under the old
// Level-2-can-qualify definition are re-parsed.
const path = require('path');
const Database = require('better-sqlite3');

const PARSE_VERSION = 6;
const SEARCH_TTL_MS = parseInt(process.env.SEARCH_CACHE_TTL_MS, 10) || 60 * 60 * 1000; // 1 hour default

const DB_PATH = process.env.CACHE_DB_PATH || path.join(__dirname, 'cache.db');

let db;
try {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS holdings_cache (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS search_cache (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
} catch (err) {
  console.error('Cache DB unavailable, running without cache:', err.message);
  db = null;
}

const stmts = db
  ? {
      getHoldings: db.prepare('SELECT value FROM holdings_cache WHERE key = ?'),
      setHoldings: db.prepare(`
    INSERT INTO holdings_cache (key, value, created_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, created_at = excluded.created_at
  `),
      getSearch: db.prepare('SELECT value, created_at FROM search_cache WHERE key = ?'),
      setSearch: db.prepare(`
    INSERT INTO search_cache (key, value, created_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, created_at = excluded.created_at
  `),
      delSearch: db.prepare('DELETE FROM search_cache WHERE key = ?'),
    }
  : null;

// Namespaced key builders — callers pass identifying parts, not raw strings,
// so normalization (trim/lowercase) can't be forgotten at a call site.
function holdingsKey(namespace, ...parts) {
  return (
    `${namespace}:v${PARSE_VERSION}:` +
    parts
      .map(p =>
        String(p ?? '')
          .trim()
          .toLowerCase()
      )
      .join(':')
  );
}
function searchKey(namespace, ...parts) {
  return (
    `${namespace}:` +
    parts
      .map(p =>
        String(p ?? '')
          .trim()
          .toLowerCase()
      )
      .join(':')
  );
}

function getHoldings(key) {
  if (!stmts) return null;
  try {
    const row = stmts.getHoldings.get(key);
    return row ? JSON.parse(row.value) : null;
  } catch (err) {
    console.error('Cache read error (holdings):', err.message);
    return null;
  }
}

function setHoldings(key, value) {
  if (!stmts) return;
  try {
    stmts.setHoldings.run(key, JSON.stringify(value), Date.now());
  } catch (err) {
    console.error('Cache write error (holdings):', err.message);
  }
}

function getSearch(key) {
  if (!stmts) return null;
  try {
    const row = stmts.getSearch.get(key);
    if (!row) return null;
    if (Date.now() - row.created_at > SEARCH_TTL_MS) {
      stmts.delSearch.run(key);
      return null;
    }
    return JSON.parse(row.value);
  } catch (err) {
    console.error('Cache read error (search):', err.message);
    return null;
  }
}

function setSearch(key, value) {
  if (!stmts) return;
  try {
    stmts.setSearch.run(key, JSON.stringify(value), Date.now());
  } catch (err) {
    console.error('Cache write error (search):', err.message);
  }
}

// Coalesce concurrent requests for the same key (e.g. two Watchlist "run
// all" passes, or a batch search that repeats an issuer) into a single
// in-flight fetch, so a cache miss doesn't fan out into N redundant SEC
// requests + parses landing at once.
const inFlight = new Map();
async function withInFlight(key, fn) {
  if (inFlight.has(key)) return inFlight.get(key);
  const promise = (async () => {
    try {
      return await fn();
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, promise);
  return promise;
}

module.exports = {
  PARSE_VERSION,
  SEARCH_TTL_MS,
  holdingsKey,
  searchKey,
  getHoldings,
  setHoldings,
  getSearch,
  setSearch,
  withInFlight,
};
