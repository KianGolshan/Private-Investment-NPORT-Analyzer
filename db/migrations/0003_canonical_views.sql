-- Phase 3: canonical filings and the per-fund filing timeline.
-- Every aggregate goes through these views (CLAUDE.md, DATA-QUALITY traps 1-4).

-- One filing per (fund_key, report_date). The latest filing_date wins, so an
-- amendment supersedes the original (IS_LAST_FILING is not reliable, trap 1).
-- Same-day ties (515 groups in real data): an NPORT-P/A beats an NPORT-P, then
-- the higher accession (the later submission) wins.
-- lib/analytics/asof.js applies the same rule to filings known by a given
-- filing date (knownAsOf); test/analytics-asof.test.js keeps the two equal.
CREATE VIEW canonical_filings AS
SELECT f.*
FROM filings f
WHERE NOT EXISTS (
  SELECT 1 FROM filings g
  WHERE g.fund_key = f.fund_key
    AND g.report_date = f.report_date
    AND g.accession <> f.accession
    AND (g.filing_date > f.filing_date
      OR (g.filing_date = f.filing_date AND (g.form = 'NPORT-P/A') > (f.form = 'NPORT-P/A'))
      OR (g.filing_date = f.filing_date AND (g.form = 'NPORT-P/A') = (f.form = 'NPORT-P/A') AND g.accession > f.accession))
);

-- Every canonical filing of every fund, whatever it contains, in report-date
-- order. Exits (a filing without the company) and dead funds (no next filing)
-- are read against this timeline (traps 3, 4).
CREATE VIEW fund_filing_timeline AS
SELECT
  c.fund_key,
  c.report_date,
  c.filing_date,
  c.accession,
  c.form,
  c.cik,
  c.series_id,
  c.registrant,
  c.series_name,
  c.net_assets,
  c.source,
  (SELECT COUNT(*) FROM filings a WHERE a.fund_key = c.fund_key AND a.report_date = c.report_date) AS versions,
  ROW_NUMBER() OVER w AS seq,
  LAG(c.report_date) OVER w AS prev_report_date,
  LEAD(c.report_date) OVER w AS next_report_date
FROM canonical_filings c
WINDOW w AS (PARTITION BY c.fund_key ORDER BY c.report_date);
