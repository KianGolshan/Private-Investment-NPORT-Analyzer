#!/usr/bin/env node
// "Make this a company" as a job (lib/entities/make-company.js): writes the
// decision to data/review/aliases.csv and runs the review import under the
// refresh lock. The admin route in the web server runs this as a child process.
//
//   node scripts/make-company.js --key "VERCEL" --name "Vercel" [--status private] [--track N] [--dir data/review]
//
// Prints one JSON line with the result ({ company: { id, name, … } } or
// { error, status }) and exits non-zero on failure.
require('dotenv').config();
const path = require('path');
const { openWarehouse } = require('../lib/warehouse/db');
const { makeCompany } = require('../lib/entities/make-company');

function parseArgs(argv) {
  const opts = { dir: path.join(__dirname, '..', 'data', 'review'), status: 'private', track: 'N' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[++i];
    if (a === '--key') opts.key = v;
    else if (a === '--name') opts.name = v;
    else if (a === '--status') opts.status = v;
    else if (a === '--track') opts.track = String(v || '').toUpperCase();
    else if (a === '--dir') opts.dir = path.resolve(v);
    else throw Object.assign(new Error(`unknown argument: ${a}`), { status: 400 });
  }
  return opts;
}

function main() {
  let db;
  try {
    const opts = parseArgs(process.argv.slice(2));
    db = openWarehouse();
    const r = makeCompany(db, { ...opts, log: (...m) => console.error(...m) });
    console.log(JSON.stringify(r));
  } catch (err) {
    console.log(JSON.stringify({ error: err.message, status: err.status || 500 }));
    process.exitCode = 1;
  } finally {
    if (db) {
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.close();
    }
  }
}

main();
