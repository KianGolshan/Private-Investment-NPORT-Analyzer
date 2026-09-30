// Fund identity beyond fundKeyOf (DATA-QUALITY trap 20). Runs after every
// ingest; idempotent. In order:
//   1. fund_key_overrides: curated corrections for series IDs a filer
//      misreported, each with its EDGAR evidence.
//   2. A filing without a series ID whose series LEI matches exactly one
//      series of the same registrant joins that series (Tidal Trust IV left
//      the series ID off its 2026-04-30 filings only).
//   3. Otherwise, a registrant without series IDs that reports more than one
//      series LEI for the same report date files several funds (Invesco
//      BLDRS): key those filings by CIK + series LEI. Registrants with one fund
//      keep the CIK key even when their LEI changes over time (21 real cases,
//      e.g. the Pioneer closed-end funds), so their history stays whole.
const SERIES_MATCH = `
  SELECT MIN(s.fund_key) FROM filings s
  WHERE s.cik = filings.cik AND s.series_id IS NOT NULL AND s.series_lei = filings.series_lei
  HAVING COUNT(DISTINCT s.fund_key) = 1`;

function rekeyFunds(db) {
  return db.transaction(() => {
    const overridden = db
      .prepare(
        `UPDATE filings SET fund_key = (SELECT o.fund_key FROM fund_key_overrides o
                                        WHERE o.series_id = filings.series_id AND o.cik = filings.cik)
         WHERE EXISTS (SELECT 1 FROM fund_key_overrides o
                       WHERE o.series_id = filings.series_id AND o.cik = filings.cik AND o.fund_key <> filings.fund_key)`
      )
      .run().changes;
    const joined = db
      .prepare(
        `UPDATE filings SET fund_key = (${SERIES_MATCH})
         WHERE series_id IS NULL AND series_lei IS NOT NULL
           AND (${SERIES_MATCH}) IS NOT NULL AND (${SERIES_MATCH}) <> fund_key`
      )
      .run().changes;
    const multi = db
      .prepare(
        `UPDATE filings SET fund_key = 'CIK' || cik || ':' || series_lei
         WHERE series_id IS NULL AND series_lei IS NOT NULL AND (${SERIES_MATCH}) IS NULL
           AND cik IN (SELECT cik FROM filings WHERE series_id IS NULL AND series_lei IS NOT NULL
                       GROUP BY cik, report_date HAVING COUNT(DISTINCT series_lei) > 1)
           AND fund_key <> 'CIK' || cik || ':' || series_lei`
      )
      .run().changes;
    return { overridden, joined, multi };
  })();
}

module.exports = { rekeyFunds };
