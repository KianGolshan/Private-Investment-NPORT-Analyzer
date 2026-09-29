// Turns one NPORT-P primary_doc.xml into warehouse rows, using the app's own
// parser (extractAllHoldings / extractFundMeta / classifyInstrument) and the
// same keep rule as the bulk ingest (isPrivateCandidate), so a filing loaded
// from EDGAR is stored exactly as the SEC bulk dataset would store it.
// Checked row-for-row against bulk rows in test/warehouse-delta.test.js.
const xml2js = require('xml2js');
const { extractAllHoldings, extractFundMeta, extractIdString, nportInvestments } = require('../../parsers');
const { isPrivateCandidate } = require('./bulk-ingest');
const { isValidIsin, fundKeyOf } = require('./identifiers');

// Same options as the server's NPORT parsing.
function parseNportXml(text) {
  return new xml2js.Parser({
    explicitArray: false,
    mergeAttrs: true,
    normalizeTags: true,
    tagNameProcessors: [xml2js.processors.stripPrefix],
  }).parseStringPromise(text);
}

// Placeholder text ("N/A", "", "NONE") -> null, as in the bulk ingest.
function text(value) {
  if (value === null || value === undefined || typeof value === 'object') return null;
  const t = String(value).trim();
  return !t || /^(N\/?A|NONE|NULL|NIL|-+)$/i.test(t) ? null : t;
}

function num(value) {
  const n = Number(value);
  return value === null || value === undefined || String(value).trim() === '' || !Number.isFinite(n) ? null : n;
}

const first = v => (Array.isArray(v) ? v[0] : v);

function derivativeCat(inv) {
  const info = inv.derivativeinfo || inv.derivativeInfo;
  if (!info) return '';
  for (const child of Object.values(info)) {
    const cat = first(child)?.derivCat || first(child)?.derivcat;
    if (cat) return String(cat).trim().toUpperCase();
  }
  return '';
}

// Filing + private-candidate holdings for one parsed filing.
// `index` is the EDGAR index entry: { accession, cik, filingDate, form }.
function warehouseRowsFromXml(xml, index) {
  const meta = extractFundMeta(xml);
  const cik = String(index.cik || '').replace(/^0+/, '') || null;
  const seriesId = text(meta.seriesId);
  const filing = {
    accession: index.accession,
    fund_key: fundKeyOf(seriesId, cik),
    cik,
    series_id: seriesId,
    registrant: text(meta.registrantName),
    series_name: text(meta.seriesName),
    series_lei: text(meta.seriesLei),
    registrant_lei: text(meta.registrantLei),
    report_date: text(meta.reportDate),
    filing_date: index.filingDate,
    form: index.form,
    net_assets: num(meta.netAssets),
    total_assets: num(meta.totalAssets),
    source: 'edgar',
  };

  const investments = nportInvestments(xml);
  const holdings = [];
  for (const h of extractAllHoldings(xml)) {
    const inv = investments[h.rowIndex];
    const conditional = inv.assetconditional || inv.assetConditional;
    const assetCat = String(inv.assetcat || inv.assetCat || conditional?.assetCat || conditional?.assetcat || '')
      .trim()
      .toUpperCase();
    const derivCat = derivativeCat(inv);
    const isin = extractIdString(first(inv.identifiers?.isin));
    const other = first(inv.identifiers?.other);
    // The bulk dataset's field names, so the one keep rule decides both paths.
    const bulkShaped = {
      ASSET_CAT: assetCat,
      DERIVATIVE_CAT: derivCat,
      FAIR_VALUE_LEVEL: h.fairValLevel,
      IS_RESTRICTED_SECURITY: h.isRestrictedSec,
      ISSUER_CUSIP: h.cusip,
      BALANCE: inv.balance,
      CURRENCY_VALUE: inv.valusd ?? inv.valUSD,
    };
    if (!isPrivateCandidate(bulkShaped, isValidIsin(isin))) continue;
    const currency = inv.curcd || inv.curCd || (inv.currencyconditional || inv.currencyConditional)?.curCd;
    const issuerConditional = inv.issuerconditional || inv.issuerConditional;
    holdings.push({
      accession: index.accession,
      row_key: `doc:${h.rowIndex}`,
      issuer_name: text(inv.name),
      title: text(inv.title),
      cusip: text(h.cusip),
      lei: text(inv.lei),
      isin: text(isin),
      ticker: text(h.ticker),
      other_id: text(h.filerId),
      other_id_desc: text(other?.otherDesc),
      balance: num(h.shares),
      unit: text(inv.units),
      currency: text(currency),
      value_usd: num(h.marketValue),
      pct_nav: num(inv.pctval ?? inv.pctVal),
      asset_cat: text(assetCat),
      other_asset: text(conditional?.desc),
      issuer_type: text(inv.issuercat || inv.issuerCat || issuerConditional?.issuerCat),
      country: text(h.country),
      restricted: text(h.isRestrictedSec),
      fv_level: text(h.fairValLevel),
      deriv_cat: text(derivCat),
      instrument_type: h.instrumentType,
    });
  }
  return { filing, holdings, rowsRead: investments.length };
}

module.exports = { parseNportXml, warehouseRowsFromXml };
