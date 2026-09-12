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
