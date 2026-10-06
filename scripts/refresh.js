#!/usr/bin/env node
// Nightly refresh: new or re-posted SEC bulk quarter(s), the EDGAR catch-up,
// N-CEN and entity upkeep, as one warehouse job (lib/warehouse/job.js): built on
// a candidate copy, validated, then published as a new generation. Exits
// non-zero if anything failed or a filing is still queued (for cron/launchd
// alerting); refuses to start while another warehouse job runs.
//
//   npm run refresh
require('dotenv').config();
const path = require('path');
const { refreshIngest } = require('../lib/warehouse/refresh');
const { runJob } = require('../lib/warehouse/job');

async function main() {
  const started = Date.now();
  const log = line => console.log(`[${new Date().toISOString()}] ${line}`);
  const r = await runJob(
    'refresh',
    async (db, { runId }) => {
      const x = await refreshIngest(db, { log });
      db.prepare(
        'UPDATE refresh_runs SET bulk_quarters_added = ?, delta_since = ?, delta_filings = ?, delta_failures = ? WHERE id = ?'
      ).run(x.added.join(','), x.since, x.delta.loaded, x.delta.failed, runId);
      if (x.problems.length) log(`PARTIAL: ${x.problems.join('; ')}`);
      return { status: x.problems.length ? 'partial' : 'ok', note: x.problems.join('; ') || null, ingest: x };
    },
    { log, entityReport: path.join(__dirname, '..', 'reports', 'entities') }
  );
  const x = r.ingest;
  console.log(
    `refresh #${r.runId} ${r.status}: bulk added [${x.added.join(' ') || 'none'}], ` +
      `catch-up since ${x.since}: ${x.delta.loaded} loaded, ${x.delta.failed} failed, ` +
      `${((Date.now() - started) / 60000).toFixed(1)} min; published generation ${r.generation}`
  );
  if (r.status !== 'ok') process.exitCode = 1;
}

main().catch(err => {
  console.error(`refresh failed: ${err.message}`);
  process.exitCode = 1;
});
