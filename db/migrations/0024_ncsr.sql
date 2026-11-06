-- P15 (2026-11-05, ADR 0011): cost and acquisition dates from the funds' own
-- shareholder reports (N-CSR, N-CSRS), as a second source next to N-PORT. These
-- tables add cost; they change no holding, mark or total. A cost reaches the app
-- only through cost_facts, and only when every admission check passes; every
-- other line is kept here with the reason it was refused.

-- One row per N-CSR read (or tried). status: ok (parsed and stored), failed
-- (parse error; no rows; retried by the next run), unreadable (the report is page
-- images; not retried).
CREATE TABLE ncsr_filings (
  accession     TEXT PRIMARY KEY,
  cik           TEXT NOT NULL,
  family        TEXT NOT NULL,
  form          TEXT NOT NULL,
  period_end    TEXT NOT NULL,
  filing_date   TEXT NOT NULL,
  document      TEXT,
  status        TEXT NOT NULL CHECK (status IN ('ok', 'failed', 'unreadable')),
  error         TEXT,
  funds         INTEGER NOT NULL DEFAULT 0,
  lines         INTEGER NOT NULL DEFAULT 0,
  attempts      INTEGER NOT NULL DEFAULT 1,
  read_at       TEXT NOT NULL
);
CREATE INDEX ncsr_filings_cik ON ncsr_filings(cik, period_end);

-- One row per fund report inside a filing (Fidelity and Morgan Stanley file several
-- funds in one N-CSR). status: ok (mapped to its series, every self-check passed,
-- its N-PORT found), unmapped (no single series in the filing header matches),
-- no_nport (no canonical N-PORT for that series and date), checks (a self-check
-- failed or noted: the whole fund report is refused).
CREATE TABLE ncsr_funds (
  accession       TEXT NOT NULL REFERENCES ncsr_filings(accession) ON DELETE CASCADE,
  fund_no         INTEGER NOT NULL,
  fund_name       TEXT,
  series_id       TEXT,
  fund_key        TEXT,
  period_end      TEXT,
  value_unit      INTEGER NOT NULL,
  net_assets_usd  REAL,
  restricted_usd  REAL,
  checks          TEXT NOT NULL,           -- JSON: [{check, ok, severity, detail}]
  nport_accession TEXT,
  status          TEXT NOT NULL CHECK (status IN ('ok', 'unmapped', 'no_nport', 'checks')),
  PRIMARY KEY (accession, fund_no)
);
CREATE INDEX ncsr_funds_nport ON ncsr_funds(nport_accession);

-- One row per line of a fund's restricted-securities (cost) table, as printed.
-- match: how the matcher joined it to N-PORT (lib/ncsr/match.js). refused: NULL when
-- every number-level admission check passed at ingest; otherwise the first check
-- that failed. The company-level checks run again at every rebuild (cost_facts).
CREATE TABLE ncsr_costs (
  accession       TEXT NOT NULL,
  fund_no         INTEGER NOT NULL,
  line_no         INTEGER NOT NULL,
  security        TEXT NOT NULL,
  acquired_first  TEXT NOT NULL,
  acquired_last   TEXT NOT NULL,
  cost_usd        REAL NOT NULL,
  cost_unit       INTEGER NOT NULL,
  value_usd       REAL,                    -- the N-CSR's value (its schedule row, or its cost table)
  shares          REAL,
  currency        TEXT,
  below_unit      INTEGER NOT NULL DEFAULT 0,
  paired_by_order INTEGER NOT NULL DEFAULT 0,
  match           TEXT NOT NULL CHECK (match IN ('exact', 'legs', 'combined', 'value', 'ambiguous', 'debt', 'none')),
  refused         TEXT,
  PRIMARY KEY (accession, fund_no, line_no),
  FOREIGN KEY (accession, fund_no) REFERENCES ncsr_funds(accession, fund_no) ON DELETE CASCADE
);

-- The N-PORT holding row(s) a line joined (one for exact; several for custody legs).
CREATE TABLE ncsr_cost_links (
  accession       TEXT NOT NULL,
  fund_no         INTEGER NOT NULL,
  line_no         INTEGER NOT NULL,
  nport_accession TEXT NOT NULL,
  row_key         TEXT NOT NULL,
  PRIMARY KEY (accession, fund_no, line_no, row_key),
  FOREIGN KEY (accession, fund_no, line_no) REFERENCES ncsr_costs(accession, fund_no, line_no) ON DELETE CASCADE
);
CREATE INDEX ncsr_cost_links_row ON ncsr_cost_links(nport_accession, row_key);

-- Derived (rebuilt by every job after the position facts): the admitted costs, one
-- row per admitted line, joined to the fund, company and instrument of its N-PORT
-- row(s). Never read by exposureAsOf, position_facts, company_stats or any total.
CREATE TABLE cost_facts (
  ncsr_accession   TEXT NOT NULL,
  fund_no          INTEGER NOT NULL,
  line_no          INTEGER NOT NULL,
  fund_key         TEXT NOT NULL,
  company_id       INTEGER NOT NULL,
  instrument_key   TEXT NOT NULL,
  class_label      TEXT,
  nport_accession  TEXT NOT NULL,
  report_date      TEXT NOT NULL,
  shares           REAL NOT NULL,
  value_usd        REAL NOT NULL,          -- N-PORT's value (the mark the app shows)
  cost_usd         REAL NOT NULL,
  cost_unit        INTEGER NOT NULL,
  acquired_first   TEXT NOT NULL,
  acquired_last    TEXT NOT NULL,
  single_lot       INTEGER NOT NULL,       -- one acquisition date: cost_per_share is an entry price
  cost_per_share   REAL,                   -- cost / shares at the report date (single lots only)
  PRIMARY KEY (ncsr_accession, fund_no, line_no)
);
CREATE INDEX cost_facts_company ON cost_facts(company_id, report_date);
CREATE INDEX cost_facts_fund ON cost_facts(fund_key, report_date);
CREATE INDEX cost_facts_nport ON cost_facts(nport_accession);

-- Derived: confirmed round prices. Single-lot entry prices of one company and class,
-- bought on the same date, agreeing within 0.5% at two or more firms.
CREATE TABLE round_prices (
  company_id      INTEGER NOT NULL,
  class_label     TEXT NOT NULL,
  acquired_on     TEXT NOT NULL,
  price           REAL NOT NULL,           -- the median of the agreeing lots
  firms           INTEGER NOT NULL,
  funds           INTEGER NOT NULL,
  evidence        TEXT NOT NULL,           -- JSON: [{fund_key, firm_id, ncsr_accession, line_no, cost_per_share}]
  PRIMARY KEY (company_id, class_label, acquired_on)
);
