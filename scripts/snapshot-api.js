#!/usr/bin/env node
// Non-regression harness for P15 (ADR 0011, plan §9): records every API answer for the
// primary companies and everything they touch, then checks that a later generation
// answers the same, except for fields the cost work is allowed to add.
//
//   node scripts/snapshot-api.js record <dir> [--db path]   # read-only; one .jsonl.gz per group
//   node scripts/snapshot-api.js diff <before-dir> <after-dir>
//
// Covered, for Anthropic, Databricks and Anduril: the company answer, exposure and
// classes at four dates, history, the feed, activity, trend, marks, stale marks, bridge,
// legs, rows, leadership and every fund's position history; every fund that ever held
// one of them (summary, X-Ray at every canonical filing, compare, changes, returns); every
// firm of those funds (book at four dates, changes, marks of each company); Market,
// Sectors, Analysis and Activity answers at four dates. Only `refreshId`, `job` and
// `generation` (which name the generation an answer was read from) are not compared.
// The diff exits 1 on any other difference: a changed, missing or reordered value, a
// status or an extra field outside ALLOWED_ADDED.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const express = require('express');
const { openWarehouseReadOnly } = require('../lib/warehouse/db');
const { warehouseRouter } = require('../lib/api/warehouse');

const COMPANIES = ['Anthropic', 'Databricks', 'Anduril Industries'];
const DATES = ['2025-06-30', '2025-12-31', '2026-06-30', null]; // null: the newest
// curationRev: the git version of data/review the generation was built from, which changes
// with any commit there (P15 adds data/review/ncsr_families.csv); the curation digest, which
// hashes the reviewed files the data reflects, is still compared.
const VOLATILE = new Set(['refreshId', 'job', 'generation', 'curationRev']);
// fields the cost work (P15) may add to an existing answer; nothing else may change
const ALLOWED_ADDED = new Set(['cost', 'costCoverage', 'roundPrices', 'ncsrFilings', 'acquired', 'ncsr']);

const q = params => {
  const s = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== null && v !== undefined)).toString();
  return s ? `?${s}` : '';
};

function plan(db) {
  const ids = COMPANIES.map(name => {
    const row = db.prepare('SELECT id FROM companies WHERE name = ?').get(name);
    if (!row) throw new Error(`no company named ${name}`);
    return row.id;
  });
  const funds = db
    .prepare(
      `SELECT DISTINCT fund_key FROM position_facts WHERE company_id IN (${ids.map(() => '?').join(',')}) ORDER BY fund_key`
    )
    .all(...ids)
    .map(r => r.fund_key);
  const firms = db
    .prepare(
      `SELECT DISTINCT ma.manager_id AS id FROM fund_advisers fa JOIN manager_advisers ma ON ma.file_num = fa.file_num
       WHERE fa.fund_key IN (${funds.map(() => '?').join(',')}) ORDER BY 1`
    )
    .all(...funds)
    .map(r => r.id);
  const groups = { companies: [], funds: [], firms: [], market: [] };
  for (const id of ids) {
    const c = `/api/companies/${id}`;
    groups.companies.push(c, `${c}/history`, `${c}/feed.xml`, `${c}/marks`, `${c}/leadership`, `${c}/trend`);
    for (const date of DATES) {
      groups.companies.push(`${c}${q({ date })}`, `${c}/exposure${q({ date })}`, `${c}/classes${q({ date })}`);
      groups.companies.push(`${c}/rows${q({ date })}`, `${c}/stale${q({ date })}`);
    }
    groups.companies.push(`${c}/activity`, `${c}/activity${q({ since: '2025-01-01' })}`);
    groups.companies.push(`${c}/bridge`, `${c}/bridge${q({ from: '2025-12-31', to: '2026-06-30' })}`, `${c}/legs`);
    for (const fk of db.prepare('SELECT DISTINCT fund_key FROM position_facts WHERE company_id = ?').all(id))
      groups.companies.push(`${c}/positions/${encodeURIComponent(fk.fund_key)}`);
    for (const firm of firms) groups.firms.push(`/api/firms/${firm}/marks/${id}`);
    groups.market.push(`/api/analysis/drill${q({ rows: 'company', key: String(id), metric: 'value' })}`);
  }
  // the three companies side by side (compare takes 2 to 5 keys, repeated)
  groups.market.push(`/api/analysis/compare?rows=company&period=quarter&${ids.map(id => `key=${id}`).join('&')}`);
  for (const fk of funds) {
    const f = `/api/funds/${encodeURIComponent(fk)}`;
    groups.funds.push(f, `${f}/compare`, `${f}/changes`, `${f}/returns`);
    for (const a of db
      .prepare('SELECT accession FROM canonical_filings WHERE fund_key = ? ORDER BY report_date')
      .all(fk))
      groups.funds.push(`${f}/xray${q({ accession: a.accession })}`);
    groups.funds.push(`/api/analysis/marks${q({ fund: fk })}`, `/api/analysis/timeline${q({ fund: fk })}`);
  }
  for (const firm of firms) {
    groups.firms.push(`/api/firms/${firm}/changes`, `/api/analysis/marks${q({ firm })}`);
    groups.firms.push(`/api/analysis/timeline${q({ firm })}`);
    for (const date of DATES) groups.firms.push(`/api/firms/${firm}${q({ date })}`);
  }
  for (const date of DATES) {
    groups.market.push(`/api/market/top${q({ date, limit: 200 })}`, `/api/sectors${q({ date })}`);
    groups.market.push(`/api/firms${q({ date })}`, `/api/market/countries${q({ date })}`);
    groups.market.push(`/api/watchlist${q({ date })}`, `/api/market/tracked${q({ date })}`);
  }
  groups.market.push(
    `/api/market/movers${q({ from: '2025-12-31', to: '2026-06-30' })}`,
    `/api/market/new${q({ from: '2025-12-31', to: '2026-06-30' })}`,
    `/api/analysis/bridge${q({ from: '2025-12-31', to: '2026-06-30' })}`,
    `/api/analysis/pivot${q({ rows: 'firm', period: 'quarter', from: '2025-01-01', to: '2026-06-30' })}`,
    `/api/feed${q({ since: '2026-04-01', until: '2026-06-30', limit: 200 })}`,
    '/api/stats'
  );
  return groups;
}

// Drop the fields that name the generation an answer was read from, at any depth.
function stable(v) {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) if (!VOLATILE.has(k)) out[k] = stable(x);
    return out;
  }
  return v;
}

async function record(dir, dbPath) {
  const db = openWarehouseReadOnly(dbPath);
  const app = express();
  app.use(
    '/api',
    warehouseRouter(() => db)
  );
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  fs.mkdirSync(dir, { recursive: true });
  const groups = plan(db);
  let total = 0;
  try {
    for (const [group, urls] of Object.entries(groups)) {
      const lines = [];
      for (const url of [...new Set(urls)]) {
        const res = await fetch(base + url, { headers: { 'accept-encoding': 'identity' } });
        const text = await res.text();
        const json = (res.headers.get('content-type') || '').includes('json');
        lines.push(JSON.stringify({ url, status: res.status, body: json ? stable(JSON.parse(text)) : text }));
      }
      fs.writeFileSync(path.join(dir, `${group}.jsonl.gz`), zlib.gzipSync(lines.join('\n') + '\n'));
      total += lines.length;
      console.log(`${group}: ${lines.length} answers`);
    }
  } finally {
    server.close();
    db.close();
  }
  fs.writeFileSync(
    path.join(dir, 'meta.json'),
    JSON.stringify({ db: fs.realpathSync(db.name), recordedAt: new Date().toISOString(), answers: total }, null, 2)
  );
  console.log(`recorded ${total} answers in ${dir}`);
}

const read = (dir, group) => {
  const file = path.join(dir, `${group}.jsonl.gz`);
  const out = new Map();
  for (const line of zlib.gunzipSync(fs.readFileSync(file)).toString().trim().split('\n')) {
    const r = JSON.parse(line);
    out.set(r.url, { ...r, body: stable(r.body) }); // provenance dropped on both sides, whenever recorded
  }
  return out;
};

// Differences between a and b where b may only add ALLOWED_ADDED keys. Returns [path, a, b] triples.
function compare(a, b, at = '', out = []) {
  if (out.length > 20) return out;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) out.push([at, summarize(a), summarize(b)]);
    else a.forEach((x, i) => compare(x, b[i], `${at}[${i}]`, out));
    return out;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of Object.keys(a)) {
      if (!(k in b)) out.push([`${at}.${k}`, summarize(a[k]), '(missing)']);
      else compare(a[k], b[k], `${at}.${k}`, out);
    }
    for (const k of Object.keys(b))
      if (!(k in a) && !ALLOWED_ADDED.has(k)) out.push([`${at}.${k}`, '(absent)', summarize(b[k])]);
    // keys in the same order (a table's columns, a ranking's fields)
    const shared = Object.keys(b).filter(k => k in a);
    if (shared.join('|') !== Object.keys(a).join('|') && out.length === 0)
      out.push([`${at} (key order)`, Object.keys(a), shared]);
    return out;
  }
  if (a !== b && !(Number.isNaN(a) && Number.isNaN(b))) out.push([at, a, b]);
  return out;
}
const summarize = v => (Array.isArray(v) ? `[${v.length} items]` : v && typeof v === 'object' ? '{…}' : v);

function diff(before, after) {
  let answers = 0;
  let failed = 0;
  for (const group of ['companies', 'funds', 'firms', 'market']) {
    const a = read(before, group);
    const b = read(after, group);
    for (const [url, ra] of a) {
      answers++;
      const rb = b.get(url);
      const problems = !rb
        ? [['(answer)', 'recorded', 'missing']]
        : ra.status !== rb.status
          ? [['(status)', ra.status, rb.status]]
          : compare(ra.body, rb.body);
      if (problems.length) {
        failed++;
        if (failed <= 40) {
          console.error(`DIFF ${url}`);
          for (const [p, x, y] of problems.slice(0, 6))
            console.error(`   ${p}: ${JSON.stringify(x)} -> ${JSON.stringify(y)}`);
        }
      }
    }
  }
  console.log(`${answers} answers compared, ${failed} differ`);
  if (failed) process.exit(1);
}

if (require.main === module) {
  const [cmd, a, b] = process.argv.slice(2);
  const dbFlag = process.argv.indexOf('--db');
  const dbPath = dbFlag > 0 ? process.argv[dbFlag + 1] : undefined;
  const run = cmd === 'record' && a ? record(a, dbPath) : cmd === 'diff' && a && b ? diff(a, b) : null;
  if (!run && cmd !== 'diff') {
    console.error('usage: snapshot-api.js record <dir> [--db path] | diff <before> <after>');
    process.exit(2);
  }
  Promise.resolve(run).catch(err => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { compare, stable, ALLOWED_ADDED, VOLATILE };
