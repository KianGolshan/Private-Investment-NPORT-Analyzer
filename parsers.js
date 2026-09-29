const { detectSplit } = require('./public/splits.js');

// '' for empty / placeholder text ("N/A", "NONE", "-") so callers can fall back.
function realText(v) {
  const t = String(v ?? '').trim();
  return /^(N\/?A|NONE|NULL|NIL|-+)$/i.test(t) ? '' : t;
}

// Pure filing-parsing logic, split out of server.js so it can be unit
// tested (test/parsers.test.js) without booting the Express app or hitting
// the network. No behavior change from what lived in server.js — same
// functions, same bodies, just relocated.

// NPORT identifier elements (e.g. <ticker value="XYZ"/>) parse via xml2js
// (mergeAttrs, no text content) into { value: "XYZ" } rather than a plain
// string, so a bare String(...) on them yields "[object Object]".
function extractIdString(val) {
  if (typeof val === 'string') return val;
  if (typeof val === 'number') return String(val);
  if (val && typeof val === 'object') {
    if (typeof val.value === 'string') return val.value;
    if (typeof val._ === 'string') return val._;
  }
  return '';
}

// ── Instrument classification ───────────────────────────────────────────────
// Distinguishes economically incomparable NPORT holdings (equity vs debt vs
// derivative vs indirect/fund-of-fund exposure) so they never get forced
// onto one $/share chart axis. Precedence chain and field names verified
// against real filings (Kandou/Capital Group, Anthropic/Capital Group+
// Fidelity, and a 35-filer/132-row Databricks survey) — see Part 4 of the
// project plan for the underlying evidence. Note: xml2js's normalizeTags
// lowercases XML child-element tag names but NOT attribute names merged in
// via mergeAttrs, so some nested fields (derivCat, assetCat inside
// assetConditional) keep mixed case while their parent elements are
// lowercase — both casings are checked below defensively.
function classifyInstrument(inv, pricePerShare, _valUSD) {
  // 1. Derivative (warrants/options/etc.) — structural signal, takes
  //    precedence over assetCat since a warrant is still tagged assetCat:EC
  //    (confirmed: Kandou's and a second real warrant both do this).
  const derivInfo = inv.derivativeinfo || inv.derivativeInfo;
  if (derivInfo) {
    const deriv =
      derivInfo.optionswaptionwarrantderiv ||
      derivInfo.optionsWaptionWarrantDeriv ||
      derivInfo.futrderiv ||
      derivInfo.futrDeriv ||
      derivInfo.swapderiv ||
      derivInfo.swapDeriv ||
      derivInfo.fwdderiv ||
      derivInfo.fwdDeriv;
    const cat = String(deriv?.derivCat || deriv?.derivcat || '').toUpperCase();
    const label = { WAR: 'Warrant', OPT: 'Option', FUT: 'Future', SWO: 'Swaption' }[cat] || 'Derivative';
    // Per-unit (valUSD / balance), not total valUSD: same convention as
    // every other type, and it's what stays comparable across periods even
    // if the fund's position *size* changes (buying more warrants would
    // inflate a total-value chart without the mark itself having moved).
    // Earlier design used total value here on the theory that per-warrant
    // prices are usually too tiny to read — real data proved that wrong
    // (the same Kandou warrant went from ~$0.0000001/unit in 2023 to a
    // perfectly normal $0.01/unit by 2026), so it's per-unit like the rest.
    return {
      instrumentType: 'derivative',
      instrumentLabel: label,
      chartValue: pricePerShare,
      chartUnit: 'usd_per_unit',
    };
  }

  // 2. Indirect / fund-of-fund exposure — a distinct schema branch
  //    (assetConditional, not assetCat) confirmed against real Destiny
  //    Tech100 filings holding a target company through an SPV.
  const assetConditional = inv.assetconditional || inv.assetConditional;
  const conditionalCat = String(assetConditional?.assetCat || assetConditional?.assetcat || '').toUpperCase();
  if (assetConditional && (conditionalCat === 'OTHER' || assetConditional.desc)) {
    const vehicle = String(inv.name || inv.title || '')
      .split('(')[0]
      .trim();
    return {
      instrumentType: 'indirect',
      instrumentLabel: vehicle ? `Indirect via ${vehicle}` : 'Indirect / Fund Exposure',
      chartValue: pricePerShare, // per-unit, same rationale as derivatives above
      chartUnit: 'usd_per_unit',
    };
  }

  // 3. Debt — units=PA (principal amount) is the general, robust signal
  //    that `balance` denominates principal, not shares.
  const units = String(inv.units || '').toUpperCase();
  if (units === 'PA') {
    return {
      instrumentType: 'debt',
      instrumentLabel: parseDebtLabel(inv.title),
      chartValue: pricePerShare * 100,
      chartUnit: 'pct_of_par',
    };
  }

  // 4. Equity (default) — sub-labeled via assetCat + title parsing.
  return {
    instrumentType: 'equity',
    instrumentLabel: parseEquityLabel(inv),
    chartValue: pricePerShare,
    chartUnit: 'usd_per_share',
  };
}

// Best-effort equity sub-class label. assetCat (EP/EC) reliably flags
// preferred vs. common once derivatives are excluded (verified across 35
// filers); a class/series token is parsed from title text when present,
// but real filings often omit it entirely (confirmed: e.g. BlackRock's
// bare "DATABRICKS INC" with no distinguishing text at all) — that's a
// label-quality gap, not a mis-grouping one (instrumentKey handles that).
function parseEquityLabel(inv) {
  const t = String(inv.title || '').toUpperCase();
  const assetCat = String(inv.assetcat || inv.assetCat || '').toUpperCase();

  const isPreferred = assetCat === 'EP' || /\bPFD\b|\bPREF\b|\bPREFERRED\b|\bCVT\b|\bCVY\b/.test(t);
  const isCommon = !isPreferred && (assetCat === 'EC' || /\bCOM(?:MON)?\b/.test(t));
  const isSegregated = /SEGREGATED/.test(t);

  // Matches "SER H", "SERIES H", "CL G-1", "CLASS G-1" — the conventions
  // seen across Kandou, Anthropic, and the 35-filer Databricks survey.
  // Two guards found necessary by that survey, not assumed up front:
  // (1) \b right after SER(?:IES)? plus a required separator, so a bare
  //     "...SERIES" with nothing after it (a real truncated-title case)
  //     doesn't let the engine backtrack into matching "IES" as the token;
  // (2) the captured token is capped at a few characters, so a real title
  //     like "SERIES Private Placement" doesn't capture the ordinary
  //     word "PRIVATE" as if it were a series code — actual series
  //     identifiers seen across 35 filers were never longer than this.
  const seriesMatch = t.match(/\b(?:SER(?:IES)?|CL(?:ASS)?)\b[.\s]+([A-Z0-9]{1,3}(?:-[A-Z0-9]{1,2})?)\b/);

  let base;
  if (seriesMatch) {
    base = `${isPreferred ? 'Preferred' : isCommon ? 'Common' : 'Class'} ${seriesMatch[1]}`;
  } else if (isPreferred) {
    base = 'Preferred';
  } else if (isCommon) {
    base = 'Common';
  } else {
    base = 'Equity';
  }
  return isSegregated ? `${base} (segregated)` : base;
}

// Best-effort debt label from title text, e.g. "TL PP (PHYSICAL) 7.0%
// 03-31-26" -> "Term Loan · 7.0% due 03-31-26".
function parseDebtLabel(title) {
  const t = String(title || '');
  const rateMatch = t.match(/(\d+\.?\d*)\s*%/);
  const dateMatch = t.match(/(\d{1,2}-\d{1,2}-\d{2,4})/);
  const kind = /\bTL\b/i.test(t) ? 'Term Loan' : /\bNOTE\b/i.test(t) ? 'Note' : /\bBOND\b/i.test(t) ? 'Bond' : 'Debt';
  let label = kind;
  if (rateMatch) label += ` · ${rateMatch[1]}%`;
  if (dateMatch) label += ` due ${dateMatch[1]}`;
  return label;
}

// Whole-word matcher for a user's search term. Plain substring matching let
// real look-alike issuers through: "Revolut" matched REVOLUTION MEDICINES INC,
// "OpenAI" matched OpenAir.com, "Anthropic" matched Anthropics Technology Ltd.
// The term must start and end on a word boundary (letters/digits); inner
// whitespace matches any run of whitespace, and surrounding quotes (as typed
// for an exact-phrase EDGAR search) are ignored.
function termMatcher(term) {
  const t = String(term ?? '')
    .trim()
    .replace(/^"(.*)"$/, '$1')
    .trim();
  if (!t) return () => false;
  const pattern = t
    .split(/\s+/)
    .map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\s+');
  const re = new RegExp(`(?:^|[^a-z0-9])${pattern}(?=$|[^a-z0-9])`, 'i');
  return text => re.test(String(text || ''));
}

function extractHoldings(xml, securitySearchTerm) {
  const holdings = [];
  try {
    const formData =
      xml.edgarSubmission?.formData ||
      xml.edgarSubmission?.formdata ||
      xml.edgarsubmission?.formData ||
      xml.edgarsubmission?.formdata;

    if (!formData) return holdings;

    const genInfo = formData.genInfo || formData.geninfo || {};
    const reportDate = genInfo.repPdDate || genInfo.reppddate || genInfo.reportDate || '';
    // A registrant (trust) files one NPORT-P per fund series; without the
    // series name, two different funds of one trust look like one fund.
    const seriesName = String(genInfo.seriesName || genInfo.seriesname || '').trim();

    let investments =
      formData.invstOrSecs?.invstOrSec || formData.invstorsecs?.invstorsec || formData.investments?.investment;

    if (!investments) return holdings;
    if (!Array.isArray(investments)) investments = [investments];

    const matchesTerm = termMatcher(securitySearchTerm);
    const tickerTerm = String(securitySearchTerm ?? '')
      .trim()
      .toLowerCase();

    for (const inv of investments) {
      const title = String(inv.title || inv.Title || inv.desc || inv.description || '');
      // Real filings (T. Rowe Price, older periods) put the literal "N/A" in
      // <name>; the security title is then the only place the company appears.
      const name = realText(inv.name || inv.Name || inv.issuerName) || title;
      const issuer = realText(inv.issuer?.name || inv.issuer?.Name || inv.issuerName);
      const ticker =
        extractIdString(inv.identifiers?.ticker) || extractIdString(inv.ticker) || extractIdString(inv.Ticker);

      const matches =
        matchesTerm(name) ||
        matchesTerm(issuer) ||
        matchesTerm(title) ||
        (ticker !== '' && ticker.toLowerCase() === tickerTerm);

      if (!matches) continue;

      const balance = parseFloat(inv.balance || inv.Balance || inv.shares || inv.Shares || 0);
      const valUSD = parseFloat(inv.valUSD || inv.valusd || inv.marketValue || inv.MarketValue || 0);
      if (!(balance > 0 && valUSD > 0)) continue;

      const currencyCode = String(
        inv.currencyconditional?.curCd ||
          inv.currencyconditional?.curcd ||
          inv.curCd ||
          inv.curcd ||
          inv.currencyCode ||
          inv.currency ||
          'USD'
      )
        .trim()
        .toUpperCase();

      const exchangeRate = parseFloat(
        inv.currencyconditional?.exchangeRt ||
          inv.currencyconditional?.exchangert ||
          inv.exchangeRt ||
          inv.exchangert ||
          inv.exchangeRate ||
          inv.fxRate ||
          inv.fxrate ||
          1
      );

      // NPORT's valUSD is already expressed in USD by schema, so
      // valUSD / balance is already the correct USD price per share.
      // (Previously this was re-multiplied by exchangeRate for non-USD
      // holdings, silently corrupting the price shown for foreign marks.)
      const pricePerShare = valUSD / balance;
      const cusip = extractIdString(inv.identifiers?.cusip) || extractIdString(inv.cusip) || extractIdString(inv.CUSIP);

      const { instrumentType, instrumentLabel, chartValue, chartUnit } = classifyInstrument(inv, pricePerShare, valUSD);

      // Grouping key for chart lines / dedup: prefer the filer's own
      // per-instrument internal symbol (identifiers.other.value — present
      // on 132/132 real rows checked across 35 independent filers, and the
      // only thing that correctly separates same-fund holdings that share
      // identical, uninformative title text), then a real CUSIP, then the
      // title itself as a last resort.
      const otherIdValue =
        extractIdString(inv.identifiers?.other?.value) || String(inv.identifiers?.other?.value || '').trim();
      const instrumentKey = instrumentKeyOf({ otherId: otherIdValue, cusip, title, name });

      holdings.push({
        name,
        issuer,
        title,
        seriesName,
        shares: balance,
        marketValue: valUSD,
        pricePerShare,
        currency: currencyCode,
        exchangeRate,
        reportDate,
        cusip,
        ticker,
        instrumentType,
        instrumentLabel,
        instrumentKey,
        chartValue,
        chartUnit,
      });
    }
  } catch (err) {
    console.error('Error extracting holdings:', err.message);
  }
  return holdings;
}

// ── Fund-wide extraction (Fund X-Ray) ───────────────────────────────────────
// extractHoldings() above is scoped to holdings matching one search term, by
// design, for the Single Security / Batch / Watchlist / Private Credit flows.
// Fund X-Ray needs the opposite: every holding in a filing, unfiltered, so a
// fund's total private-market exposure can be measured. These are kept as
// sibling functions rather than a refactor of extractHoldings, so that
// function's existing, tested behavior (and the tests pinning it) is
// untouched.

// A holding is illiquid/hard-to-value using the one field NPORT-P itself
// carries for exactly this purpose: fairValLevel 3 (valued with unobservable
// inputs — the SEC's own fair-value hierarchy for hard-to-value assets).
// Verified against two real fixtures: the Kandou filing (all three rows
// fairValLevel 3) and the SpaceX/REX ETF filing (every one of its ~30 rows
// fairValLevel 1 — a normal, fully public book), so a public-only fund
// correctly comes back with zero private exposure rather than false
// positives.
//
// isRestrictedSec Y is deliberately NOT used here, even though it sounds
// like it should qualify — it flags resale restrictions on a SECURITY, not
// that the ISSUER is privately held. A real case caught live: "PREMIER
// ENERGIES LTD" (a publicly-listed Indian solar company) came back
// isRestrictedSec:Y at fairValLevel 2 — restricted under Indian
// foreign-ownership rules, not because it's a private startup; fairValLevel
// 2 means it's still valued from OBSERVABLE market inputs (i.e. it trades).
// Level 3 alone is the correct, principled signal for "genuinely illiquid,
// no observable market" — which is what "private" actually means here.
//
// This alone is still NOT "private equity" — Rule 144A institutional bonds
// are also routinely Level 3 despite being ordinary fixed-income paper, not
// startup/VC-style equity. isPrivateEquityHolding below (which also
// excludes debt) is what Fund X-Ray actually uses.
function isPrivateHolding(inv) {
  const fairValLevel = String(inv.fairvallevel ?? inv.fairValLevel ?? '').trim();
  return fairValLevel === '3';
}

// Private EQUITY specifically — an illiquid/restricted holding (per
// isPrivateHolding above) that is also an equity-type interest, not debt.
// "Equity-type" includes derivative (a warrant/option is a claim on private
// equity shares — real case: the Kandou warrant) and indirect (an SPV/
// fund-of-fund vehicle wrapping equity — real case: Destiny Tech100's
// Databricks SPV), since both represent ownership exposure to a private
// company, just structured indirectly. Debt is excluded outright — a term
// loan or bond is a creditor claim, never an equity interest, regardless of
// how illiquid or restricted it is (the Kandou term loan is fairValLevel 3
// AND isRestrictedSec:Y, exactly like its sibling preferred-stock row, but
// it is a loan, not a private equity stake).
function isPrivateEquityHolding(inv, instrumentType) {
  return instrumentType !== 'debt' && isPrivateHolding(inv);
}

// Fund/filing-level context (registrant + series name, report date, total
// and net assets) — not tied to any one holding, needed to express a
// holding's dollar exposure as a % of the fund's own net assets.
function extractFundMeta(xml) {
  const formData =
    xml.edgarSubmission?.formData ||
    xml.edgarSubmission?.formdata ||
    xml.edgarsubmission?.formData ||
    xml.edgarsubmission?.formdata;
  if (!formData) return {};

  const genInfo = formData.genInfo || formData.geninfo || {};
  const fundInfo = formData.fundInfo || formData.fundinfo || {};

  return {
    registrantName: String(genInfo.regName || genInfo.regname || ''),
    seriesName: String(genInfo.seriesName || genInfo.seriesname || ''),
    seriesId: String(genInfo.seriesId || genInfo.seriesid || ''),
    seriesLei: String(genInfo.seriesLei || genInfo.serieslei || ''),
    registrantLei: String(genInfo.regLei || genInfo.reglei || ''),
    reportDate: String(genInfo.repPdDate || genInfo.reppddate || genInfo.reportDate || ''),
    totalAssets: parseFloat(fundInfo.totAssets || fundInfo.totassets || 0) || 0,
    netAssets: parseFloat(fundInfo.netAssets || fundInfo.netassets || 0) || 0,
  };
}

// The filing's <invstOrSec> entries as parsed objects, in document order
// ([] when the filing has none).
function nportInvestments(xml) {
  const formData =
    xml?.edgarSubmission?.formData ||
    xml?.edgarSubmission?.formdata ||
    xml?.edgarsubmission?.formData ||
    xml?.edgarsubmission?.formdata;
  if (!formData) return [];
  const investments =
    formData.invstOrSecs?.invstOrSec || formData.invstorsecs?.invstorsec || formData.investments?.investment;
  if (!investments) return [];
  return Array.isArray(investments) ? investments : [investments];
}

// Every investment in the filing, unfiltered by search term — the raw
// material for a fund-wide private-equity-vs-everything-else breakdown.
// Each holding carries rowIndex, its position in nportInvestments(xml), so
// the warehouse can read further raw fields from the same entry.
function extractAllHoldings(xml) {
  const holdings = [];
  try {
    const formData =
      xml.edgarSubmission?.formData ||
      xml.edgarSubmission?.formdata ||
      xml.edgarsubmission?.formData ||
      xml.edgarsubmission?.formdata;
    if (!formData) return holdings;

    const genInfo = formData.genInfo || formData.geninfo || {};
    const reportDate = genInfo.repPdDate || genInfo.reppddate || genInfo.reportDate || '';

    const investments = nportInvestments(xml);
    if (!investments.length) return holdings;

    for (let rowIndex = 0; rowIndex < investments.length; rowIndex++) {
      const inv = investments[rowIndex];
      const title = String(inv.title || inv.Title || inv.desc || inv.description || '');
      // Real filings (T. Rowe Price, older periods) put the literal "N/A" in
      // <name>; the security title is then the only place the company appears.
      const name = realText(inv.name || inv.Name || inv.issuerName) || title;
      const issuer = realText(inv.issuer?.name || inv.issuer?.Name || inv.issuerName);
      const ticker =
        extractIdString(inv.identifiers?.ticker) || extractIdString(inv.ticker) || extractIdString(inv.Ticker);

      const balance = parseFloat(inv.balance || inv.Balance || inv.shares || inv.Shares || 0);
      const valUSD = parseFloat(inv.valUSD || inv.valusd || inv.marketValue || inv.MarketValue || 0);
      if (!balance && !valUSD) continue; // skip empty/placeholder rows only — keep shorts/negatives, unlike extractHoldings

      const pricePerShare = balance ? valUSD / balance : null;
      const cusip = extractIdString(inv.identifiers?.cusip) || extractIdString(inv.cusip) || extractIdString(inv.CUSIP);

      const { instrumentType, instrumentLabel, chartValue, chartUnit } = classifyInstrument(inv, pricePerShare, valUSD);

      const otherIdValue =
        extractIdString(inv.identifiers?.other?.value) || String(inv.identifiers?.other?.value || '').trim();
      const instrumentKey = instrumentKeyOf({ otherId: otherIdValue, cusip, title, name });

      holdings.push({
        name,
        issuer,
        title,
        shares: balance,
        marketValue: valUSD,
        pricePerShare,
        reportDate,
        cusip,
        ticker,
        instrumentType,
        instrumentLabel,
        instrumentKey,
        filerId: otherIdValue,
        chartValue,
        chartUnit,
        isPrivate: isPrivateEquityHolding(inv, instrumentType),
        fairValLevel: String(inv.fairvallevel ?? inv.fairValLevel ?? '').trim(),
        isRestrictedSec: String(inv.isrestrictedsec ?? inv.isRestrictedSec ?? '')
          .trim()
          .toUpperCase(),
        pctOfNetAssets: parseFloat(inv.pctval ?? inv.pctVal ?? 0) || 0,
        country: String(inv.invcountry ?? inv.invCountry ?? '')
          .trim()
          .toUpperCase(),
        rowIndex,
      });
    }
  } catch (err) {
    console.error('Error extracting all holdings:', err.message);
  }
  return holdings;
}

// Aggregates a fund's full holdings list into the Fund X-Ray dashboard
// shape: total private-EQUITY $ exposure, % of NAV, instrument-type mix
// (equity/derivative/indirect only — debt is excluded by isPrivate itself,
// see isPrivateEquityHolding), geography mix, and the private book itself
// (sorted, largest first).
function buildFundXRay(holdings, fundMeta) {
  const meta = fundMeta || {};
  const privateHoldings = [...holdings.filter(h => h.isPrivate)].sort(
    (a, b) => (b.marketValue || 0) - (a.marketValue || 0)
  );
  const publicHoldings = holdings.filter(h => !h.isPrivate);

  const sumValue = arr => arr.reduce((sum, h) => sum + (h.marketValue || 0), 0);
  const privateValueUSD = sumValue(privateHoldings);
  const totalValueUSD = sumValue(holdings);
  // A fund reporting net assets <= 0 (missing <fundInfo>, or a genuine but
  // nonsensical-to-percent-against value from a troubled/leveraged fund)
  // falls back to the sum of its own reported holdings — never divides by
  // a zero or negative denominator, which would otherwise render as a
  // meaningless negative or infinite "% of NAV".
  const netAssets = meta.netAssets > 0 ? meta.netAssets : totalValueUSD;

  const byInstrumentType = {};
  const byCountry = {};
  for (const h of privateHoldings) {
    byInstrumentType[h.instrumentType] = (byInstrumentType[h.instrumentType] || 0) + (h.marketValue || 0);
    const country = h.country || 'Unknown';
    byCountry[country] = (byCountry[country] || 0) + (h.marketValue || 0);
  }

  return {
    fund: meta,
    totalHoldingsCount: holdings.length,
    publicHoldingsCount: publicHoldings.length,
    privateHoldingsCount: privateHoldings.length,
    privateValueUSD,
    totalValueUSD,
    privatePctOfNetAssets: netAssets ? (privateValueUSD / netAssets) * 100 : null,
    privatePctOfHoldingsValue: totalValueUSD ? (privateValueUSD / totalValueUSD) * 100 : null,
    byInstrumentType,
    byCountry,
    privateHoldings,
    topPrivateHoldings: privateHoldings.slice(0, 10),
    capitalStructure: buildIssuerCapitalStructure(holdings, meta.netAssets > 0 ? meta.netAssets : 0),
  };
}

// Issuer identity for grouping instruments of one company. Filers disagree on
// what <name> holds: some put the bare issuer ("KANDOU HOLDING SA"), others the
// whole security description ("WAYMO LLC SER A-2 CVT PFD UNITS PP", "DATABRICKS
// INC-CL A PP") with <issuer> empty — real T. Rowe Price filings. So the
// instrument descriptors and corporate suffixes are stripped to leave a stem.
const ISSUER_CUT_TOKENS = new Set([
  'SER',
  'SERIES',
  'CL',
  'CLASS',
  'CVT',
  'CONV',
  'CONVERTIBLE',
  'PFD',
  'PREF',
  'PREFERRED',
  'COM',
  'COMMON',
  'STOCK',
  'STK',
  'SHARES',
  'SHARE',
  'UNIT',
  'UNITS',
  'WT',
  'WTS',
  'WARRANT',
  'WARRANTS',
  'TL',
  'TERM',
  'LOAN',
  'NOTE',
  'NOTES',
  'BOND',
  'BONDS',
  'PP',
  'PC',
  'EV',
  'LLV',
  'INT',
  'SAFE',
  'OPTION',
  'OPTIONS',
  'RT',
  'CVR',
]);
const ISSUER_SUFFIX_TOKENS = new Set([
  'INC',
  'LLC',
  'CORP',
  'CORPORATION',
  'LTD',
  'LIMITED',
  'PBC',
  'CO',
  'COMPANY',
  'HOLDING',
  'HOLDINGS',
  'GROUP',
  'LP',
  'LLP',
  'SA',
  'AG',
  'GMBH',
  'PLC',
  'NV',
  'BV',
  'SPV',
  'THE',
]);
function issuerKeyOf(h) {
  const raw = String(realText(h.issuer) || realText(h.name) || realText(h.title) || '')
    .toUpperCase()
    .replace(/\([^)]*\)/g, ' ');
  const tokens = raw.split(/[^A-Z0-9]+/).filter(Boolean);
  const kept = [];
  for (const t of tokens) {
    if (kept.length && ISSUER_CUT_TOKENS.has(t)) break;
    kept.push(t);
  }
  const isClassToken = tok => /^[A-Z]?\d*$/.test(tok) && tok.length <= 2;
  while (kept.length > 1 && (ISSUER_SUFFIX_TOKENS.has(kept[kept.length - 1]) || isClassToken(kept[kept.length - 1])))
    kept.pop();
  return kept.join(' ') || normalizeMatchText(raw);
}

// ── Per-issuer capital-structure rollup (Fund X-Ray) ────────────────────────
// A fund can hold several instruments in ONE private company at once (real
// case: Kandou — Series D preferred + warrants + a 7.0% term loan, all in one
// filing). buildFundXRay buckets by instrument type across the whole book, so
// nothing tied those back together. This groups every holding of an issuer
// that has at least one private-equity position, ordered by seniority
// (debt > preferred > common/indirect > derivative).

function seniorityRank(h) {
  if (h.instrumentType === 'debt') return 1;
  if (h.instrumentType === 'equity' && /^Preferred/.test(h.instrumentLabel || '')) return 2;
  if (h.instrumentType === 'derivative') return 4;
  return 3;
}

function parseDebtTerms(title) {
  const t = String(title || '');
  const rate = t.match(/(\d+\.?\d*)\s*%/);
  const date = t.match(/(\d{1,2}-\d{1,2}-\d{2,4})/);
  return { couponPct: rate ? parseFloat(rate[1]) : null, maturity: date ? date[1] : null };
}

function buildIssuerCapitalStructure(holdings, netAssets) {
  const byIssuer = new Map();
  for (const h of holdings) {
    const key = issuerKeyOf(h);
    if (!key) continue;
    if (!byIssuer.has(key)) byIssuer.set(key, []);
    byIssuer.get(key).push(h);
  }

  const out = [];
  for (const [, hs] of byIssuer) {
    if (!hs.some(h => h.isPrivate)) continue;
    const instruments = hs
      .map(h => ({
        title: h.title,
        instrumentType: h.instrumentType,
        instrumentLabel: h.instrumentLabel,
        marketValue: h.marketValue || 0,
        shares: h.shares,
        pricePerShare: h.pricePerShare,
        seniority: seniorityRank(h),
        ...(h.instrumentType === 'debt' ? parseDebtTerms(h.title) : {}),
      }))
      .sort((a, b) => a.seniority - b.seniority || b.marketValue - a.marketValue);

    const totalValueUSD = instruments.reduce((s, i) => s + i.marketValue, 0);
    const byType = {};
    for (const i of instruments) byType[i.instrumentType] = (byType[i.instrumentType] || 0) + i.marketValue;
    const debtUSD = byType.debt || 0;
    const weightedCoupon = instruments
      .filter(i => i.instrumentType === 'debt' && i.couponPct != null && i.marketValue > 0)
      .reduce((acc, i) => ({ w: acc.w + i.marketValue, c: acc.c + i.marketValue * i.couponPct }), { w: 0, c: 0 });

    out.push({
      issuer: hs[0].issuer || hs[0].name,
      totalValueUSD,
      pctOfNetAssets: netAssets > 0 ? (totalValueUSD / netAssets) * 100 : null,
      byType,
      debtPctOfExposure: totalValueUSD ? (debtUSD / totalValueUSD) * 100 : null,
      weightedDebtCouponPct: weightedCoupon.w ? weightedCoupon.c / weightedCoupon.w : null,
      multiTranche: Object.keys(byType).length > 1,
      instruments,
    });
  }
  return out.sort((a, b) => b.totalValueUSD - a.totalValueUSD);
}

// ── Fund X-Ray period comparison (QoQ / YoY) ────────────────────────────────

// Lowercase/trim/collapse-whitespace normalization for name-based matching
// below — cheap insurance against two filings spelling the same issuer with
// different capitalization or stray whitespace.
function normalizeMatchText(s) {
  return String(s || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

// The join key used to identify "the same private investment" across TWO
// DIFFERENT filings of the same fund (a different job from instrumentKey
// above, which only needs to distinguish rows WITHIN one filing). Deliberately
// does NOT reuse instrumentKey's top priority (identifiers.other.value) — that
// value is a filer-internal symbol never verified stable across a fund's own
// quarters, only used today to disambiguate same-filing rows sharing an
// uninformative title. A valid CUSIP is a genuinely stable cross-period
// identifier, so it takes priority here; otherwise fall back to normalized
// issuer/name + title (title is kept because share-class distinctions, e.g.
// Series A vs Series B preferred, are economically different investments).
// Private placements routinely carry a dummy CUSIP (real filings: "000000000"
// on many unrelated holdings in one fund) — matching on it pairs different
// companies. Reject all-one-character values outright; matchFundXRayPositions
// additionally ignores any CUSIP that repeats within a single filing.
function usableCusip(raw) {
  const c = String(raw || '')
    .trim()
    .toUpperCase();
  return /^[0-9A-Z]{9}$/.test(c) && !/^(.)\1{8}$/.test(c) ? c : null;
}
// Within-filing instrument key (instrumentKey above): the filer's own id,
// else a real CUSIP, else the title, else the name. The warehouse keys a
// (fund, instrument) series the same way (lib/analytics/asof.js), which
// follows renames such as "STRIPE INC" -> "STRIPE LLC" (DATA-QUALITY trap 10).
function instrumentKeyOf({ otherId, cusip, title, name }) {
  return otherId || usableCusip(cusip) || title || name;
}
function cusipKeyOf(h) {
  return usableCusip(h.cusip);
}
function nameKeyOf(h) {
  return 'name:' + normalizeMatchText(h.issuer || h.name) + '|' + normalizeMatchText(h.title);
}
function positionMatchKey(h) {
  const cusip = cusipKeyOf(h);
  return cusip ? 'cusip:' + cusip : nameKeyOf(h);
}

// Pairs current- and prior-period holdings across two filings. A valid
// CUSIP is preferred (a genuinely stable cross-period identifier), but a
// holding whose CUSIP is populated on only one side (newly assigned or
// corrected this quarter, blank/"N/A" last quarter — common for
// illiquid/private names) falls back to a name+title match instead of
// being wrongly reported as BOTH "exited" (under its old keyless identity)
// and "new" (under its new CUSIP) for what is really one continuing
// position.
// Pairs the same position across two filings. Identity, strongest first:
//   1. the filer's own instrument id (identifiers.other) when unique on both
//      sides — checked on 3,652 real position-period pairs from 20+ funds: it
//      agreed with title matching 100% of the time when both were unique, and
//      it alone survived 28 real title changes ("Series F1" → "Series F-1",
//      "Canva, Inc." → "Canva Australia Holdings Pty. Ltd.");
//   2. a CUSIP that is unique within each filing (private placements reuse
//      dummy CUSIPs like "000000000" across unrelated holdings);
//   3. normalized issuer + title, pairing repeated titles in order.
function matchFundXRayPositions(currentHoldings, priorHoldings) {
  const countBy = (list, keyFn) => {
    const counts = new Map();
    for (const h of list) {
      const k = keyFn(h);
      if (k) counts.set(k, (counts.get(k) || 0) + 1);
    }
    return counts;
  };
  const idOf = h => (h.filerId ? String(h.filerId).trim() : null);
  const tiers = [{ keyFn: idOf }, { keyFn: cusipKeyOf }];
  const tierCounts = tiers.map(t => ({
    prior: countBy(priorHoldings, t.keyFn),
    current: countBy(currentHoldings, t.keyFn),
  }));

  const priorByTier = tiers.map(() => new Map());
  const priorByName = new Map();
  priorHoldings.forEach(p => {
    tiers.forEach((t, i) => {
      const k = t.keyFn(p);
      if (k && tierCounts[i].prior.get(k) === 1) priorByTier[i].set(k, p);
    });
    const nk = nameKeyOf(p);
    if (!priorByName.has(nk)) priorByName.set(nk, []);
    priorByName.get(nk).push(p);
  });

  const matchedPrior = new Set();
  const pairs = [];
  for (const c of currentHoldings) {
    let p = null;
    for (let i = 0; i < tiers.length && !p; i++) {
      const k = tiers[i].keyFn(c);
      if (k && tierCounts[i].current.get(k) === 1) {
        const cand = priorByTier[i].get(k);
        if (cand && !matchedPrior.has(cand)) p = cand;
      }
    }
    if (!p) p = (priorByName.get(nameKeyOf(c)) || []).find(x => !matchedPrior.has(x)) || null;
    pairs.push({ key: positionMatchKey(c), current: c, prior: p });
    if (p) matchedPrior.add(p);
  }
  for (const p of priorHoldings) {
    if (matchedPrior.has(p)) continue;
    pairs.push({ key: positionMatchKey(p), current: null, prior: p });
  }
  return pairs;
}

// Like deltaBlock, but the prior value is restated onto the current basis
// (prior × factor) before differencing — used across a stock split.
function splitAdjustedBlock(current, prior, factor) {
  const adjPrior = prior * factor;
  const delta = current - adjPrior;
  return { current, prior, delta, deltaPct: adjPrior !== 0 ? (delta / Math.abs(adjPrior)) * 100 : null };
}

function deltaBlock(current, prior) {
  const c = current ?? null;
  const p = prior ?? null;
  const delta = c != null && p != null ? c - p : null;
  const deltaPct = c != null && p != null && p !== 0 ? (delta / Math.abs(p)) * 100 : null;
  return { current: c, prior: p, delta, deltaPct };
}

// Diffs two already-built buildFundXRay() results (same fund, two different
// filings) into a QoQ/YoY comparison: which private investments are new this
// period, which were exited, and how shares/value/price-per-share/% of NAV
// changed for positions held in both periods. Pure function — does not
// reclassify any holding, so it carries no PARSE_VERSION dependency of its
// own beyond whatever the two buildFundXRay results already reflect.
function buildFundXRayComparison(current, prior) {
  const currentHoldings = current?.privateHoldings || [];
  const priorHoldings = prior?.privateHoldings || [];

  const positions = matchFundXRayPositions(currentHoldings, priorHoldings).map(({ key, current: c, prior: p }) => {
    const status = c && p ? 'held' : c ? 'new' : 'exited';
    const base = c || p;

    // A stock split changes units and price by a clean opposite ratio at
    // constant value; without adjusting for it, the "position sizing" effect
    // balloons and the price effect reads as a markdown (real case: a 5-for-1
    // split at a SpaceX SPV holding).
    const splitRatio = status === 'held' ? detectSplit(p, c) : null;
    const k = splitRatio || 1;
    const marketValue = deltaBlock(c?.marketValue, p?.marketValue);
    const pctOfNetAssets = deltaBlock(c?.pctOfNetAssets, p?.pctOfNetAssets);
    const shares = splitRatio ? splitAdjustedBlock(c.shares, p.shares, splitRatio) : deltaBlock(c?.shares, p?.shares);
    const pricePerShare = splitRatio
      ? splitAdjustedBlock(c.pricePerShare, p.pricePerShare, 1 / splitRatio)
      : deltaBlock(c?.pricePerShare ?? null, p?.pricePerShare ?? null);

    // Decompose a held position's $ value change into the portion caused by
    // its mark (price-per-share) moving vs. the portion caused by the fund
    // sizing the position up or down — an exact identity, no residual, when
    // both periods report both a share count and a price-per-share:
    //   valueDelta = sharesPrior*(ppsCurrent-ppsPrior) + ppsCurrent*(sharesCurrent-sharesPrior)
    //                \____________ priceEffect ____________/ \_______ shareEffect ________/
    let priceEffectUSD = null;
    let shareEffectUSD = null;
    if (
      status === 'held' &&
      shares.current != null &&
      shares.prior != null &&
      pricePerShare.current != null &&
      pricePerShare.prior != null
    ) {
      priceEffectUSD = shares.prior * (k * pricePerShare.current - pricePerShare.prior);
      shareEffectUSD = pricePerShare.current * (shares.current - shares.prior * k);
    }

    return {
      key,
      splitRatio,
      name: base.name,
      issuer: base.issuer,
      title: base.title,
      instrumentType: base.instrumentType,
      instrumentLabel: base.instrumentLabel,
      country: base.country,
      status,
      shares,
      marketValue,
      pricePerShare,
      pctOfNetAssets,
      priceEffectUSD,
      shareEffectUSD,
    };
  });

  positions.sort((a, b) => {
    const aMax = Math.max(a.marketValue.current || 0, a.marketValue.prior || 0);
    const bMax = Math.max(b.marketValue.current || 0, b.marketValue.prior || 0);
    return bMax - aMax;
  });

  const issuerSet = arr => new Set(arr.map(h => issuerKeyOf(h)));
  const currentIssuerCount = issuerSet(currentHoldings).size;
  const priorIssuerCount = issuerSet(priorHoldings).size;

  const added = positions
    .filter(pos => pos.status === 'new')
    .sort((a, b) => (b.marketValue.current || 0) - (a.marketValue.current || 0));
  const dropped = positions
    .filter(pos => pos.status === 'exited')
    .sort((a, b) => (b.marketValue.prior || 0) - (a.marketValue.prior || 0));
  const held = positions.filter(pos => pos.status === 'held');

  // "Additional investment" / partial-realization signal: held positions
  // whose share count moved. Ranked by the $ effect of that share-count
  // move (falling back to the raw share delta when a price-per-share isn't
  // available on both sides to compute it) so the biggest capital moves
  // surface first, not just the biggest share COUNTS.
  const shareMoveRank = pos => (pos.shareEffectUSD != null ? pos.shareEffectUSD : pos.shares.delta || 0);
  const increased = held.filter(pos => (pos.shares.delta || 0) > 0).sort((a, b) => shareMoveRank(b) - shareMoveRank(a));
  const reduced = held.filter(pos => (pos.shares.delta || 0) < 0).sort((a, b) => shareMoveRank(a) - shareMoveRank(b));

  // Ranked by the DOLLAR impact of the mark move (priceEffectUSD), not raw
  // %  — a warrant re-marked from $0.0001 to $0.01/unit is technically a
  // +9,900,000% move but a few thousand dollars of real impact, and would
  // otherwise bury a $37M, +94.5% mark on a real position under a
  // near-zero-base percentage artifact. $ impact is also what the
  // "Value Δ from Price Marks" aggregate above is built from, so the two
  // stay consistent with each other.
  const withMarkChange = held.filter(pos => pos.priceEffectUSD != null && pos.priceEffectUSD !== 0);
  const topMarkups = withMarkChange
    .filter(pos => pos.priceEffectUSD > 0)
    .sort((a, b) => b.priceEffectUSD - a.priceEffectUSD);
  const topMarkdowns = withMarkChange
    .filter(pos => pos.priceEffectUSD < 0)
    .sort((a, b) => a.priceEffectUSD - b.priceEffectUSD);

  // Aggregate the per-position price/share decomposition above across every
  // held position — "of the $ change in positions we still hold, how much
  // was the fund marking them up/down vs. buying more/selling some down."
  // A held position lacking a price-per-share on one side (decomposition
  // undefined) still contributes its full value delta, just unclassified,
  // so the three buckets always reconcile exactly to the total held-position
  // value change.
  let valueChangeFromPriceUSD = 0;
  let valueChangeFromSharesUSD = 0;
  let valueChangeOtherUSD = 0;
  let decomposedPriorBasis = 0;
  for (const pos of held) {
    if (pos.priceEffectUSD != null && pos.shareEffectUSD != null) {
      valueChangeFromPriceUSD += pos.priceEffectUSD;
      valueChangeFromSharesUSD += pos.shareEffectUSD;
      decomposedPriorBasis += pos.marketValue.prior || 0;
    } else {
      valueChangeOtherUSD += pos.marketValue.delta || 0;
    }
  }
  const pctOfDecomposedBasis = amount =>
    decomposedPriorBasis ? (amount / Math.abs(decomposedPriorBasis)) * 100 : null;

  const INSIGHT_LIMIT = 8;
  const capped = (list, limit = INSIGHT_LIMIT) => ({ items: list.slice(0, limit), total: list.length });

  return {
    current: {
      reportDate: current?.fund?.reportDate || '',
      registrantName: current?.fund?.registrantName || '',
      seriesName: current?.fund?.seriesName || '',
    },
    prior: {
      reportDate: prior?.fund?.reportDate || '',
      registrantName: prior?.fund?.registrantName || '',
      seriesName: prior?.fund?.seriesName || '',
    },
    totals: {
      privateValueUSD: deltaBlock(current?.privateValueUSD ?? 0, prior?.privateValueUSD ?? 0),
      privateHoldingsCount: deltaBlock(currentHoldings.length, priorHoldings.length),
      issuerCount: deltaBlock(currentIssuerCount, priorIssuerCount),
      newCount: added.length,
      exitedCount: dropped.length,
      continuingCount: held.length,
      valueChangeFromPrice: { amount: valueChangeFromPriceUSD, pct: pctOfDecomposedBasis(valueChangeFromPriceUSD) },
      valueChangeFromShares: { amount: valueChangeFromSharesUSD, pct: pctOfDecomposedBasis(valueChangeFromSharesUSD) },
      valueChangeOther: { amount: valueChangeOtherUSD },
    },
    positions,
    insights: {
      added: capped(added),
      dropped: capped(dropped),
      increased: capped(increased),
      reduced: capped(reduced),
      topMarkups: capped(topMarkups),
      topMarkdowns: capped(topMarkdowns),
    },
  };
}

// ── Mark-implied returns (lot accounting across a fund's filings) ────────────
// NPORT-P never discloses cost basis or purchase price — only fair value and
// unit count per period. So cost here is a PROXY: each lot is costed at the
// fund's own mark on the period it first shows up (entry) or grows (add-on).
// A share-count decrease is a partial realization at the current mark (average
// cost removed), never a loss. Positions present in the OLDEST filing supplied
// have unknown true entry, so they're flagged entryIsWindowStart and their
// MOIC/IRR is measured from that window start, not from the real purchase.

function xirr(flows) {
  const fl = flows.filter(f => Number.isFinite(f.t) && Number.isFinite(f.amount) && f.amount !== 0);
  if (fl.length < 2) return null;
  const hasNeg = fl.some(f => f.amount < 0);
  const hasPos = fl.some(f => f.amount > 0);
  if (!hasNeg || !hasPos) return null;
  const t0 = Math.min(...fl.map(f => f.t));
  const span = (Math.max(...fl.map(f => f.t)) - t0) / 86400000;
  if (span < 30) return null;
  const npv = r => fl.reduce((s, f) => s + f.amount / Math.pow(1 + r, (f.t - t0) / (365 * 86400000)), 0);
  let lo = -0.99;
  let hi = 10;
  if (npv(lo) * npv(hi) > 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (npv(lo) * npv(mid) <= 0) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

// `periods`: [{ reportDate, xray }] for ONE fund, any order (sorted here).
function buildPositionReturns(periods) {
  const sorted = [...periods]
    .filter(p => p && p.xray)
    .sort((a, b) => String(a.reportDate).localeCompare(String(b.reportDate)));
  const dateOf = p => Date.parse(p.reportDate);

  const all = []; // every position ever created (some later merged away)
  let open = []; // positions currently held as of the last processed period

  const newPos = (h, date, dateStr, windowStart) => {
    const usable = h.shares > 0 && h.pricePerShare != null && h.pricePerShare > 0;
    const cost = usable ? h.shares * h.pricePerShare : h.marketValue || 0;
    const pos = {
      name: h.name,
      issuer: h.issuer,
      title: h.title,
      instrumentLabel: h.instrumentLabel,
      shares: h.shares,
      cost,
      invested: cost,
      realized: 0,
      flows: [{ t: date, amount: -cost }],
      lots: [{ date: dateStr, shares: h.shares, pricePerShare: h.pricePerShare, cost, kind: 'entry' }],
      events: [],
      status: 'open',
      firstDate: dateStr,
      lastDate: dateStr,
      entryIsWindowStart: windowStart,
      lotsUnavailable: !usable,
      chainedFrom: null,
      lastHolding: h,
      currentValue: h.marketValue || 0,
    };
    all.push(pos);
    return pos;
  };

  sorted.forEach((period, idx) => {
    const holdings = period.xray.privateHoldings || [];
    const date = dateOf(period);
    const dateStr = period.reportDate;

    if (idx === 0) {
      open = holdings.map(h => newPos(h, date, dateStr, true));
      return;
    }

    const priorHoldings = open.map(p => p.lastHolding);
    const posByHolding = new Map(open.map(p => [p.lastHolding, p]));
    const pairs = matchFundXRayPositions(holdings, priorHoldings);

    const nextOpen = [];
    const exited = [];
    const born = [];

    for (const { current: c, prior: pr } of pairs) {
      if (c && pr) {
        const pos = posByHolding.get(pr);
        pos.lastDate = dateStr;
        pos.currentValue = c.marketValue || 0;
        const canLot = pos.shares > 0 && c.shares > 0 && c.pricePerShare != null && c.pricePerShare > 0;
        const split = detectSplit(pos.lastHolding, c);
        if (split && !pos.lotsUnavailable) {
          // Units rescaled at ~constant value: no capital moved. Restate the
          // lots' units so later partial sales use the right proportions.
          pos.lots = pos.lots.map(l => ({
            ...l,
            shares: l.shares * split,
            pricePerShare: l.pricePerShare == null ? null : l.pricePerShare / split,
          }));
          pos.events.push({ date: dateStr, type: 'split', ratio: split });
          pos.shares = c.shares;
        } else if (canLot && !pos.lotsUnavailable) {
          const delta = c.shares - pos.shares;
          if (Math.abs(delta) / pos.shares > 1e-9) {
            if (delta > 0) {
              const cost = delta * c.pricePerShare;
              pos.cost += cost;
              pos.invested += cost;
              pos.flows.push({ t: date, amount: -cost });
              pos.lots.push({ date: dateStr, shares: delta, pricePerShare: c.pricePerShare, cost, kind: 'addon' });
              pos.events.push({ date: dateStr, type: 'addon', shares: delta, usd: cost });
            } else {
              const reduced = -delta;
              const costRemoved = pos.cost * (reduced / pos.shares);
              const proceeds = reduced * c.pricePerShare;
              pos.cost -= costRemoved;
              pos.realized += proceeds;
              pos.flows.push({ t: date, amount: proceeds });
              pos.events.push({ date: dateStr, type: 'partial_realization', shares: reduced, usd: proceeds });
            }
          }
          pos.shares = c.shares;
        } else {
          pos.lotsUnavailable = true;
        }
        pos.lastHolding = c;
        nextOpen.push(pos);
      } else if (c) {
        const pos = newPos(c, date, dateStr, false);
        born.push(pos);
        nextOpen.push(pos);
      } else {
        const pos = posByHolding.get(pr);
        const proceeds = pr.marketValue || 0;
        pos.realized += proceeds;
        pos.flows.push({ t: date, amount: proceeds });
        pos.events.push({ date: dateStr, type: 'left_private_book', usd: proceeds });
        pos.status = 'exited';
        pos.currentValue = 0;
        pos.lastDate = dateStr;
        pos.costAtExit = pos.cost;
        pos.cost = 0;
        pos.shares = 0;
        exited.push(pos);
      }
    }

    // Conversion chaining: one instrument leaving the private book while a new
    // one of the SAME issuer appears in the same step is most likely a
    // conversion / reclassification, not a real sale + fresh purchase. Merge
    // the lineage so the exit isn't booked as a realization.
    const issuerKey = p => issuerKeyOf(p);
    for (const ex of exited) {
      const targets = born.filter(b => issuerKey(b) === issuerKey(ex) && !b.chainedFrom);
      if (!targets.length) continue;
      const totalValue = targets.reduce((sum, b) => sum + (b.currentValue || 0), 0) || 1;
      // Undo the realization booked in the exit branch — it wasn't a sale.
      const undo = ex.events.pop();
      ex.realized -= undo.usd;
      ex.flows.pop();
      ex.status = 'converted';
      ex.mergedAway = true;
      for (const b of targets) {
        const share = (b.currentValue || 0) / totalValue;
        // Strip the fresh entry lot newPos booked: converted value isn't new capital.
        const fresh = b.lots.shift();
        b.invested -= fresh.cost;
        b.flows.shift();
        b.chainedFrom = ex.title;
        b.entryIsWindowStart = ex.entryIsWindowStart;
        b.firstDate = ex.firstDate;
        b.invested += ex.invested * share;
        b.realized += ex.realized * share;
        b.cost = ex.costAtExit * share;
        b.lotsUnavailable = b.lotsUnavailable || ex.lotsUnavailable;
        b.lots = ex.lots.map(l => ({ ...l, cost: l.cost * share, shares: l.shares * share })).concat(b.lots);
        b.flows = ex.flows.map(f => ({ ...f, amount: f.amount * share })).concat(b.flows);
        b.events = ex.events
          .map(e => ({ ...e }))
          .concat([{ date: dateStr, type: 'conversion_chained', from: ex.title }], b.events);
      }
    }

    open = nextOpen;
  });

  const lastDate = sorted.length ? dateOf(sorted[sorted.length - 1]) : NaN;
  const positions = all
    .filter(p => !p.mergedAway)
    .map(p => {
      const currentValue = p.status === 'open' ? p.currentValue : 0;
      const flows = p.flows.map(f => ({ ...f }));
      if (currentValue > 0) flows.push({ t: lastDate, amount: currentValue });
      const moic = p.invested > 0 ? (p.realized + currentValue) / p.invested : null;
      const irr = xirr(flows);
      return {
        name: p.name,
        issuer: p.issuer,
        title: p.title,
        instrumentLabel: p.instrumentLabel,
        status: p.status,
        firstDate: p.firstDate,
        lastDate: p.lastDate,
        entryIsWindowStart: p.entryIsWindowStart,
        lotsUnavailable: p.lotsUnavailable,
        chainedFrom: p.chainedFrom,
        invested: p.invested,
        realized: p.realized,
        costBasis: p.status === 'open' ? p.cost : 0,
        currentValue,
        moic,
        irr,
        lots: p.lots,
        events: p.events,
        _flows: flows,
      };
    })
    .sort((a, b) => b.invested - a.invested);

  const usable = positions.filter(p => !p.lotsUnavailable && p.invested > 0);
  const sumEvents = (list, type) =>
    list.reduce((sum, p) => sum + p.events.filter(e => e.type === type).reduce((s2, e) => s2 + (e.usd || 0), 0), 0);
  const invested = usable.reduce((s, p) => s + p.invested, 0);
  const realized = usable.reduce((s, p) => s + p.realized, 0);
  const currentValue = usable.reduce((s, p) => s + p.currentValue, 0);
  const summary = {
    positionCount: usable.length,
    invested,
    realized,
    currentValue,
    moic: invested > 0 ? (realized + currentValue) / invested : null,
    irr: xirr(usable.flatMap(p => p._flows)),
    partialSales: sumEvents(usable, 'partial_realization'),
    leftPrivateBook: sumEvents(usable, 'left_private_book'),
    windowStartCount: usable.filter(p => p.entryIsWindowStart).length,
    excludedCount: positions.length - usable.length,
    firstDate: sorted[0]?.reportDate || '',
    lastDate: sorted[sorted.length - 1]?.reportDate || '',
    periodCount: sorted.length,
  };
  positions.forEach(p => delete p._flows);
  return { positions, summary };
}

// ── Private Credit helpers ─────────────────────────────────────────────────

function parseFinancialNumber(str) {
  if (str == null) return null;
  const s = String(str)
    .replace(/[$,\s]/g, '')
    .trim();
  if (!s || s === '—' || s === '-' || s === '–') return null;
  const neg = s.startsWith('(') && s.endsWith(')');
  const n = parseFloat(neg ? '-' + s.slice(1, -1) : s);
  return isNaN(n) ? null : n;
}

function getRowCells($, row, expandColspan) {
  const cells = [];
  $(row)
    .find('td, th')
    .each((_, cell) => {
      const text = $(cell).text().replace(/\s+/g, ' ').trim();
      if (expandColspan) {
        const colspan = parseInt($(cell).attr('colspan') || '1');
        for (let i = 0; i < colspan; i++) cells.push(text);
      } else {
        cells.push(text);
      }
    });
  return cells;
}

function tryBuildCreditColumnMap(cells) {
  const map = {};
  // Header wording checked against ~55 real BDC 10-Qs (Blue Owl, Blackstone,
  // Oaktree, KKR/FS, Ares, HPS, Apollo, Golub-style, OHA, Carlyle, Franklin,
  // BlackRock TCP, Main Street, ...) — e.g. the company column is called
  // "Portfolio Company", "Company", "Investments-non-controlled/non-affiliated",
  // "Issuer" or "Industry/Company"; principal is "Principal", "Par / Units",
  // "Par Amount/ Shares", "Par ($) / Shares" or "Principal Amount, Par Value or
  // Shares"; cost is "Cost" or "Cost/Amortized Cost".
  const MATCHERS = [
    [
      'portfolioCompany',
      c =>
        c.includes('portfolio company') ||
        c === 'company' ||
        c.startsWith('company ') ||
        c.endsWith('/company') ||
        c === 'portfolio' ||
        c === 'issuer' ||
        c.startsWith('issuer ') ||
        c.startsWith('investments'),
    ],
    ['industry', c => c.startsWith('industry') && !c.endsWith('company')],
    [
      'investmentType',
      c =>
        c.includes('type of investment') ||
        c.includes('investment type') ||
        c.includes('facility type') ||
        c === 'investment' ||
        c === 'instrument' ||
        c === 'type' ||
        c.startsWith('security') ||
        (c.includes('type') && c.includes('invest')),
    ],
    ['index', c => c === 'index' || c.startsWith('index ')],
    ['spread', c => c.startsWith('spread')],
    // "Reference Rate and Spread" holds both in one cell ("SOFR + 4.50%").
    ['refRateAndSpread', c => c.includes('reference rate and spread') || c.includes('ref rate and spread')],
    [
      'cashInterestRate',
      c =>
        c.includes('cash interest') ||
        c.startsWith('all in rate') ||
        c.startsWith('total coupon') ||
        c.startsWith('total rate') ||
        (c.includes('interest rate') && !c.includes('pik')) ||
        c === 'interest' ||
        c.startsWith('current rate') ||
        c.startsWith('rate ('),
    ],
    ['pik', c => c === 'pik' || c.startsWith('pik ')],
    ['maturityDate', c => c.includes('maturity')],
    ['shares', c => c.startsWith('shares') || c.startsWith('units/shares') || c === 'units'],
    [
      'principal',
      c => c.includes('principal') || c.startsWith('par') || c.includes('fundedpar') || c.includes('funded par'),
    ],
    ['cost', c => c === 'cost' || c.startsWith('cost') || c.startsWith('amortized cost')],
    ['fairValue', c => c.includes('fair value')],
    // Cleaning strips the "%" sign, so "% of Net Assets" arrives as "of net assets".
    ['pctNetAssets', c => c.startsWith('percent') || /^of (net assets|member|total|portfolio|capital)/.test(c)],
    ['notes', c => c.startsWith('note') || c.startsWith('footnote')],
  ];

  cells.forEach((raw, i) => {
    // Strip footnote references like (1)(2)(3) and normalize
    const c = raw
      .toLowerCase()
      .replace(/\([^)]*\)/g, '')
      .replace(/[^a-z0-9 /]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    for (const [field, matcher] of MATCHERS) {
      if (map[field] !== undefined) continue;
      if (matcher(c)) {
        map[field] = i;
      }
    }
  });

  // Must have at least fair value and (principal or cost)
  if (map.fairValue === undefined) return null;
  if (map.principal === undefined && map.cost === undefined) return null;
  return map;
}

// Get a cell value, skipping standalone currency-symbol cells ($, £, etc.)
function getCreditCell(cells, idx) {
  if (idx === undefined || idx === null || idx >= cells.length) return '';
  const raw = (cells[idx] || '').trim();
  // If just a currency symbol, look one position ahead for the actual value
  if (/^[$£€¥₩]$|^[A-Z]{1,3}\$$/.test(raw)) {
    return (cells[idx + 1] || '').trim();
  }
  return raw;
}

// Pattern-based extraction of rate/date fields from non-expanded cells.
// Handles filings where the header uses a single wide "Rate" cell (e.g. colspan=15)
// rather than separate Index / Spread / PIK / Maturity header cells.
function extractRateFieldsFromCells(rawCells) {
  const result = { index: '', spread: '', pik: '', maturityDate: '', cashInterestRate: '' };
  const cleanPcts = []; // standalone percentages like "4.8%"

  for (const cell of rawCells) {
    const c = cell.trim();
    if (!c || c === '+' || c === '-' || c === '—' || c === '–') continue;

    // Floating rate benchmark names
    if (!result.index && /^(SF|SOFR|L|LIBOR|EURIBOR|SONIA|PRIME|AMERIBOR|BASE RATE)$/i.test(c)) {
      result.index = c.toUpperCase();
    }

    // Standalone percentage (e.g. "4.8%") — not embedded in longer text
    if (/^\d+\.?\d*%$/.test(c)) {
      cleanPcts.push(c);
    }

    // Maturity date: MM/YY or MM/YYYY
    if (!result.maturityDate && /^\d{1,2}\/\d{2,4}$/.test(c)) {
      result.maturityDate = c;
    }
  }

  // A bare second percentage on a floating-rate row is genuinely ambiguous
  // without column headers to disambiguate — it's just as likely to be a
  // floor rate or an all-in rate as a PIK component. Require the same
  // explicit "PIK" text marker the fixed-rate branch below already needs,
  // rather than guessing from position alone: an omitted field is safer
  // than a fabricated one.
  const explicitPikPct = () => {
    for (const cell of rawCells) {
      const cl = cell.toLowerCase();
      if (cl.includes('pik') && /\d+\.?\d*%/.test(cl)) {
        const m = cl.match(/(\d+\.?\d*)%/);
        if (m) return m[1] + '%';
      }
    }
    return '';
  };

  if (result.index) {
    // Floating rate: first bare pct = spread; PIK only if explicitly marked.
    if (cleanPcts.length >= 1) result.spread = cleanPcts[0];
    result.pik = explicitPikPct();
  } else {
    // Fixed / no-index: first pct = cash interest rate
    if (cleanPcts.length >= 1) result.cashInterestRate = cleanPcts[0];
    // PIK embedded in cell text like "(3.0% PIK)"
    result.pik = explicitPikPct();
  }

  return result;
}

// Reads a row's money figures in order (from the NON-expanded cells — the
// colspan-expanded ones repeat each value once per spanned column) when header indexes don't line up with
// the data cells (iXBRL tables put "$" and figures in separate cells, so a
// header at index 14 can sit over a data cell at index 11). Percentages, dates
// and footnote markers are not figures. The "% of Net Assets" column is counted
// in the header order because many filings print it as a bare number ("0.03")
// with the "%" in its own cell — without accounting for it, that number is read
// as the fair value.
function sequentialFigures(cells, colMap) {
  if (colMap.fairValue === undefined) return null;
  const hasPct = colMap.pctNetAssets !== undefined;
  const fields = ['principal', 'cost', 'fairValue']
    .filter(f => colMap[f] !== undefined)
    .sort((a, b) => colMap[a] - colMap[b]);
  if (fields.length < 2) return null;
  const figure = /^\(?[$£€]?\s*\(?-?[\d,]+(?:\.\d+)?\)?$|^[—–-]$/;
  const nums = cells
    .map(c => String(c).replace(/\s+/g, ''))
    .filter(t => t && !t.includes('/') && !t.endsWith('%') && !/^\(\d{1,2}\)$/.test(t) && figure.test(t))
    .map(parseFinancialNumber);

  // The "% of Net Assets" figure is the last one when printed as a bare number
  // ("0.51", % in its own cell) and absent from the list when printed "8.6%".
  // Try with it first, then without; take the first reading where par and cost
  // are the same order of magnitude, as they are for any loan.
  const candidates = [];
  if (hasPct) candidates.push(fields.length + 1);
  candidates.push(fields.length);
  for (const n of candidates) {
    if (nums.length < n) continue;
    const picked = nums.slice(nums.length - n);
    const out = {};
    fields.forEach((f, i) => (out[f] = picked[i]));
    if (n > fields.length && !(picked[n - 1] === null || (picked[n - 1] >= -1000 && picked[n - 1] <= 1000))) continue;
    const { principal: p, cost: c } = out;
    if (p > 0 && c > 0 && (c / p < 0.25 || c / p > 2)) continue;
    return out;
  }
  return null;
}

function extractCreditHoldings($, issuerSearchTerm, reportDate) {
  const holdings = [];
  const searchLower = issuerSearchTerm.toLowerCase();
  let lastGoodColMap = null; // carry forward into continuation tables

  $('table').each((_, tableEl) => {
    const $table = $(tableEl);
    const allRows = $table.find('tr').toArray();
    if (allRows.length < 2) return;

    let colMap = null;
    let headerRowIdx = -1;

    // Search for a header row using colspan-expanded cells
    for (let i = 0; i < Math.min(allRows.length, 15); i++) {
      const cells = getRowCells($, allRows[i], true);
      const map = tryBuildCreditColumnMap(cells);
      if (map) {
        colMap = map;
        headerRowIdx = i;
        break;
      }
    }

    // Continuation tables (page 2+ of schedule) have no header — reuse last map
    if (!colMap && lastGoodColMap) {
      colMap = lastGoodColMap;
      headerRowIdx = -1;
    }

    if (!colMap) return;
    lastGoodColMap = colMap;

    let currentCompany = '';
    let currentIndustry = '';

    for (let i = headerRowIdx + 1; i < allRows.length; i++) {
      // Expanded cells for colMap-based financial extraction
      const cells = getRowCells($, allRows[i], true);
      // Non-expanded cells for pattern-based rate/date extraction
      const rawCells = getRowCells($, allRows[i], false);
      if (cells.length < 5) continue;

      // Carry forward company and industry (BDC tables blank repeated cells).
      // Require an actual letter (not just length > 2) so a real short name
      // like "AI" or "3M" isn't mistaken for a blank/footnote-marker cell
      // (e.g. a bare "1", "(1)", "*") and silently dropped into whatever the
      // previous row's company was.
      const rawCompany = getCreditCell(cells, colMap.portfolioCompany);
      const rawIndustry = getCreditCell(cells, colMap.industry);
      if (/[A-Za-z]/.test(rawCompany) && rawCompany !== '—' && rawCompany !== '-') {
        currentCompany = rawCompany;
      }
      if (/[A-Za-z]/.test(rawIndustry) && rawIndustry !== '—' && rawIndustry !== '-') {
        currentIndustry = rawIndustry;
      }

      if (!currentCompany.toLowerCase().includes(searchLower)) continue;

      let principal = parseFinancialNumber(getCreditCell(cells, colMap.principal));
      let fairValue = parseFinancialNumber(getCreditCell(cells, colMap.fairValue));
      let cost = parseFinancialNumber(getCreditCell(cells, colMap.cost));
      if (fairValue === null || cost === null) {
        // Header and data cells can carry different colspans (real cases: AGL
        // Private Credit Income Fund, Onex, Apollo Debt Solutions, Blue Owl
        // Technology Finance), so the header's column index lands on an empty
        // cell. Read the row's figures in order instead.
        const seq = sequentialFigures(rawCells, colMap);
        if (seq && seq.fairValue !== null && seq.fairValue !== undefined) {
          principal = seq.principal ?? principal;
          cost = seq.cost ?? cost;
          fairValue = seq.fairValue;
        }
      }
      if (principal === null && fairValue === null) continue;

      const investmentTypeCell = getCreditCell(cells, colMap.investmentType);
      const maturityCell = getCreditCell(cells, colMap.maturityDate);
      // A company's own total row (no instrument, maturity, rate or par) repeats
      // the sum of its tranches; an unfunded commitment (no par, zero/negative
      // cost) is not a funded position. Neither is a holding.
      const hasTerms =
        investmentTypeCell ||
        maturityCell ||
        getCreditCell(cells, colMap.cashInterestRate) ||
        getCreditCell(cells, colMap.refRateAndSpread);
      if (!hasTerms) continue;
      if ((principal === null || principal === 0) && (cost === null || cost <= 0)) continue;
      // A negative fair value with no par is the value of an unfunded commitment
      // (real: a $12.6M delayed-draw commitment at -$253K), never a position.
      if (fairValue !== null && fairValue < 0) continue;

      // fair value / par is only a mark when par is money. Where the "par"
      // column actually holds units (equity, warrants), cost is nowhere near
      // par — real cases showed "marks" of 20% and 0.0% from that mismatch.
      const parIsMoney =
        principal && principal > 0 && cost !== null && cost > 0
          ? cost / principal >= 0.4 && cost / principal <= 1.6
          : principal > 0;
      // Nothing marked above ~150% of par or below zero is a real mark — that
      // is a units/shares column or a misread cell, so show no mark instead.
      const rawMark = parIsMoney && fairValue !== null ? (fairValue / principal) * 100 : null;
      const fairValueMark = rawMark !== null && rawMark >= 0 && rawMark <= 150 ? rawMark : null;

      // Rate fields: colMap first, fall back to pattern scan of raw cells. The
      // "% of Net Assets" cell is dropped from that scan — on real filings it
      // was read as the loan's cash interest rate (e.g. "7.1%").
      const pctText = getCreditCell(cells, colMap.pctNetAssets).trim();
      const rf = extractRateFieldsFromCells(pctText ? rawCells.filter(c => c.trim() !== pctText) : rawCells);
      let index = getCreditCell(cells, colMap.index);
      let spread = getCreditCell(cells, colMap.spread);
      // "Reference Rate and Spread" columns hold both in one cell, e.g. "SOFR + 4.50%".
      const combined = getCreditCell(cells, colMap.refRateAndSpread);
      if (combined && (!index || !spread)) {
        const m = combined.match(/^\s*([A-Za-z]+)?(?:\s*\([A-Za-z]\))?\s*\+\s*(\d+\.?\d*%)/);
        if (m) {
          index = index || (m[1] || '').toUpperCase();
          spread = spread || m[2];
        }
      }
      index = index || rf.index;
      spread = spread || rf.spread;
      const pik = getCreditCell(cells, colMap.pik) || rf.pik;
      const cashInterestRate = getCreditCell(cells, colMap.cashInterestRate) || rf.cashInterestRate;
      const maturityDate = getCreditCell(cells, colMap.maturityDate) || rf.maturityDate;
      const investmentType = getCreditCell(cells, colMap.investmentType);

      holdings.push({
        reportDate,
        portfolioCompany: currentCompany,
        industry: rawIndustry.length > 2 ? rawIndustry : currentIndustry,
        investmentType,
        index,
        spread,
        cashInterestRate,
        pik,
        maturityDate,
        shares: getCreditCell(cells, colMap.shares),
        principal,
        cost,
        fairValue,
        fairValueMark,
        notes: getCreditCell(cells, colMap.notes),
      });
    }
  });

  return holdings;
}

module.exports = {
  sequentialFigures,
  tryBuildCreditColumnMap,
  getRowCells,
  extractIdString,
  extractHoldings,
  parseFinancialNumber,
  extractCreditHoldings,
  classifyInstrument,
  parseEquityLabel,
  parseDebtLabel,
  isPrivateHolding,
  isPrivateEquityHolding,
  extractFundMeta,
  extractAllHoldings,
  nportInvestments,
  buildFundXRay,
  positionMatchKey,
  instrumentKeyOf,
  buildFundXRayComparison,
  buildIssuerCapitalStructure,
  issuerKeyOf,
  parseDebtTerms,
  xirr,
  buildPositionReturns,
};
