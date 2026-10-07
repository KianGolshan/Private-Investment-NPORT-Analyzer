// "Make this a company" (ROADMAP §5b task 8, ADR 0008 decision 6): an admin
// turns an unreviewed name into a reviewed company. The decision is written to
// the reviewed files (data/review/aliases.csv: one issuer_key row per key of
// the name's identity component, with the largest row's accession as
// evidence), then the review import runs exactly as `npm run review:aliases`
// does, under the refresh lock (a refresh_runs row of kind 'curation'). Any
// failure restores both review files and re-imports them, so the warehouse
// matches the files again, and fails the run: nothing half-applies.
// Local and admin-only; the web server runs it as a child process
// (scripts/make-company.js) and stays read-only. Under a warehouse job
// (lib/warehouse/job.js, pass the job's runId and its staged curationDir) the
// job owns the run row, the lock and the files: a failure discards both the
// candidate warehouse and the staged files, so nothing is restored here.
const fs = require('fs');
const path = require('path');
const { parseCsv, toCsv } = require('./csv');
const { claimRun } = require('../warehouse/refresh');
const { runReviewImport } = require('./review-import');
const { ServiceError } = require('../services/errors');

const ALIAS_COLUMNS = [
  'company',
  'status',
  'track',
  'kind',
  'alias',
  'via_spv',
  'funds_12m',
  'value_12m_musd',
  'quarters',
  'level3_share',
  'rows',
  'examples',
  'reason',
  'evidence',
  'flags',
  'note',
];

const MakeCompanyError = ServiceError;

function makeCompany(
  db,
  { dir, key, name, status = 'private', track = 'N', now = new Date(), log = () => {}, runId: jobRun = null }
) {
  const displayName = String(name || '').trim();
  if (!displayName) throw new MakeCompanyError(400, 'a company name is required');
  if (!['private', 'public'].includes(status)) throw new MakeCompanyError(400, 'status must be private or public');
  if (!['Y', 'N'].includes(track)) throw new MakeCompanyError(400, 'track must be Y or N');
  const entity = db.prepare('SELECT * FROM unreviewed_entities WHERE key = ?').get(String(key || '').toUpperCase());
  if (!entity) throw new MakeCompanyError(404, `no unreviewed name "${key}"`);
  if (!entity.active) throw new MakeCompanyError(409, `"${entity.display_name}" is no longer unreviewed`);
  const clash = db.prepare('SELECT id FROM companies WHERE name = ? COLLATE NOCASE').get(displayName);
  if (clash)
    throw new MakeCompanyError(
      409,
      `"${displayName}" is already company ${clash.id}; merge through the review files instead`
    );
  const keys = JSON.parse(entity.keys);
  const evidence = db
    .prepare('SELECT accession FROM holdings WHERE entity_id = ? ORDER BY value_usd DESC, accession LIMIT 1')
    .get(entity.id)?.accession;
  if (!evidence) throw new MakeCompanyError(409, `"${entity.display_name}" has no stored rows to cite`);

  const aliasesPath = path.join(dir, 'aliases.csv');
  const idsPath = path.join(dir, 'company_ids.csv');
  const before = { aliases: fs.readFileSync(aliasesPath, 'utf8'), ids: fs.readFileSync(idsPath, 'utf8') };
  const rows = parseCsv(before.aliases);
  const taken = rows.filter(r => r.kind === 'issuer_key' && keys.includes(r.alias) && r.company);
  if (taken.length)
    throw new MakeCompanyError(409, `issuer key "${taken[0].alias}" already belongs to "${taken[0].company}"`);

  let runId = jobRun;
  if (runId == null)
    try {
      runId = claimRun(db, now, 'curation');
    } catch (err) {
      throw new MakeCompanyError(409, `${err.message}; try again when it finishes`);
    }
  const own = jobRun == null;
  const finishRun = db.prepare('UPDATE refresh_runs SET finished_at = ?, status = ?, error = ? WHERE id = ?');
  const finish = { run: (...a) => own && finishRun.run(...a) };
  try {
    const examples = JSON.parse(entity.names).slice(0, 3).join(' | ');
    const reason = `app: made a company by the admin on ${now.toISOString().slice(0, 10)} (was unreviewed ${entity.category})`;
    for (const k of keys)
      rows.push({
        company: displayName,
        status,
        track,
        kind: 'issuer_key',
        alias: k,
        via_spv: '0',
        examples,
        reason,
        evidence,
      });
    fs.writeFileSync(aliasesPath, toCsv(ALIAS_COLUMNS, rows));
    log(`aliases.csv: ${keys.length} issuer key(s) for "${displayName}" (${evidence})`);
    // under a job, resolution only: the job rebuilds everything derived once after this
    runReviewImport(db, dir, { log, now: now.toISOString(), rebuild: own ? 'all' : 'resolve' });
    const company = db
      .prepare(
        `SELECT c.id, c.name, c.status, (SELECT COUNT(*) FROM holdings h WHERE h.company_id = c.id) rows
         FROM companies c WHERE c.name = ?`
      )
      .get(displayName);
    if (!company || !company.rows) throw new Error(`the import did not resolve any row to "${displayName}"`);
    finish.run(new Date().toISOString(), 'ok', null, runId);
    return { company, keys, evidence, runId };
  } catch (err) {
    if (!own) throw err; // the job discards its candidate and its staged files
    fs.writeFileSync(aliasesPath, before.aliases);
    fs.writeFileSync(idsPath, before.ids);
    let restore = '';
    try {
      runReviewImport(db, dir, { log, now: now.toISOString() });
    } catch (again) {
      restore = `; restoring the warehouse failed too (${again.message}): run npm run review:aliases`;
    }
    // The files stay exactly as they were; the warehouse keeps any id this run
    // assigned as retired, so it is never handed out again.
    fs.writeFileSync(idsPath, before.ids);
    finish.run(new Date().toISOString(), 'failed', String(err.message) + restore, runId);
    throw restore ? new Error(err.message + restore) : err;
  }
}

module.exports = { makeCompany, MakeCompanyError, ALIAS_COLUMNS };
