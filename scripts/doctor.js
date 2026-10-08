#!/usr/bin/env node
// Is the warehouse healthy, and will the next job run? Read-only (ROADMAP §8).
// Exits 1 when a check fails (a failed or interrupted job, no room on disk, no
// warehouse), so a scheduler can alert on it; warnings exit 0.
//
//   npm run doctor
require('dotenv').config();
const { defaultWarehousePath } = require('../lib/warehouse/db');
const { doctor } = require('../lib/warehouse/doctor');

const MARK = { ok: 'ok  ', warn: 'WARN', fail: 'FAIL' };
try {
  const { checks, ok } = doctor(defaultWarehousePath());
  for (const c of checks) console.log(`${MARK[c.status]}  ${c.name.padEnd(14)} ${c.detail}`);
  if (!ok) process.exitCode = 1;
} catch (err) {
  console.error(`doctor failed: ${err.message}`);
  process.exitCode = 1;
}
