// Turns one NPORT-P primary_doc.xml into warehouse rows, using the app's own
// parser (extractAllHoldings / extractFundMeta / classifyInstrument) and the
// same keep rule as the bulk ingest (isPrivateCandidate), so a filing loaded
// from EDGAR is stored exactly as the SEC bulk dataset would store it.
// Checked row-for-row against bulk rows in test/warehouse-delta.test.js.
const xml2js = require('xml2js');
const { extractAllHoldings, extractFundMeta, extractIdString, nportInvestments } = require('../../parsers');
const { isPrivateCandidate } = require('./keep-rule');
const { isValidIsin, fundKeyOf } = require('./identifiers');
const { text, num } = require('./values');
const { totalsCollector } = require('./filing-totals');
const { anchorCollector } = require('./capital-structure');

// Same options as the server's NPORT parsing.
function parseNportXml(xmlText) {
  return new xml2js.Parser({
    explicitArray: false,
    mergeAttrs: true,
    normalizeTags: true,
    tagNameProcessors: [xml2js.processors.stripPrefix],
  }).parseStringPromise(xmlText);
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

// Filing + private-candidate holdings + capital-structure debt rows + totals over
// all rows, for one parsed filing.
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
  const debtRows = []; // dropped debt rows, kept below if their issuer is held privately
  const totals = totalsCollector();
  const anchors = anchorCollector();
  totals.touch(index.accession);
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
      ISSUER_NAME: inv.name,
      ISSUER_TITLE: inv.title,
    };
    totals.add(index.accession, bulkShaped, isValidIsin(isin), h.instrumentType);
    const kept = isPrivateCandidate(bulkShaped, isValidIsin(isin));
    if (!kept && h.instrumentType !== 'debt') continue;
    const currency = inv.curcd || inv.curCd || (inv.currencyconditional || inv.currencyConditional)?.curCd;
    const issuerConditional = inv.issuerconditional || inv.issuerConditional;
    const row = {
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
    };
    if (kept) {
      anchors.add(index.accession, bulkShaped, h.instrumentType);
      holdings.push(row);
    } else debtRows.push({ bulkShaped, row });
  }
  const capital = [];
  for (const { bulkShaped, row } of debtRows) {
    const key = anchors.capitalKey(index.accession, bulkShaped, row.instrument_type);
    if (key) capital.push({ issuer_key: key, ...row });
  }
  totals.get(index.accession).rows_capital = capital.length;
  return { filing, holdings, capital, totals: totals.get(index.accession), rowsRead: investments.length };
}

module.exports = { parseNportXml, warehouseRowsFromXml };
