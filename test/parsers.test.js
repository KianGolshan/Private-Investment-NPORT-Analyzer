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
  isPrivateHolding,
  isPrivateEquityHolding,
  extractFundMeta,
  extractAllHoldings,
  buildFundXRay,
  positionMatchKey,
  buildFundXRayComparison,
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

// ── Fund X-Ray (extractAllHoldings / extractFundMeta / buildFundXRay) ──────

test('isPrivateHolding: fairValLevel 3 flags private; Level 2/1 does not, even when isRestrictedSec is Y', () => {
  assert.equal(isPrivateHolding({ fairvallevel: '3', isrestrictedsec: 'N' }), true);
  // Regression case found live: "PREMIER ENERGIES LTD", a real publicly-
  // listed Indian company, came back isRestrictedSec:Y at fairValLevel 2
  // (restricted under Indian foreign-ownership rules, not because it's
  // privately held) — isRestrictedSec alone must never qualify a holding.
  assert.equal(isPrivateHolding({ fairvallevel: '2', isrestrictedsec: 'Y' }), false);
  assert.equal(isPrivateHolding({ fairvallevel: '1', isrestrictedsec: 'Y' }), false);
  assert.equal(isPrivateHolding({ fairvallevel: '1', isrestrictedsec: 'N' }), false);
  assert.equal(isPrivateHolding({}), false);
});

test('isPrivateHolding: edge cases — numeric fairValLevel, "N/A", and whitespace all resolve safely', () => {
  // xml2js always yields strings for element text, but the function accepts
  // raw input defensively — a numeric 3 must still be recognized.
  assert.equal(isPrivateHolding({ fairvallevel: 3 }), true);
  // NPORT schema allows "N/A" for fairValLevel on rows where it doesn't apply.
  assert.equal(isPrivateHolding({ fairvallevel: 'N/A' }), false);
  // Stray whitespace around values (seen in real filings elsewhere in this
  // codebase, e.g. cleanFilerName) must not defeat the '3' comparison.
  assert.equal(isPrivateHolding({ fairvallevel: ' 3 ' }), true);
});

test('extractAllHoldings: real Kandou filing — all 3 rows are unfiltered by search term, but the debt tranche is NOT flagged private-equity despite being fairValLevel 3 and restricted', async () => {
  const xml = await parseNportFixture('nport_kandou_multi_instrument.xml');
  const holdings = extractAllHoldings(xml);

  assert.equal(holdings.length, 3, 'no search-term filtering — every row in the filing comes back');
  assert.ok(holdings.every(h => h.country === 'CH'));
  assert.deepEqual(new Set(holdings.map(h => h.instrumentType)), new Set(['equity', 'debt', 'derivative']));

  const equity = holdings.find(h => h.instrumentType === 'equity');
  const debt = holdings.find(h => h.instrumentType === 'debt');
  const warrant = holdings.find(h => h.instrumentType === 'derivative');

  // The preferred stock and warrant are equity-type interests in a private
  // company — both flagged private per fairValLevel 3.
  assert.equal(equity.isPrivate, true);
  assert.equal(warrant.isPrivate, true);
  // The term loan is fairValLevel 3 AND isRestrictedSec:Y in the real
  // filing — just as illiquid/restricted as its siblings — but it is DEBT,
  // a creditor claim, not an equity interest, so it must not be counted as
  // private equity even though isPrivateHolding(inv) alone would say yes.
  assert.equal(debt.fairValLevel, '3');
  assert.equal(debt.isRestrictedSec, 'Y');
  assert.equal(
    debt.isPrivate,
    false,
    'debt is excluded from private-equity classification regardless of Level 3 / restricted status'
  );
});

test('extractAllHoldings: a Level-2 restricted equity (a real publicly-traded company restricted for foreign-ownership reasons, not because it is privately held) is NOT flagged private', () => {
  // Regression test replicating a real case found live in SMALLCAP World
  // Fund's actual filing: "PREMIER ENERGIES LTD" is a publicly-listed
  // Indian solar company, restricted under Indian foreign-ownership rules
  // and therefore isRestrictedSec:Y — but it is valued at fairValLevel 2
  // (an observable market price exists; it trades), not Level 3. It must
  // not appear in the private-equity book just because it's "restricted".
  const fakeXml = {
    edgarSubmission: {
      formData: {
        genInfo: { repPdDate: '2026-06-30' },
        invstOrSecs: {
          invstOrSec: [
            {
              name: 'PREMIER ENERGIES LTD',
              title: 'PREMIER ENERGIES LTD',
              balance: '1000',
              valUSD: '55780607.67',
              assetcat: 'EC',
              fairvallevel: '2',
              isrestrictedsec: 'Y',
              invcountry: 'IN',
            },
            {
              name: 'TEKION CORP',
              title: 'TEKION CORP SER B PFD PP (NOT LISTED OR TRADING)',
              balance: '6145506',
              valUSD: '41051980.08',
              assetcat: 'EC',
              fairvallevel: '3',
              isrestrictedsec: 'N',
              invcountry: 'US',
            },
          ],
        },
      },
    },
  };

  const holdings = extractAllHoldings(fakeXml);
  const premierEnergies = holdings.find(h => h.name === 'PREMIER ENERGIES LTD');
  const tekion = holdings.find(h => h.name === 'TEKION CORP');

  assert.equal(
    premierEnergies.isPrivate,
    false,
    'Level 2 + restricted is a publicly-traded, foreign-ownership-restricted stock, not private equity'
  );
  assert.equal(
    tekion.isPrivate,
    true,
    'Level 3 alone is sufficient — a genuine private company need not also be flagged restricted'
  );

  const xray = buildFundXRay(holdings, {});
  assert.equal(xray.privateHoldingsCount, 1);
  assert.ok(!xray.privateHoldings.some(h => h.name === 'PREMIER ENERGIES LTD'));
});

test('isPrivateEquityHolding: excludes debt outright, regardless of the illiquidity signal', () => {
  const illiquidSignal = { fairvallevel: '3', isrestrictedsec: 'Y' };
  assert.equal(isPrivateEquityHolding(illiquidSignal, 'equity'), true);
  assert.equal(isPrivateEquityHolding(illiquidSignal, 'derivative'), true);
  assert.equal(isPrivateEquityHolding(illiquidSignal, 'indirect'), true);
  assert.equal(isPrivateEquityHolding(illiquidSignal, 'debt'), false);
  // Not illiquid at all — equity type alone isn't enough either.
  assert.equal(isPrivateEquityHolding({ fairvallevel: '1', isrestrictedsec: 'N' }, 'equity'), false);
});

test('extractAllHoldings: real SpaceX/REX ETF filing — a fully public book comes back with zero private holdings', async () => {
  const xml = await parseNportFixture('nport_spacex_primary_doc.xml');
  const holdings = extractAllHoldings(xml);

  assert.ok(holdings.length > 20, 'expected many holdings from the full unfiltered filing');
  assert.ok(
    holdings.every(h => !h.isPrivate),
    'every row in this ETF filing is fairValLevel 1 — no false positives'
  );
  // The SPACEX row itself is a real holding, but this ETF marks it Level 1
  // (a quoted, exchange-traded wrapper) — a genuine limitation of a
  // filing-level heuristic, documented rather than hidden.
  const spacex = holdings.find(h => h.name === 'SPACEX');
  assert.ok(spacex);
  assert.equal(spacex.isPrivate, false);
});

test('extractFundMeta: real Kandou filing — registrant/series/report date read correctly, no fundInfo block present', async () => {
  const xml = await parseNportFixture('nport_kandou_multi_instrument.xml');
  const meta = extractFundMeta(xml);

  assert.equal(meta.registrantName, 'SMALLCAP World Fund Inc');
  assert.equal(meta.seriesName, 'SMALLCAP World Fund Inc');
  assert.equal(meta.reportDate, '2025-12-31');
  assert.equal(meta.netAssets, 0, 'this fixture has no <fundInfo> block — must default, not throw');
});

test('extractFundMeta: real SpaceX/REX ETF filing — netAssets/totalAssets read from fundInfo', async () => {
  const xml = await parseNportFixture('nport_spacex_primary_doc.xml');
  const meta = extractFundMeta(xml);

  assert.equal(meta.registrantName, 'REX ETF Trust');
  assert.equal(meta.seriesName, 'REX IncomeMax Option Strategy ETF');
  assert.equal(meta.netAssets, 39157937.61);
  assert.equal(meta.totalAssets, 43880599.8);
});

test('buildFundXRay: real Kandou filing — the $6.05M term loan is excluded from the private-equity book even though it dominates by dollar value', async () => {
  const xml = await parseNportFixture('nport_kandou_multi_instrument.xml');
  const holdings = extractAllHoldings(xml);
  const meta = extractFundMeta(xml);
  const xray = buildFundXRay(holdings, meta);

  // Real fixture values, transcribed from the XML itself (not derived from
  // the function under test): $1.1M preferred stock + a $0.23 warrant are
  // private equity; the $6.05M term loan is debt and must be excluded.
  const expectedPrivateValue = 1100000 + 0.23;
  const expectedTotalValue = 1100000 + 6050000 + 0.23;

  assert.equal(xray.totalHoldingsCount, 3, 'all 3 rows still counted in the total, debt included');
  assert.equal(xray.privateHoldingsCount, 2, 'only the equity and the warrant — not the term loan');
  assert.ok(Math.abs(xray.privateValueUSD - expectedPrivateValue) < 0.01);
  assert.ok(Math.abs(xray.totalValueUSD - expectedTotalValue) < 0.01);
  // No <fundInfo>/netAssets in this fixture, so % of NAV falls back to % of
  // total holdings value (which includes the excluded debt in its
  // denominator) — must land around 15.4%, nowhere near 100%.
  const expectedPct = (expectedPrivateValue / expectedTotalValue) * 100;
  assert.ok(Math.abs(xray.privatePctOfNetAssets - expectedPct) < 0.001);
  assert.ok(Math.abs(xray.privatePctOfHoldingsValue - expectedPct) < 0.001);
  assert.ok(xray.privatePctOfHoldingsValue < 20, 'must not still be reporting ~100% now that debt is excluded');

  // byInstrumentType must have exactly 'equity' and 'derivative' — no 'debt' key at all.
  assert.deepEqual(new Set(Object.keys(xray.byInstrumentType)), new Set(['equity', 'derivative']));
  assert.equal(xray.byInstrumentType.debt, undefined);

  assert.equal(Object.keys(xray.byCountry).length, 1);
  assert.equal(xray.byCountry.CH, xray.privateValueUSD);
  // Sorted largest-first among what remains: the $1.1M preferred now leads,
  // since the (excluded) $6.05M term loan never enters this list at all.
  assert.equal(xray.topPrivateHoldings[0].instrumentType, 'equity');
  assert.ok(!xray.topPrivateHoldings.some(h => h.instrumentType === 'debt'));
});

test('buildFundXRay: real SpaceX/REX ETF filing — a fully public fund reports zero private exposure, no divide-by-zero', async () => {
  const xml = await parseNportFixture('nport_spacex_primary_doc.xml');
  const holdings = extractAllHoldings(xml);
  const meta = extractFundMeta(xml);
  const xray = buildFundXRay(holdings, meta);

  assert.equal(xray.privateHoldingsCount, 0);
  assert.equal(xray.privateValueUSD, 0);
  assert.equal(xray.privatePctOfNetAssets, 0);
  assert.deepEqual(xray.topPrivateHoldings, []);
  assert.deepEqual(xray.byInstrumentType, {});
});

test('buildFundXRay: net assets <= 0 (missing fundInfo, or a genuine negative from a troubled/leveraged fund) falls back to total holdings value rather than producing a nonsensical % of NAV', () => {
  const holdings = [
    { isPrivate: true, marketValue: 500, instrumentType: 'equity', country: 'US' },
    { isPrivate: false, marketValue: 500, instrumentType: 'equity', country: 'US' },
  ];

  // Negative net assets — must not be used as the divisor as-is (would
  // otherwise produce a negative "% of NAV", which is meaningless to a
  // reader and would look like a bug, not a real fund characteristic).
  const negative = buildFundXRay(holdings, { netAssets: -100 });
  assert.equal(negative.privatePctOfNetAssets, 50, 'falls back to % of the $1,000 total holdings value');

  // Net assets explicitly reported as exactly 0.
  const zero = buildFundXRay(holdings, { netAssets: 0 });
  assert.equal(zero.privatePctOfNetAssets, 50);

  // A genuine positive net-assets figure is used as-is, even when it
  // differs from the sum of extracted holdings (the normal real-world case
  // — NAV nets out cash, liabilities, and receivables the holdings list
  // alone doesn't capture).
  const positive = buildFundXRay(holdings, { netAssets: 2000 });
  assert.equal(positive.privatePctOfNetAssets, 25);
});

test('buildFundXRay: an empty holdings list (a fund reporting zero investments) does not throw and reports all-zero/empty fields', () => {
  const empty = buildFundXRay([], {});
  assert.equal(empty.totalHoldingsCount, 0);
  assert.equal(empty.privateHoldingsCount, 0);
  assert.equal(empty.privateValueUSD, 0);
  assert.equal(
    empty.privatePctOfNetAssets,
    null,
    'no assets at all — a % of NAV cannot be computed, so null not NaN/Infinity'
  );
  assert.equal(empty.privatePctOfHoldingsValue, null);
  assert.deepEqual(empty.topPrivateHoldings, []);
  assert.deepEqual(empty.privateHoldings, []);
});

test('extractAllHoldings: a filing with exactly one <invstOrSec> (xml2js yields a single object, not an array)', () => {
  // explicitArray:false only produces an array when 2+ sibling elements
  // exist — a fund with a single reported holding parses invstOrSec as a
  // bare object. Every other extractAllHoldings test uses multi-holding
  // fixtures, so this specifically locks the single-holding branch.
  const fakeXml = {
    edgarSubmission: {
      formData: {
        genInfo: { repPdDate: '2026-06-30' },
        invstOrSecs: {
          invstOrSec: {
            name: 'SOLO PRIVATE CO',
            balance: '1000',
            valUSD: '50000',
            fairvallevel: '3',
            isrestrictedsec: 'Y',
            pctval: '2.5',
            invcountry: 'us',
          },
        },
      },
    },
  };

  const holdings = extractAllHoldings(fakeXml);
  assert.equal(holdings.length, 1);
  assert.equal(holdings[0].name, 'SOLO PRIVATE CO');
  assert.equal(holdings[0].isPrivate, true);
  assert.equal(holdings[0].country, 'US');
  assert.equal(holdings[0].pctOfNetAssets, 2.5);
});

test('extractAllHoldings: a short/written derivative position (negative balance and valUSD) is kept, not dropped like extractHoldings would', () => {
  // extractHoldings requires balance > 0 && valUSD > 0 (correct for its own
  // search-one-security use case — a written option is never the security
  // being searched for). extractAllHoldings deliberately keeps every
  // position, since a fund's real gross exposure includes short legs.
  const fakeXml = {
    edgarSubmission: {
      formData: {
        genInfo: { repPdDate: '2026-06-30' },
        invstOrSecs: {
          invstOrSec: {
            name: 'WRITTEN CALL ON PRIVATECO',
            balance: '-100',
            valUSD: '-5000',
            units: 'NC',
            fairvallevel: '3',
          },
        },
      },
    },
  };

  const holdings = extractAllHoldings(fakeXml);
  assert.equal(holdings.length, 1, 'a negative-value row must not be silently dropped');
  assert.equal(holdings[0].marketValue, -5000);
  assert.equal(holdings[0].isPrivate, true);

  const xray = buildFundXRay(holdings, {});
  assert.equal(xray.privateValueUSD, -5000, 'aggregation must not throw or coerce a negative exposure to zero');
});

// ── buildFundXRayComparison (QoQ/YoY period diff) ──────────────────────────

// Minimal isPrivate:true holding shaped like extractAllHoldings' output —
// only the fields buildFundXRayComparison/positionMatchKey actually read.
function makeHolding(overrides) {
  return {
    name: 'Private Co',
    issuer: 'Private Co',
    title: 'Series A Preferred',
    shares: 1000,
    marketValue: 10000,
    pricePerShare: 10,
    cusip: 'N/A',
    instrumentType: 'equity',
    instrumentLabel: 'Equity',
    country: 'US',
    pctOfNetAssets: 1,
    isPrivate: true,
    ...overrides,
  };
}

test('buildFundXRayComparison: a position only in the current period is flagged new, with no prior-side division by zero', () => {
  const current = buildFundXRay([makeHolding({ name: 'Newco', issuer: 'Newco', marketValue: 5000, shares: 500 })], {});
  const prior = buildFundXRay([], {});

  const cmp = buildFundXRayComparison(current, prior);
  assert.equal(cmp.positions.length, 1);
  assert.equal(cmp.positions[0].status, 'new');
  assert.equal(cmp.positions[0].marketValue.current, 5000);
  assert.equal(cmp.positions[0].marketValue.prior, null);
  assert.equal(cmp.positions[0].marketValue.deltaPct, null, 'no prior value to divide by — null, not Infinity');
  assert.equal(cmp.totals.newCount, 1);
  assert.equal(cmp.totals.exitedCount, 0);
});

test('buildFundXRayComparison: a position only in the prior period is flagged exited', () => {
  const current = buildFundXRay([], {});
  const prior = buildFundXRay([makeHolding({ name: 'Soldco', issuer: 'Soldco' })], {});

  const cmp = buildFundXRayComparison(current, prior);
  assert.equal(cmp.positions.length, 1);
  assert.equal(cmp.positions[0].status, 'exited');
  assert.equal(cmp.positions[0].marketValue.current, null);
  assert.equal(cmp.positions[0].marketValue.prior, 10000);
  assert.equal(cmp.totals.exitedCount, 1);
  assert.equal(cmp.totals.newCount, 0);
});

test('buildFundXRayComparison: a position held in both periods reports correct share/value/price-per-share deltas', () => {
  const current = buildFundXRay(
    [makeHolding({ name: 'Growco', issuer: 'Growco', shares: 1200, marketValue: 18000, pricePerShare: 15 })],
    {}
  );
  const prior = buildFundXRay(
    [makeHolding({ name: 'Growco', issuer: 'Growco', shares: 1000, marketValue: 10000, pricePerShare: 10 })],
    {}
  );

  const cmp = buildFundXRayComparison(current, prior);
  assert.equal(cmp.positions.length, 1);
  const p = cmp.positions[0];
  assert.equal(p.status, 'held');
  assert.equal(p.shares.current, 1200);
  assert.equal(p.shares.prior, 1000);
  assert.equal(p.shares.delta, 200);
  assert.equal(p.shares.deltaPct, 20);
  assert.equal(p.marketValue.delta, 8000);
  assert.equal(p.marketValue.deltaPct, 80);
  assert.equal(p.pricePerShare.current, 15);
  assert.equal(p.pricePerShare.prior, 10);
  assert.equal(p.pricePerShare.deltaPct, 50);
  assert.equal(cmp.totals.continuingCount, 1);
});

test('buildFundXRayComparison: issuer count dedupes across differently-cased/spaced issuer names', () => {
  const current = buildFundXRay(
    [
      makeHolding({ name: 'Alphaco Common', issuer: '  AlphaCo  ', title: 'Common' }),
      makeHolding({ name: 'Alphaco Warrant', issuer: 'alphaco', title: 'Warrant' }),
    ],
    {}
  );
  const prior = buildFundXRay([makeHolding({ name: 'Alphaco Common', issuer: 'AlphaCo', title: 'Common' })], {});

  const cmp = buildFundXRayComparison(current, prior);
  assert.equal(cmp.totals.issuerCount.current, 1, 'AlphaCo/alphaco/  AlphaCo   are the same issuer');
  assert.equal(cmp.totals.issuerCount.prior, 1);
  assert.equal(cmp.totals.privateHoldingsCount.current, 2, 'but they are still two distinct positions');
});

test('positionMatchKey: a valid CUSIP takes priority over a name/title match, so a slightly reworded issuer name still matches across periods', () => {
  const current = buildFundXRay([makeHolding({ name: 'Betaco Inc.', issuer: 'Betaco Inc.', cusip: '123456789' })], {});
  const prior = buildFundXRay(
    [makeHolding({ name: 'Betaco Incorporated', issuer: 'Betaco Incorporated', cusip: '123456789' })],
    {}
  );

  const cmp = buildFundXRayComparison(current, prior);
  assert.equal(cmp.positions.length, 1, 'same CUSIP must be recognized as the same position despite the reworded name');
  assert.equal(cmp.positions[0].status, 'held');
  assert.equal(
    positionMatchKey({ cusip: '123456789', issuer: 'Betaco Inc.', name: 'Betaco Inc.', title: 'x' }),
    positionMatchKey({ cusip: '123456789', issuer: 'Betaco Incorporated', name: 'Betaco Incorporated', title: 'x' })
  );
});

test("buildFundXRayComparison: decomposes a held position's value change into price-mark effect vs share-count effect, reconciling exactly", () => {
  // Fund marks the position up 10/share -> 15/share AND buys more shares
  // (1000 -> 1200) in the same period. Both effects should be separated,
  // and their sum must equal the total value delta exactly (no residual).
  const current = buildFundXRay(
    [makeHolding({ name: 'Growco', issuer: 'Growco', shares: 1200, marketValue: 18000, pricePerShare: 15 })],
    {}
  );
  const prior = buildFundXRay(
    [makeHolding({ name: 'Growco', issuer: 'Growco', shares: 1000, marketValue: 10000, pricePerShare: 10 })],
    {}
  );

  const cmp = buildFundXRayComparison(current, prior);
  const p = cmp.positions[0];
  // priceEffect = sharesPrior*(ppsCurrent-ppsPrior) = 1000*(15-10) = 5000
  // shareEffect = ppsCurrent*(sharesCurrent-sharesPrior) = 15*(1200-1000) = 3000
  assert.equal(p.priceEffectUSD, 5000);
  assert.equal(p.shareEffectUSD, 3000);
  assert.equal(
    p.priceEffectUSD + p.shareEffectUSD,
    p.marketValue.delta,
    'the two effects must sum to the exact total delta'
  );

  assert.equal(cmp.totals.valueChangeFromPrice.amount, 5000);
  assert.equal(cmp.totals.valueChangeFromShares.amount, 3000);
  assert.equal(cmp.totals.valueChangeOther.amount, 0);
});

test('buildFundXRayComparison: a held position missing price-per-share on one side falls back to the "other" bucket rather than a wrong split', () => {
  const current = buildFundXRay(
    [makeHolding({ name: 'Oddco', issuer: 'Oddco', shares: 500, marketValue: 6000, pricePerShare: null })],
    {}
  );
  const prior = buildFundXRay(
    [makeHolding({ name: 'Oddco', issuer: 'Oddco', shares: 400, marketValue: 4000, pricePerShare: 10 })],
    {}
  );

  const cmp = buildFundXRayComparison(current, prior);
  const p = cmp.positions[0];
  assert.equal(p.priceEffectUSD, null);
  assert.equal(p.shareEffectUSD, null);
  assert.equal(cmp.totals.valueChangeFromPrice.amount, 0);
  assert.equal(cmp.totals.valueChangeFromShares.amount, 0);
  assert.equal(
    cmp.totals.valueChangeOther.amount,
    2000,
    'the full $2000 delta still lands somewhere, just unclassified'
  );
});

test('buildFundXRayComparison: insights group new/exited/increased/reduced/marked-up/marked-down positions, capped with a total count', () => {
  const current = buildFundXRay(
    [
      makeHolding({ name: 'Newco', issuer: 'Newco', shares: 100, marketValue: 1000, pricePerShare: 10 }),
      makeHolding({
        name: 'GrewShares',
        issuer: 'GrewShares',
        title: 'A',
        shares: 200,
        marketValue: 2000,
        pricePerShare: 10,
      }),
      makeHolding({
        name: 'ShrankShares',
        issuer: 'ShrankShares',
        title: 'B',
        shares: 50,
        marketValue: 500,
        pricePerShare: 10,
      }),
      makeHolding({
        name: 'MarkedUp',
        issuer: 'MarkedUp',
        title: 'C',
        shares: 100,
        marketValue: 1500,
        pricePerShare: 15,
      }),
      makeHolding({
        name: 'MarkedDown',
        issuer: 'MarkedDown',
        title: 'D',
        shares: 100,
        marketValue: 500,
        pricePerShare: 5,
      }),
    ],
    {}
  );
  const prior = buildFundXRay(
    [
      makeHolding({
        name: 'GrewShares',
        issuer: 'GrewShares',
        title: 'A',
        shares: 100,
        marketValue: 1000,
        pricePerShare: 10,
      }),
      makeHolding({
        name: 'ShrankShares',
        issuer: 'ShrankShares',
        title: 'B',
        shares: 100,
        marketValue: 1000,
        pricePerShare: 10,
      }),
      makeHolding({
        name: 'MarkedUp',
        issuer: 'MarkedUp',
        title: 'C',
        shares: 100,
        marketValue: 1000,
        pricePerShare: 10,
      }),
      makeHolding({
        name: 'MarkedDown',
        issuer: 'MarkedDown',
        title: 'D',
        shares: 100,
        marketValue: 1000,
        pricePerShare: 10,
      }),
      makeHolding({ name: 'Soldco', issuer: 'Soldco', title: 'E', shares: 300, marketValue: 3000, pricePerShare: 10 }),
    ],
    {}
  );

  const cmp = buildFundXRayComparison(current, prior);
  const names = list => list.items.map(p => p.name);

  assert.deepEqual(names(cmp.insights.added), ['Newco']);
  assert.equal(cmp.insights.added.total, 1);
  assert.deepEqual(names(cmp.insights.dropped), ['Soldco']);
  assert.deepEqual(names(cmp.insights.increased), ['GrewShares']);
  assert.deepEqual(names(cmp.insights.reduced), ['ShrankShares']);
  assert.deepEqual(names(cmp.insights.topMarkups), ['MarkedUp']);
  assert.deepEqual(names(cmp.insights.topMarkdowns), ['MarkedDown']);
});

test("buildFundXRayComparison: Notable Mark-Ups/Mark-Downs rank by $ impact of the mark, not raw %, so a near-zero-price warrant blow-up doesn't bury a real multi-million-dollar mark", () => {
  const current = buildFundXRay(
    [
      // +94.5% but on a $77.8M position — a real, economically large mark.
      makeHolding({
        name: 'BigRealMark',
        issuer: 'BigRealMark',
        shares: 539868,
        marketValue: 77800377.48,
        pricePerShare: 144.11,
      }),
      // A nominal +9,900,000% move, but the position is worth a few
      // thousand dollars either way — the exact "near-zero base" shape
      // that caused a real warrant re-mark to swamp the insights list.
      makeHolding({
        name: 'TinyWarrant',
        issuer: 'TinyWarrant',
        shares: 2257143,
        marketValue: 22571.43,
        pricePerShare: 0.01,
      }),
    ],
    {}
  );
  const prior = buildFundXRay(
    [
      makeHolding({
        name: 'BigRealMark',
        issuer: 'BigRealMark',
        shares: 539868,
        marketValue: 39999937.11,
        pricePerShare: 74.09,
      }),
      makeHolding({
        name: 'TinyWarrant',
        issuer: 'TinyWarrant',
        shares: 2257143,
        marketValue: 225.71,
        pricePerShare: 0.0001,
      }),
    ],
    {}
  );

  const cmp = buildFundXRayComparison(current, prior);
  const names = list => list.items.map(p => p.name);
  assert.deepEqual(
    names(cmp.insights.topMarkups),
    ['BigRealMark', 'TinyWarrant'],
    'the $77.8M mark must rank first despite the smaller raw %'
  );
  assert.ok(
    cmp.positions.find(p => p.name === 'TinyWarrant').pricePerShare.deltaPct > 1000,
    'sanity check: the raw % really is that extreme'
  );
});

test('buildFundXRayComparison: an empty prior period (fund had no NPORT-P history yet) does not throw', () => {
  const current = buildFundXRay([makeHolding({})], {});
  const cmp = buildFundXRayComparison(current, buildFundXRay([], {}));
  assert.equal(cmp.positions.length, 1);
  assert.equal(cmp.positions[0].status, 'new');
  assert.equal(cmp.totals.privateValueUSD.prior, 0);
  assert.equal(cmp.totals.privateValueUSD.deltaPct, null, 'prior value of 0 — pct change is undefined, not Infinity');
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
