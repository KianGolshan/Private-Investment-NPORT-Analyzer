// Rebuilds fund_names and fund_search (migration 0017) from the canonical
// filings, after every ingest (refresh, ingest scripts). One transaction.
function rebuildFundNames(db) {
  const t0 = Date.now();
  db.transaction(() => {
    db.prepare('DELETE FROM fund_names').run();
    db.prepare('DELETE FROM fund_search').run();
    db.prepare(
      `INSERT INTO fund_names (fund_key, cik, series_id, series_name, registrant, first_report_date,
         last_report_date, last_accession, last_net_assets, filings)
       SELECT c.fund_key, c.cik, c.series_id, c.series_name, c.registrant, s.first_d, c.report_date, c.accession,
         c.net_assets, s.n
       FROM (SELECT fund_key, MIN(report_date) first_d, MAX(report_date) last_d, COUNT(*) n
             FROM canonical_filings GROUP BY fund_key) s
       JOIN canonical_filings c ON c.fund_key = s.fund_key AND c.report_date = s.last_d`
    ).run();
    db.prepare(
      `INSERT INTO fund_search (name, fund_key)
       SELECT DISTINCT name, fund_key FROM (
         SELECT series_name name, fund_key FROM filings WHERE series_name IS NOT NULL
         UNION SELECT registrant, fund_key FROM filings WHERE registrant IS NOT NULL)`
    ).run();
  })();
  return {
    funds: db.prepare('SELECT COUNT(*) n FROM fund_names').get().n,
    names: db.prepare('SELECT COUNT(*) n FROM fund_search').get().n,
    ms: Date.now() - t0,
  };
}

module.exports = { rebuildFundNames };
