#!/usr/bin/env node
// The watch report (lib/warehouse/watch.js): what changed between the published
// generation and the kept one before it that a reviewer should look at.
// Suggestions only. Writes reports/watch/<date>.md and .json.
//
//   npm run watch
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { openWarehouseReadOnly, defaultWarehousePath, generationOf } = require('../lib/warehouse/db');
const { generations } = require('../lib/warehouse/job');
const { watchReport, watchMarkdown } = require('../lib/warehouse/watch');

function runWatch(dbPath = defaultWarehousePath(), { dir = path.join(__dirname, '..', 'reports', 'watch') } = {}) {
  const current = openWarehouseReadOnly(dbPath);
  const prior = generations(dbPath).find(g => !g.published);
  const previous = prior ? new Database(prior.file, { readonly: true, fileMustExist: true }) : null;
  try {
    const r = watchReport(current, previous);
    const date = new Date().toISOString().slice(0, 10);
    fs.mkdirSync(dir, { recursive: true });
    const meta = { generation: generationOf(current), previous: prior?.id ?? null, date };
    fs.writeFileSync(path.join(dir, `${date}.md`), watchMarkdown(r, meta));
    fs.writeFileSync(path.join(dir, `${date}.json`), JSON.stringify({ ...meta, ...r }, null, 1));
    return { ...meta, counts: r.counts, file: path.join(dir, `${date}.md`) };
  } finally {
    current.close();
    if (previous) previous.close();
  }
}

if (require.main === module) {
  try {
    const w = runWatch();
    const c = w.counts;
    console.log(
      `generation ${w.generation} against ${w.previous ?? 'none'}: review queue ${c.queue} (${c.queueNew} new), ` +
        `listing evidence ${c.listing} (${c.listingNew} new), identity ${c.identity} (${c.identityNew} new), ` +
        `split identities ${c.split} (${c.splitNew} new); ${w.file}`
    );
  } catch (err) {
    console.error(`watch failed: ${err.message}`);
    process.exitCode = 1;
  }
}

module.exports = { runWatch };
