// Reconciliation with EDGAR (ROADMAP §8, review R12): what the daily catch-up
// and the bulk quarters cannot see on their own. Read-only; run monthly.
//
//   1. Completeness: every N-PORT EDGAR's quarterly form indexes list (NPORT-P,
//      NPORT-P/A, and N-PORTs filed as NT NPORT-P, trap 59) is stored.
//   2. Deletions: every stored filing is still listed. EDGAR rebuilds its
//      quarterly indexes with deletions.
//   3. Same-accession corrections: a rotating sample of stored filings is
//      fetched again, and its report date, net assets, row count and kept rows
//      must equal what is stored.
//
// Measured 2026-10-07, before this check existed (P8 W3): 355,007 stored
// filings; 0 deleted from EDGAR; 0 of a 200-filing re-fetch changed; the
// catch-up had missed the 117 reports filed as NT NPORT-P since 2026-07-01
// (fixed in delta.js). Nothing here changes the warehouse: a finding is
// reported, and a fix goes through a job.
const { listFilings, fetchFilingRows, indexQuarters } = require('./delta');

const RECENT_DAYS = 2; // filings this new may not be stored until the next nightly run
const DAY_MS = 86400000;

// The sample for a month: filings of 1 to 5,000 rows (a re-fetch of the
// largest takes minutes), ordered by a key that shifts each month, so
// successive runs check different filings.
function sampleFor(db, n, month) {
  const salt = Number(month.replace('-', '')) % 9973;
  return db
    .prepare(
      `SELECT f.accession, f.cik, f.filing_date, f.form, f.report_date, f.net_assets, t.rows,
              (SELECT COUNT(*) FROM holdings h WHERE h.accession = f.accession) kept
       FROM filings f LEFT JOIN filing_totals t USING (accession)
       WHERE COALESCE(t.rows, 1) BETWEEN 1 AND 5000
       ORDER BY (CAST(substr(f.accession, 15) AS INTEGER) * 7919 + ?) % 100003, f.accession
       LIMIT ?`
    )
    .all(salt, n);
}

async function reconcile(
  db,
  {
    since = '2019-10-01',
    until = new Date().toISOString().slice(0, 10),
    sample = 100,
    list = listFilings,
    fetchRows = fetchFilingRows,
    log = () => {},
  } = {}
) {
  // 1 and 2: the indexes over the whole stored range at once, so a filing
  // dated at a quarter's edge is matched wherever the index lists it
  const listed = new Map();
  for (const q of indexQuarters(since, until)) {
    const [y, n] = q.split('/QTR').map(Number);
    const from = `${y}-${String((n - 1) * 3 + 1).padStart(2, '0')}-01`;
    const to = new Date(Date.UTC(y, n * 3, 0)).toISOString().slice(0, 10);
    for (const e of await list({ since: from < since ? since : from, until: to > until ? until : to }))
      listed.set(e.accession, e);
    log(`${q}: ${listed.size} listed so far`);
  }
  const stored = db
    .prepare('SELECT accession, cik, filing_date, form, source FROM filings WHERE filing_date >= ?')
    .all(since);
  const have = new Set(stored.map(f => f.accession));
  const recent = new Date(Date.parse(until) - RECENT_DAYS * DAY_MS).toISOString().slice(0, 10);
  const notStored = [...listed.values()].filter(e => !have.has(e.accession));
  const notListed = stored.filter(f => !listed.has(f.accession));

  // 3: a rotating sample, fetched again
  const changed = [];
  const failed = [];
  const picks = sample > 0 ? sampleFor(db, sample, until.slice(0, 7)) : [];
  for (const f of picks) {
    try {
      const r = await fetchRows({ accession: f.accession, cik: f.cik, filingDate: f.filing_date, form: f.form });
      const now = {
        report_date: r.filing.report_date,
        net_assets: r.filing.net_assets,
        rows: r.totals?.rows ?? null,
        kept: r.holdings.length,
      };
      // rows: only where totals are stored (every filing since P5b; not test fixtures)
      const was = { report_date: f.report_date, net_assets: f.net_assets, kept: f.kept };
      if (f.rows != null) was.rows = f.rows;
      const fields = Object.keys(was).filter(k =>
        typeof was[k] === 'number' ? Math.abs((now[k] ?? NaN) - was[k]) > 0.5 || now[k] == null : now[k] !== was[k]
      );
      if (fields.length) changed.push({ accession: f.accession, fields, was, now });
    } catch (err) {
      failed.push({ accession: f.accession, error: String(err.message).split('\n')[0] });
    }
  }

  const missing = notStored.filter(e => e.filingDate < recent);
  return {
    since,
    until,
    listed: listed.size,
    stored: stored.length,
    // findings that need action
    missing, // listed on EDGAR, filed before the last two days, not stored
    notListed, // stored, no longer in EDGAR's index (deleted or re-typed)
    changed, // re-fetched filings that differ from what is stored
    // expected or transient
    pending: notStored.filter(e => e.filingDate >= recent), // the next nightly run loads them
    sampled: picks.length,
    failed, // re-fetches that failed (network): retried next month
    ok: !missing.length && !notListed.length && !changed.length,
  };
}

module.exports = { reconcile, sampleFor };
