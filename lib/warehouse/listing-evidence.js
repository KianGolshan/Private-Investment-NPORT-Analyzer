// Listing evidence (migration 0010): per issuer key, how many filings report
// it at fair-value Level 1 with a valid ISIN/CUSIP and no restriction flag.
// Collected from the rows the keep rule drops, during bulk ingest and by
// scripts/backfill-listing-evidence.js. The entity seed uses it to suggest
// status: a company many funds price from a quote is listed.
const { issuerKeyOf } = require('../../parsers');
const { isValidCusip } = require('./identifiers');

function listingEvidenceCollector() {
  // Loaded here, not at the top: bulk-ingest.js requires this module.
  const { isEquityType } = require('./bulk-ingest');
  const byKey = new Map();
  return {
    // r: a FUND_REPORTED_HOLDING row; hasValidIsin from IDENTIFIERS.tsv.
    add(r, hasValidIsin) {
      if (String(r.FAIR_VALUE_LEVEL).trim() !== '1') return;
      if (String(r.IS_RESTRICTED_SECURITY).trim().toUpperCase() === 'Y') return;
      if (!isEquityType(r)) return;
      const cusip = isValidCusip(r.ISSUER_CUSIP) ? String(r.ISSUER_CUSIP).trim().toUpperCase() : null;
      if (!hasValidIsin && !cusip) return;
      const key = issuerKeyOf({ issuer: r.ISSUER_NAME, title: r.ISSUER_TITLE });
      if (!key) return;
      const value = Number(r.CURRENCY_VALUE) || 0;
      let e = byKey.get(key);
      if (!e) byKey.set(key, (e = { rows: 0, filings: new Set(), value: 0, best: 0, accession: null, cusip: null }));
      e.rows++;
      e.filings.add(r.ACCESSION_NUMBER);
      e.value += value;
      if (e.accession === null || value > e.best) {
        e.best = value;
        e.accession = r.ACCESSION_NUMBER;
        e.cusip = cusip;
      }
    },
    size: () => byKey.size,
    store(db, quarter) {
      db.prepare('DELETE FROM listing_evidence WHERE quarter = ?').run(quarter);
      const ins = db.prepare(
        `INSERT INTO listing_evidence (issuer_key, quarter, rows, filings, value_usd, sample_accession, sample_cusip)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      for (const [key, e] of byKey) ins.run(key, quarter, e.rows, e.filings.size, e.value, e.accession, e.cusip);
      return byKey.size;
    },
  };
}

module.exports = { listingEvidenceCollector };
