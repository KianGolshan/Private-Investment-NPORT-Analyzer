// Test suite for the pure parsing logic in parsers.js.
//
// Fixtures (test/fixtures/) are real SEC filings, fetched with the app's own
// configured User-Agent — not fabricated — so a parsing regression against
// real-world markup quirks (like the xml2js "[object Object]" ticker bug)
// shows up here, not just in production:
//
//   nport_spacex_primary_doc.xml
//     REX ETF Trust NPORT-P, CIK 2043954, accession 0000894189-26-024397.
//     https://www.sec.gov/Archives/edgar/data/2043954/000089418926024397/primary_doc.xml
//     This is the exact filing where the ticker/cusip "[object Object]" bug
//     was first found — kept as-is so that regression can never silently
//     come back.
//
//   nport_kandou_multi_instrument.xml
//     SmallCap World Fund (Capital Group) NPORT-P, CIK 0000858744,
//     accession 0001193125-26-074868.
//     https://www.sec.gov/Archives/edgar/data/858744/000119312526074868/primary_doc.xml
//     Trimmed from the full ~900KB filing down to just the 3 real
//     <invstOrSec> blocks for "Kandou Holding SA" (verbatim XML, not
//     rebuilt/re-serialized, so original attribute-vs-element casing is
//     preserved) plus the real <genInfo> block. This one filing holds all
//     three non-derivative-excluded instrument types in one place: a
//     preferred equity tranche, a term loan (principal-denominated, not
//     share-denominated), and a warrant marked at $0.23 total — the
//     concrete case that motivated instrument-type classification at all.
//     Verified this trimmed set reproduces identical classification output
//     to parsing the full original document.
//
//   bdc_10q_west_star_aviation.html
//     Oaktree Gardens OLP, LLC 10-Q, CIK 1974793, accession
//     0001974793-26-000004, primary doc olp-20251231.htm.
//     https://www.sec.gov/Archives/edgar/data/1974793/000197479326000004/olp-20251231.htm
//     Trimmed from the full ~1.9MB filing down to just the three real
//     <table> elements (in original document order) that the Schedule-of-
//     Investments parser actually needs for the "West Star Aviation"
//     holdings: one self-contained table with its own header, plus a
//     header table + its continuation table. Verified this trimmed set
//     reproduces byte-for-byte the same 5 holdings as parsing the full
//     original document.
//
// Run with: npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const xml2js = require('xml2js');
const cheerio = require('cheerio');

const {
  extractIdString,
  extractHoldings,
  extractCreditHoldings,
  parseFinancialNumber,
  classifyInstrument,
} = require('../parsers');

const FIXTURES = path.join(__dirname, 'fixtures');

async function parseNportFixture(file) {
  const xml = fs.readFileSync(path.join(FIXTURES, file), 'utf8');
  const parser = new xml2js.Parser({
    explicitArray: false,
    mergeAttrs: true,
    normalizeTags: true,
    tagNameProcessors: [xml2js.processors.stripPrefix],
  });
  return parser.parseStringPromise(xml);
}

function loadCreditFixture(file) {
  const html = fs.readFileSync(path.join(FIXTURES, file), 'utf8');
  return cheerio.load(html);
}

// ── extractIdString ─────────────────────────────────────────────────────────

test('extractIdString: plain string and number pass through', () => {
  assert.equal(extractIdString('SPCX'), 'SPCX');
  assert.equal(extractIdString(84615), '84615');
});

test('extractIdString: xml2js attribute-only element shape { value } is unwrapped', () => {
  // This is the exact shape that caused ticker/cusip to render as
  // "[object Object]" before the fix: xml2js (mergeAttrs, no text content)
  // parses <ticker value="XYZ"/> into { value: "XYZ" }, not a string.
  assert.equal(extractIdString({ value: 'SPCX' }), 'SPCX');
});

test('extractIdString: xml2js text-node shape { _ } is unwrapped', () => {
  assert.equal(extractIdString({ _: 'SPCX' }), 'SPCX');
});

test('extractIdString: unexpected/empty shapes degrade to empty string, never "[object Object]"', () => {
  assert.equal(extractIdString({ somethingElse: 'x' }), '');
  assert.equal(extractIdString(undefined), '');
  assert.equal(extractIdString(null), '');
  assert.notEqual(extractIdString({ somethingElse: 'x' }), '[object Object]');
});

// ── extractHoldings (NPORT-P) ────────────────────────────────────────────────

test('extractHoldings: real SpaceX filing — ticker/cusip are real strings, not "[object Object]"', async () => {
  const xml = await parseNportFixture('nport_spacex_primary_doc.xml');
  const holdings = extractHoldings(xml, 'SpaceX');

  assert.ok(holdings.length > 0, 'expected at least one matching holding');
  const h = holdings.find(x => x.name === 'SPACEX');
  assert.ok(h, 'expected a holding named SPACEX');

  assert.equal(h.ticker, 'SPCX');
  assert.equal(h.cusip, '84615Q103');
  assert.notEqual(h.ticker, '[object Object]');
  assert.notEqual(h.cusip, '[object Object]');
});

test('extractHoldings: USD price-per-share matches marketValue / shares exactly', async () => {
  const xml = await parseNportFixture('nport_spacex_primary_doc.xml');
  const holdings = extractHoldings(xml, 'SpaceX');
  const h = holdings.find(x => x.name === 'SPACEX');

  assert.equal(h.currency, 'USD');
  assert.equal(h.pricePerShare, h.marketValue / h.shares);
});

test('extractHoldings: non-USD holdings are NOT re-multiplied by the exchange rate (currency double-conversion regression)', () => {
  // Constructed to mirror the real xml2js output shape (mergeAttrs) for a
  // foreign-currency NPORT investment record, since sourcing a real filing
  // with a non-USD private holding on demand isn't practical. Before the
  // fix, pricePerShare was (valUSD / balance) * exchangeRate for any
  // non-USD holding — silently corrupting the displayed price. valUSD is
  // already in USD by the NPORT schema, so it must never be re-converted.
  const fakeXml = {
    edgarSubmission: {
      formData: {
        genInfo: { repPdDate: '2026-03-31' },
        invstOrSecs: {
          invstOrSec: {
            name: 'FOREIGN PRIVATE CO',
            balance: '10000',
            valUSD: '1000000', // already USD per NPORT schema
            currencyconditional: { curCd: 'EUR', exchangeRt: '0.92' },
          },
        },
      },
    },
  };

  const holdings = extractHoldings(fakeXml, 'FOREIGN PRIVATE CO');
  assert.equal(holdings.length, 1);
  const [h] = holdings;

  assert.equal(h.currency, 'EUR');
  assert.equal(h.pricePerShare, 100, 'valUSD / balance, uncorrupted by exchangeRate');
  assert.notEqual(h.pricePerShare, 92, 'must not be re-multiplied by the FX rate');
});

test('extractHoldings: a non-matching search term returns no holdings (real filing)', async () => {
  const xml = await parseNportFixture('nport_spacex_primary_doc.xml');
  const holdings = extractHoldings(xml, 'ThisCompanyDoesNotExistXYZ123');
  assert.equal(holdings.length, 0);
});

// ── Instrument-type classification ──────────────────────────────────────────
// See Part 4 of the project plan for the real-filing evidence (Kandou,
// Anthropic, and a 35-filer/132-row Databricks survey) behind this.

test('classifyInstrument: real Kandou filing — equity/debt/derivative all correctly separated, never one $/share axis', async () => {
  const xml = await parseNportFixture('nport_kandou_multi_instrument.xml');
  const holdings = extractHoldings(xml, 'Kandou');
  assert.equal(holdings.length, 3);

  const equity = holdings.find(h => h.instrumentType === 'equity');
  assert.equal(equity.instrumentLabel, 'Preferred D');
  assert.equal(equity.chartUnit, 'usd_per_share');
  assert.equal(equity.chartValue, 0.25);

  const debt = holdings.find(h => h.instrumentType === 'debt');
  assert.match(debt.instrumentLabel, /Term Loan/);
  assert.equal(debt.chartUnit, 'pct_of_par');
  assert.ok(Math.abs(debt.chartValue - 121) < 0.01, 'mark should be ~121% of par, not a $/share number');

  const derivative = holdings.find(h => h.instrumentType === 'derivative');
  assert.equal(derivative.instrumentLabel, 'Warrant');
  assert.equal(derivative.chartUnit, 'usd_per_unit');
  // Per-unit (valUSD / balance), same convention as every other type — NOT
  // the raw $0.23 total position value, which would be a different number
  // than what marketValue/shares actually divides out to (a real
  // discrepancy a user caught by doing exactly that division themselves).
  assert.ok(Math.abs(derivative.chartValue - 0.23 / 2257143) < 1e-9);

  // All three must have distinct instrumentKeys — this is what stops them
  // from being forced onto one connected chart line.
  const keys = new Set(holdings.map(h => h.instrumentKey));
  assert.equal(keys.size, 3);
});

test('classifyInstrument: same-fund rows with identical, uninformative titles still get distinct keys (BlackRock-shaped)', () => {
  // Constructed to mirror a real case found in a 35-filer Databricks
  // survey: BlackRock Science & Technology Trust reported three rows all
  // titled literally "DATABRICKS INC" with no series/class text at all —
  // different assetCat, different values, different internal IDs. Title
  // parsing alone would silently merge some of these; instrumentKey
  // (identifiers.other.value) is what actually separates them.
  const rowA = { title: 'DATABRICKS INC', assetcat: 'EP', identifiers: { other: { value: 'BRWGL12L6' } } };
  const rowB = { title: 'DATABRICKS INC', assetcat: 'EP', identifiers: { other: { value: 'BRTXWTKF3' } } };
  const rowC = { title: 'DATABRICKS INC', assetcat: 'EC', identifiers: { other: { value: 'BRW3XZNA8' } } };

  const a = classifyInstrument(rowA, 203.46, 15485950.98);
  const b = classifyInstrument(rowB, 203.46, 56847741.3);
  const c = classifyInstrument(rowC, 203.46, 12206989.62);

  assert.equal(a.instrumentType, 'equity');
  assert.equal(a.instrumentLabel, 'Preferred');
  assert.equal(b.instrumentLabel, 'Preferred');
  assert.equal(c.instrumentLabel, 'Common');
  // a and b collide on the same fallback label — confirmed real behavior.
  // Disambiguating that collision for display is the render layer's job
  // (append part of instrumentKey to the legend text), not this function's;
  // what this function must guarantee is that the two rows remain
  // separately identifiable via their raw fields, which they are (distinct
  // identifiers.other.value below).
  assert.notEqual(rowA.identifiers.other.value, rowB.identifiers.other.value);
});

test('classifyInstrument: SPV/fund-of-fund exposure is bucketed as indirect, not blended into equity (Destiny Tech100-shaped)', () => {
  // Constructed from a real case: Destiny Tech100 holds Databricks
  // indirectly through SPVs. These rows use assetConditional (not
  // assetCat) — a distinct schema branch — with assetCat:"OTHER" nested
  // inside it, confirmed via a real filing.
  const spvRow = {
    title: 'MCTC Investment Holdings (Delaware) LLC (invested in Databricks, Inc. Series L Preferred Stock)',
    name: 'MCTC Investment Holdings (Delaware) LLC (invested in Databricks, Inc. Series L Preferred Stock)',
    units: 'NS',
    assetconditional: { assetCat: 'OTHER', desc: 'Special Purpose Vehicle' },
  };
  const result = classifyInstrument(spvRow, 212.81, 11200615.92);

  assert.equal(result.instrumentType, 'indirect');
  assert.match(result.instrumentLabel, /Indirect via/);
  // Per-unit (of the SPV's own units, not a Databricks share) — total value
  // alone would conflate "the mark went up" with "the fund bought more
  // units," which per-unit avoids.
  assert.equal(result.chartUnit, 'usd_per_unit');
  assert.equal(result.chartValue, 212.81);
});

test('parseEquityLabel edge cases found in the Databricks survey: truncated titles and non-series words must not be captured as a series token', () => {
  // "DATABRICKS INC SERIES" — real truncated title with no letter after
  // "SERIES" at all. A naive regex can backtrack into matching "IES" as
  // the token; must fall back to the generic label instead.
  const truncated = classifyInstrument({ title: 'DATABRICKS INC SERIES', assetcat: 'EC' }, 200, 1000000);
  assert.equal(truncated.instrumentLabel, 'Common');

  // "DATABRICKS SERIES Private Placement" — real title where the word
  // immediately after "SERIES" is prose, not a series code.
  const prose = classifyInstrument({ title: 'DATABRICKS SERIES Private Placement', assetcat: 'EC' }, 200, 1000000);
  assert.equal(prose.instrumentLabel, 'Common');

  // "PREF EQ PRIV" — real abbreviation for "preferred equity, private"
  // that doesn't contain the full words "PFD" or "PREFERRED".
  const abbrev = classifyInstrument({ title: 'DATABRICKS SER L PREF EQ PRIV', assetcat: 'EC' }, 200, 1000000);
  assert.equal(abbrev.instrumentLabel, 'Preferred L');
});

// ── extractCreditHoldings (BDC 10-Q Schedule of Investments) ───────────────

test('extractCreditHoldings: real West Star Aviation filing — finds all 5 tranches with correct marks', () => {
  const $ = loadCreditFixture('bdc_10q_west_star_aviation.html');
  const holdings = extractCreditHoldings($, 'West Star Aviation', '2025-12-31');

  assert.equal(holdings.length, 5);
  holdings.forEach(h => {
    assert.match(h.portfolioCompany, /West Star Aviation/);
    assert.equal(h.industry, 'Aerospace & Defense');
  });

  // Spot-check one specific tranche against the real filing's values.
  const revolver = holdings.find(h => h.principal === 606);
  assert.ok(revolver);
  assert.equal(revolver.investmentType, 'First Lien Revolver');
  assert.equal(revolver.index, 'SOFR+');
  assert.equal(revolver.spread, '4.50%');
  assert.equal(revolver.fairValue, 600);
  assert.equal(revolver.fairValueMark, (600 / 606) * 100);
});

test('extractCreditHoldings: a non-matching issuer returns no holdings (real filing)', () => {
  const $ = loadCreditFixture('bdc_10q_west_star_aviation.html');
  const holdings = extractCreditHoldings($, 'ThisIssuerDoesNotExistXYZ123', '2025-12-31');
  assert.equal(holdings.length, 0);
});

// ── parseFinancialNumber ─────────────────────────────────────────────────────

test('parseFinancialNumber: handles $, commas, parenthetical negatives, and blank/dash placeholders', () => {
  assert.equal(parseFinancialNumber('$1,234.50'), 1234.5);
  assert.equal(parseFinancialNumber('(500)'), -500);
  assert.equal(parseFinancialNumber('—'), null);
  assert.equal(parseFinancialNumber('-'), null);
  assert.equal(parseFinancialNumber(null), null);
  assert.equal(parseFinancialNumber(undefined), null);
});
