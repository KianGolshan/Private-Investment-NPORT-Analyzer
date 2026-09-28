#!/usr/bin/env node
// Loads SEC DERA N-PORT quarterly datasets into the warehouse.
//
//   npm run ingest:bulk -- --quarter 2026q2 [--quarter 2026q1 …]
//   npm run ingest:bulk -- --all              # every quarter listed by the SEC
//   npm run ingest:bulk -- --missing          # only quarters not yet loaded
//   npm run ingest:bulk -- --file ./2026q2_nport.zip --quarter 2026q2
//
// Quarters load one at a time, in the foreground, each in its own
// transaction. The downloaded zip is deleted after each quarter (pass
// --keep-zip to keep it). Exits non-zero on the first failure; every run is
// recorded in ingest_log.
require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');
const { openWarehouse, defaultWarehousePath } = require('../lib/warehouse/db');
const { ingestBulkZip } = require('../lib/warehouse/bulk-ingest');

const DATASET_PAGE = 'https://www.sec.gov/data-research/sec-markets-data/form-n-port-data-sets';
const zipUrl = q => `https://www.sec.gov/files/dera/data/form-n-port-data-sets/${q}_nport.zip`;

function parseArgs(argv) {
  const opts = { quarters: [], all: false, missing: false, file: null, keepZip: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--quarter') opts.quarters.push(String(argv[++i] || '').toLowerCase());
    else if (a === '--all') opts.all = true;
    else if (a === '--missing') opts.missing = true;
    else if (a === '--file') opts.file = argv[++i];
    else if (a === '--keep-zip') opts.keepZip = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  for (const q of opts.quarters) if (!/^\d{4}q[1-4]$/.test(q)) throw new Error(`bad quarter "${q}" (use e.g. 2026q2)`);
  if (opts.file && opts.quarters.length !== 1) throw new Error('--file needs exactly one --quarter');
  if (!opts.file && !opts.all && !opts.missing && !opts.quarters.length) {
    throw new Error('nothing to do: pass --quarter, --all, --missing or --file');
  }
  return opts;
}

function userAgent() {
  const ua = String(process.env.SEC_USER_AGENT || '').trim();
  if (!ua) throw new Error('SEC_USER_AGENT is required (see .env.example)');
  return ua;
}

// SEC asks automated clients to back off on 429/503; transient 5xx and
// network errors are retried too. Anything else fails immediately.
async function withRetry(fn, label, attempts = 5) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const status = err.response?.status;
      const retryable = !status || status === 429 || status >= 500;
      if (!retryable || i >= attempts - 1) throw new Error(`${label}: ${err.message}`, { cause: err });
      const wait = Math.min(60000, 2000 * 2 ** i);
      console.log(`  ${label}: ${status || err.code || 'error'}, retrying in ${wait / 1000}s`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
}

async function listAvailableQuarters() {
  const resp = await withRetry(
    () => axios.get(DATASET_PAGE, { headers: { 'User-Agent': userAgent() }, timeout: 30000 }),
    'dataset list'
  );
  const found = [...String(resp.data).matchAll(/form-n-port-data-sets\/(\d{4}q[1-4])_nport\.zip/g)].map(m => m[1]);
  return [...new Set(found)].sort();
}

async function download(quarter, dir) {
  const dest = path.join(dir, `${quarter}_nport.zip`);
  return withRetry(async () => {
    const resp = await axios.get(zipUrl(quarter), {
      headers: { 'User-Agent': userAgent() },
      responseType: 'stream',
      timeout: 120000,
      maxContentLength: Infinity,
    });
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(dest);
      resp.data.on('data', chunk => {
        hash.update(chunk);
        bytes += chunk.length;
      });
      resp.data.on('error', reject);
      out.on('error', reject);
      out.on('finish', resolve);
      resp.data.pipe(out);
    });
    const expected = Number(resp.headers['content-length']);
    if (Number.isFinite(expected) && expected > 0 && expected !== bytes) {
      throw new Error(`truncated download (${bytes} of ${expected} bytes)`);
    }
    return { path: dest, sha256: hash.digest('hex'), bytes };
  }, `download ${quarter}`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dbPath = defaultWarehousePath();
  const db = openWarehouse(dbPath);
  const loaded = new Set(
    db
      .prepare("SELECT DISTINCT quarter FROM ingest_log WHERE kind = 'bulk' AND status = 'ok'")
      .all()
      .map(r => r.quarter)
  );

  let quarters = opts.quarters;
  if (opts.all || opts.missing) {
    const available = await listAvailableQuarters();
    if (!available.length) throw new Error('no quarters found on the SEC dataset page');
    quarters = opts.missing ? available.filter(q => !loaded.has(q)) : available;
  }
  console.log(`Warehouse: ${dbPath}`);
  console.log(`Quarters to load (${quarters.length}): ${quarters.join(' ') || 'none'}`);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vantage-bulk-'));
  const started = Date.now();
  const totals = { filings: 0, rowsRead: 0, rowsKept: 0 };
  try {
    for (const quarter of quarters) {
      const t0 = Date.now();
      const zip = opts.file
        ? { path: opts.file, sha256: null, bytes: fs.statSync(opts.file).size }
        : await download(quarter, tmpDir);
      const t1 = Date.now();
      try {
        const stats = await ingestBulkZip(db, zip.path, {
          quarter,
          sourceUrl: opts.file ? path.resolve(opts.file) : zipUrl(quarter),
          sha256: zip.sha256,
          bytes: zip.bytes,
        });
        totals.filings += stats.filings;
        totals.rowsRead += stats.rowsRead;
        totals.rowsKept += stats.rowsKept;
        console.log(
          `${quarter}: ${stats.filings} filings, ${stats.rowsKept.toLocaleString()} of ` +
            `${stats.rowsRead.toLocaleString()} holding rows kept ` +
            `(download ${((t1 - t0) / 1000).toFixed(0)}s, load ${((Date.now() - t1) / 1000).toFixed(0)}s)`
        );
      } finally {
        if (!opts.file && !opts.keepZip) fs.rmSync(zip.path, { force: true });
      }
    }
  } finally {
    if (!opts.keepZip) fs.rmSync(tmpDir, { recursive: true, force: true });
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
  }
  const size = fs.statSync(dbPath).size;
  console.log(
    `Done: ${quarters.length} quarter(s), ${totals.filings.toLocaleString()} filings, ` +
      `${totals.rowsKept.toLocaleString()} holdings kept, ${((Date.now() - started) / 60000).toFixed(1)} min, ` +
      `warehouse ${(size / 1e6).toFixed(0)} MB`
  );
}

main().catch(err => {
  console.error(`ingest-bulk failed: ${err.message}`);
  process.exitCode = 1;
});
