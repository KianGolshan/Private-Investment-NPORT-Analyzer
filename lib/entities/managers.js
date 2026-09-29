// Fund → adviser → manager (parent firm).
//
// refreshFundAdvisers rebuilds fund_advisers from the raw N-CEN rows: each
// warehouse fund takes the advisers of its latest N-CEN. A fund with a series
// ID matches on it; a fund without one matches its registrant's N-CEN rows
// that carry no series ID (or the registrant's only series), and a fund keyed
// by series LEI (fund-keys.js) also matches on that LEI.
//
// Managers come from data/managers.csv (adviser file number → firm) and, for
// funds with no N-CEN, a registrant CIK → firm fallback.
const PLACEHOLDER_SERIES = /^S0+$/i;

function refreshFundAdvisers(db) {
  const funds = new Map();
  for (const r of db.prepare('SELECT DISTINCT fund_key, cik, series_id FROM filings').all()) {
    if (!funds.has(r.fund_key)) funds.set(r.fund_key, { ciks: new Set(), series: new Set() });
    const f = funds.get(r.fund_key);
    if (r.cik) f.ciks.add(r.cik);
    if (r.series_id && !PLACEHOLDER_SERIES.test(r.series_id)) f.series.add(r.series_id);
  }
  const bySeries = db.prepare('SELECT * FROM ncen_advisers WHERE series_id = ?');
  const byCik = db.prepare(
    `SELECT a.* FROM ncen_advisers a
     WHERE a.cik = ? AND (a.series_id = ''
       OR (SELECT COUNT(DISTINCT b.series_id) FROM ncen_advisers b WHERE b.accession = a.accession) = 1)`
  );
  const insert = db.prepare(
    `INSERT OR IGNORE INTO fund_advisers (fund_key, file_num, role, source_accession, ncen_filing_date)
     VALUES (?, ?, ?, ?, ?)`
  );
  let mapped = 0;
  db.transaction(() => {
    db.prepare('DELETE FROM fund_advisers').run();
    for (const [fundKey, f] of funds) {
      let rows = [];
      if (f.series.size) for (const s of f.series) rows.push(...bySeries.all(s));
      else {
        const lei = /^CIK\d+:(.+)$/.exec(fundKey)?.[1];
        for (const c of f.ciks) rows.push(...byCik.all(c));
        if (lei) rows = rows.filter(r => r.series_lei === lei);
      }
      if (!rows.length) continue;
      const latest = rows.reduce((a, b) =>
        b.filing_date > a.filing_date || (b.filing_date === a.filing_date && b.accession > a.accession) ? b : a
      );
      for (const r of rows.filter(r => r.accession === latest.accession)) {
        insert.run(fundKey, r.file_num, r.role, r.accession, r.filing_date);
      }
      mapped++;
    }
  })();
  return { funds: funds.size, mapped };
}

module.exports = { refreshFundAdvisers };
