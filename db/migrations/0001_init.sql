-- Vantage v2 warehouse: filings, private-candidate holdings, ingest log.
-- See docs/ARCHITECTURE.md (Schema) and docs/DATA-QUALITY.md.

-- Every NPORT-P / NPORT-P/A filing, whatever it holds. Exits and dead funds
-- can only be detected against the full filing list (DATA-QUALITY traps 3, 4).
CREATE TABLE filings (
  accession     TEXT PRIMARY KEY,           -- 0001193125-26-182055
  fund_key      TEXT NOT NULL,              -- series_id, else 'CIK' || cik
  cik           TEXT,                       -- registrant CIK, no leading zeros
  series_id     TEXT,                       -- S000012345, NULL for single-fund registrants
  registrant    TEXT,
  series_name   TEXT,
  report_date   TEXT,                       -- ISO YYYY-MM-DD (repPdDate)
  filing_date   TEXT,                       -- ISO YYYY-MM-DD
  form          TEXT,                       -- NPORT-P | NPORT-P/A
  net_assets    REAL,
  total_assets  REAL,
  source        TEXT NOT NULL               -- 'bulk:2026q2' | 'edgar'
);
CREATE INDEX filings_fund_report ON filings (fund_key, report_date);
CREATE INDEX filings_filing_date ON filings (filing_date);
CREATE INDEX filings_source ON filings (source);

-- Private-candidate holdings: equity-type rows (EC, EP, OTHER, warrants) that
-- are Level 3, restricted, or carry no valid ISIN/CUSIP. Public rows with a
-- check-digit-valid identifier are not stored (docs/decisions/0003).
CREATE TABLE holdings (
  accession        TEXT NOT NULL REFERENCES filings (accession) ON DELETE CASCADE,
  row_key          TEXT NOT NULL,           -- bulk HOLDING_ID, or 'doc:<index>' for EDGAR XML rows
  issuer_name      TEXT,
  title            TEXT,
  cusip            TEXT,
  lei              TEXT,
  isin             TEXT,
  ticker           TEXT,
  other_id         TEXT,                    -- filer's own instrument id (instrumentKey)
  other_id_desc    TEXT,
  balance          REAL,
  unit             TEXT,                    -- NS shares | PA principal | NC contracts | OU other
  currency         TEXT,
  value_usd        REAL,
  pct_nav          REAL,
  asset_cat        TEXT,                    -- EC | EP | OTHER | DE
  other_asset      TEXT,                    -- assetConditional desc, e.g. 'private fund'
  issuer_type      TEXT,
  country          TEXT,
  restricted       TEXT,                    -- Y | N
  fv_level         TEXT,                    -- 1 | 2 | 3 | NULL
  deriv_cat        TEXT,                    -- WAR for warrants
  instrument_type  TEXT NOT NULL,           -- equity | indirect | derivative | debt (classifyInstrument)
  company_id       INTEGER,                 -- set in Phase 4
  via_spv          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (accession, row_key)
);
CREATE INDEX holdings_company ON holdings (company_id);

CREATE TABLE ingest_log (
  id           INTEGER PRIMARY KEY,
  kind         TEXT NOT NULL,               -- 'bulk' | 'edgar'
  quarter      TEXT,                        -- 2026q2
  source_url   TEXT,
  zip_sha256   TEXT,
  zip_bytes    INTEGER,
  filings      INTEGER,
  rows_read    INTEGER,                     -- holding rows in the source
  rows_kept    INTEGER,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  status       TEXT NOT NULL,               -- running | ok | failed
  error        TEXT
);
