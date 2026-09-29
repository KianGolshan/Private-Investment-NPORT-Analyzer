// One-off backfill of filings.series_lei / registrant_lei (migration 0005)
// for filings loaded before ingest stored them. Bulk filings are re-read from
// their SEC quarter zip (REGISTRANT.tsv, FUND_REPORTED_INFO.tsv); EDGAR
// filings from their primary_doc.xml. New ingests fill both columns directly.
// Each quarter is one transaction and is logged in ingest_log (kind
// 'lei-backfill'), so the job is resumable.
const { openZip, readTable } = require('./tsv-zip');
const { fetchFilingRows } = require('./delta');

function text(value) {
  const t = String(value ?? '').trim();
  return !t || /^(N\/?A|NONE|NULL|NIL|-+)$/i.test(t) ? null : t;
}

function doneQuarters(db) {
  return new Set(
    db
      .prepare("SELECT quarter FROM ingest_log WHERE kind = 'lei-backfill' AND status = 'ok'")
      .all()
      .map(r => r.quarter)
  );
}

async function backfillLeisFromZip(db, zipPath, { quarter }) {
  if (!/^\d{4}q[1-4]$/.test(quarter || '')) throw new Error(`bad quarter "${quarter}"`);
  const startedAt = new Date().toISOString();
  const logId = db
    .prepare(
      "INSERT INTO ingest_log (kind, quarter, source_url, started_at, status) VALUES ('lei-backfill', ?, ?, ?, 'running')"
    )
    .run(quarter, zipPath, startedAt).lastInsertRowid;
  let archive;
  try {
    archive = await openZip(zipPath);
    const regLei = new Map();
    await readTable(archive, 'REGISTRANT.tsv', r => regLei.set(r.ACCESSION_NUMBER, text(r.LEI)));
    const seriesLei = new Map();
    await readTable(archive, 'FUND_REPORTED_INFO.tsv', r => seriesLei.set(r.ACCESSION_NUMBER, text(r.SERIES_LEI)));
    const update = db.prepare(
      'UPDATE filings SET series_lei = ?, registrant_lei = ? WHERE accession = ? AND source = ?'
    );
    const source = `bulk:${quarter}`;
    let updated = 0;
    db.transaction(() => {
      for (const accession of new Set([...regLei.keys(), ...seriesLei.keys()])) {
        updated += update.run(
          seriesLei.get(accession) ?? null,
          regLei.get(accession) ?? null,
          accession,
          source
        ).changes;
      }
      // Every stored filing of the quarter must be in its zip; otherwise roll back.
      const expected = db.prepare('SELECT COUNT(*) n FROM filings WHERE source = ?').get(source).n;
      if (updated !== expected) throw new Error(`${quarter}: updated ${updated} of ${expected} stored filings`);
    })();
    db.prepare("UPDATE ingest_log SET finished_at = ?, status = 'ok', filings = ? WHERE id = ?").run(
      new Date().toISOString(),
      updated,
      logId
    );
    return { quarter, updated };
  } catch (err) {
    db.prepare("UPDATE ingest_log SET finished_at = ?, status = 'failed', error = ? WHERE id = ?").run(
      new Date().toISOString(),
      String(err.message || err),
      logId
    );
    throw err;
  } finally {
    if (archive) archive.zip.close();
  }
}

// EDGAR-sourced filings with no series ID (the only ones whose identity needs
// a LEI before the next bulk quarter replaces them).
async function backfillEdgarLeis(db, { limit = Infinity, log = () => {} } = {}) {
  const todo = db
    .prepare(
      "SELECT accession, cik, filing_date, form FROM filings WHERE source = 'edgar' AND series_id IS NULL AND registrant_lei IS NULL ORDER BY accession"
    )
    .all()
    .slice(0, limit);
  const update = db.prepare('UPDATE filings SET series_lei = ?, registrant_lei = ? WHERE accession = ?');
  const failed = [];
  for (const [i, f] of todo.entries()) {
    try {
      const { filing } = await fetchFilingRows({
        accession: f.accession,
        cik: f.cik,
        filingDate: f.filing_date,
        form: f.form,
      });
      update.run(filing.series_lei, filing.registrant_lei, f.accession);
    } catch (err) {
      failed.push({ accession: f.accession, error: String(err.message || err) });
    }
    if ((i + 1) % 100 === 0) log(`  ${i + 1}/${todo.length}`);
  }
  return { listed: todo.length, failed };
}

module.exports = { backfillLeisFromZip, backfillEdgarLeis, doneQuarters };
